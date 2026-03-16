"""
POST /api/v1/auth/register         — create account (email + password)
POST /api/v1/auth/login            — return JWT
GET  /api/v1/auth/me               — current user info
GET  /api/v1/auth/google           — redirect to Google OAuth consent screen
GET  /api/v1/auth/google/callback  — Google OAuth callback → issue JWT
GET  /api/v1/auth/kakao            — redirect to Kakao OAuth consent screen
GET  /api/v1/auth/kakao/callback   — Kakao OAuth callback → issue JWT
"""
import urllib.parse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user
from app.models.credit_transaction import CreditTransaction, CreditType
from app.models.user import User
from app.schemas.auth import TokenResponse, UserLoginRequest, UserRegisterRequest, UserResponse
from app.services.auth import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["Auth"])

# ── OAuth provider URLs ───────────────────────────────────────────────────────
_GOOGLE_AUTH_URL  = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_USERINFO  = "https://www.googleapis.com/oauth2/v3/userinfo"

_KAKAO_AUTH_URL  = "https://kauth.kakao.com/oauth/authorize"
_KAKAO_TOKEN_URL = "https://kauth.kakao.com/oauth/token"
_KAKAO_USERINFO  = "https://kapi.kakao.com/v2/user/me"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _backend_callback_url(request: Request, provider: str) -> str:
    """Build the OAuth redirect_uri pointing back at this server."""
    return str(request.base_url).rstrip("/") + f"/api/v1/auth/{provider}/callback"


def _find_or_create_oauth_user(
    db: Session,
    provider: str,
    oauth_id: str,
    email: str,
    name: str,
) -> User:
    """
    Return existing user matched by OAuth credentials.
    If the email already exists under a different provider, link OAuth to it.
    Otherwise create a new account with the welcome-credit bonus.
    """
    # 1. Exact match — same provider + same OAuth ID
    user = (
        db.query(User)
        .filter(User.oauth_provider == provider, User.oauth_id == oauth_id)
        .first()
    )
    if user:
        return user

    # 2. Email match — link OAuth to the existing account
    user = db.query(User).filter(User.email == email).first()
    if user:
        user.oauth_provider = provider
        user.oauth_id = oauth_id
        db.commit()
        db.refresh(user)
        return user

    # 3. Entirely new user — create + welcome bonus
    user = User(
        email=email,
        hashed_password=None,  # no local password for OAuth-only accounts
        name=name,
        credit_balance=settings.DEFAULT_CREDIT_BALANCE,
        oauth_provider=provider,
        oauth_id=oauth_id,
    )
    db.add(user)
    db.flush()

    tx = CreditTransaction(
        user_id=user.id,
        amount=settings.DEFAULT_CREDIT_BALANCE,
        type=CreditType.bonus,
        description=f"가입 환영 크레딧 {settings.DEFAULT_CREDIT_BALANCE}개",
    )
    db.add(tx)
    db.commit()
    db.refresh(user)
    return user


def _redirect_to_frontend(token: str = "", error: str = "") -> RedirectResponse:
    """Redirect browser to the SPA's /auth/callback page with token or error."""
    if error:
        qs = urllib.parse.urlencode({"error": error})
    else:
        qs = urllib.parse.urlencode({"token": token})
    return RedirectResponse(url=f"{settings.FRONTEND_URL}/auth/callback?{qs}")


# ── Email / Password ──────────────────────────────────────────────────────────

@router.post(
    "/register",
    response_model=TokenResponse,
    status_code=status.HTTP_201_CREATED,
    summary="회원가입",
)
def register(body: UserRegisterRequest, db: Session = Depends(get_db)):
    """Create a new account and return a JWT. New users receive DEFAULT_CREDIT_BALANCE credits."""
    if db.query(User).filter(User.email == body.email).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"message": "이미 사용 중인 이메일입니다.", "code": "EMAIL_TAKEN"},
        )

    user = User(
        email=body.email,
        hashed_password=hash_password(body.password),
        name=body.name,
        credit_balance=settings.DEFAULT_CREDIT_BALANCE,
    )
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"message": "이미 사용 중인 이메일입니다.", "code": "EMAIL_TAKEN"},
        )

    tx = CreditTransaction(
        user_id=user.id,
        amount=settings.DEFAULT_CREDIT_BALANCE,
        type=CreditType.bonus,
        description=f"가입 환영 크레딧 {settings.DEFAULT_CREDIT_BALANCE}개",
    )
    db.add(tx)
    db.commit()
    db.refresh(user)

    token, expires_in = create_access_token(user.id)
    return TokenResponse(access_token=token, expires_in=expires_in)


