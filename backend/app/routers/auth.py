"""
POST /api/v1/auth/register  — create account
POST /api/v1/auth/login     — return JWT
GET  /api/v1/auth/me        — current user info
"""
from fastapi import APIRouter, Depends, HTTPException, status
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


@router.post(
    "/register",
    response_model=TokenResponse,
    status_code=status.HTTP_201_CREATED,
    summary="회원가입",
)
def register(body: UserRegisterRequest, db: Session = Depends(get_db)):
    """
    Create a new account and return a JWT.
    New users receive DEFAULT_CREDIT_BALANCE credits as welcome bonus.
    """
    # Check duplicate email
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
        db.flush()  # get user.id before commit
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"message": "이미 사용 중인 이메일입니다.", "code": "EMAIL_TAKEN"},
        )

    # Record welcome bonus credit transaction
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


@router.post(
    "/login",
    response_model=TokenResponse,
    summary="로그인",
)
def login(body: UserLoginRequest, db: Session = Depends(get_db)):
    """Authenticate and return a JWT."""
    user = db.query(User).filter(User.email == body.email).first()

    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"message": "이메일 또는 비밀번호가 올바르지 않습니다.", "code": "INVALID_CREDENTIALS"},
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"message": "비활성화된 계정입니다.", "code": "ACCOUNT_DISABLED"},
        )

    token, expires_in = create_access_token(user.id)
    return TokenResponse(access_token=token, expires_in=expires_in)


@router.get(
    "/me",
    response_model=UserResponse,
    summary="내 정보 조회",
)
def me(current_user: User = Depends(get_current_user)):
    return current_user