@router.post("/login", response_model=TokenResponse, summary="로그인")
def login(body: UserLoginRequest, db: Session = Depends(get_db)):
    """Authenticate with email + password and return a JWT."""
    user = db.query(User).filter(User.email == body.email).first()
    invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"message": "이메일 또는 비밀번호가 올바르지 않습니다.", "code": "INVALID_CREDENTIALS"},
    )

    if not user or not user.hashed_password:
        raise invalid
    if not verify_password(body.password, user.hashed_password):
        raise invalid
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"message": "비활성화된 계정입니다.", "code": "ACCOUNT_DISABLED"},
        )

    token, expires_in = create_access_token(user.id)
    return TokenResponse(access_token=token, expires_in=expires_in)


@router.get("/me", response_model=UserResponse, summary="내 정보 조회")
def me(current_user: User = Depends(get_current_user)):
    return current_user


# ── Google OAuth ──────────────────────────────────────────────────────────────

@router.get("/google", summary="Google 소셜 로그인 시작")
def google_login(request: Request):
    """Redirect the browser to Google's OAuth consent screen."""
    if not settings.GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=501, detail="Google OAuth가 설정되지 않았습니다.")

    params = {
        "client_id": settings.GOOGLE_CLIENT_ID,
        "redirect_uri": _backend_callback_url(request, "google"),
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "offline",
        "prompt": "select_account",
    }
    return RedirectResponse(url=_GOOGLE_AUTH_URL + "?" + urllib.parse.urlencode(params))


@router.get("/google/callback", summary="Google OAuth 콜백")
def google_callback(code: str, request: Request, db: Session = Depends(get_db)):
    """Exchange the authorization code for a user profile, then issue our JWT."""
    try:
        with httpx.Client(timeout=10) as client:
            token_resp = client.post(
                _GOOGLE_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": settings.GOOGLE_CLIENT_ID,
                    "client_secret": settings.GOOGLE_CLIENT_SECRET,
                    "redirect_uri": _backend_callback_url(request, "google"),
                    "grant_type": "authorization_code",
                },
            )
            token_resp.raise_for_status()
            google_access_token = token_resp.json()["access_token"]

            info_resp = client.get(
                _GOOGLE_USERINFO,
                headers={"Authorization": f"Bearer {google_access_token}"},
            )
            info_resp.raise_for_status()
            info = info_resp.json()

        user = _find_or_create_oauth_user(
            db,
            provider="google",
            oauth_id=str(info["sub"]),
            email=info["email"],
            name=info.get("name") or info["email"].split("@")[0],
        )
        our_token, _ = create_access_token(user.id)
        return _redirect_to_frontend(token=our_token)

    except Exception as exc:  # noqa: BLE001
        return _redirect_to_frontend(error=str(exc))


# ── Kakao OAuth ───────────────────────────────────────────────────────────────

@router.get("/kakao", summary="Kakao 소셜 로그인 시작")
def kakao_login(request: Request):
    """Redirect the browser to Kakao's OAuth consent screen."""
    if not settings.KAKAO_CLIENT_ID:
        raise HTTPException(status_code=501, detail="Kakao OAuth가 설정되지 않았습니다.")

    params = {
        "client_id": settings.KAKAO_CLIENT_ID,
        "redirect_uri": _backend_callback_url(request, "kakao"),
        "response_type": "code",
    }
    return RedirectResponse(url=_KAKAO_AUTH_URL + "?" + urllib.parse.urlencode(params))


@router.get("/kakao/callback", summary="Kakao OAuth 콜백")
def kakao_callback(code: str, request: Request, db: Session = Depends(get_db)):
    """Exchange the Kakao authorization code for a user profile, then issue our JWT."""
    try:
        with httpx.Client(timeout=10) as client:
            token_data: dict = {
                "grant_type": "authorization_code",
                "client_id": settings.KAKAO_CLIENT_ID,
                "redirect_uri": _backend_callback_url(request, "kakao"),
                "code": code,
            }
            if settings.KAKAO_CLIENT_SECRET:
                token_data["client_secret"] = settings.KAKAO_CLIENT_SECRET

            token_resp = client.post(_KAKAO_TOKEN_URL, data=token_data)
            token_resp.raise_for_status()
            kakao_access_token = token_resp.json()["access_token"]

            info_resp = client.get(
                _KAKAO_USERINFO,
                headers={"Authorization": f"Bearer {kakao_access_token}"},
            )
            info_resp.raise_for_status()
            info = info_resp.json()

        kakao_account = info.get("kakao_account", {})
        profile = kakao_account.get("profile", {})
        email = kakao_account.get("email") or f"kakao_{info['id']}@kakao.local"
        name = profile.get("nickname") or email.split("@")[0]

        user = _find_or_create_oauth_user(
            db,
            provider="kakao",
            oauth_id=str(info["id"]),
            email=email,
            name=name,
        )
        our_token, _ = create_access_token(user.id)
        return _redirect_to_frontend(token=our_token)

    except Exception as exc:  # noqa: BLE001
        return _redirect_to_frontend(error=str(exc))
