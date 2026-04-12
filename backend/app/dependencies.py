"""
Common FastAPI dependencies:
  - get_db       : database session
  - get_current_user : JWT-authenticated user
  - require_admin    : admin-only gate
"""

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import decode_access_token

_bearer = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    """
    Extract and validate the Bearer JWT.
    Raises 401 if the token is missing or invalid.
    """
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"message": "인증이 필요합니다.", "code": "UNAUTHORIZED"},
        )

    user_id = decode_access_token(credentials.credentials)
    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "message": "유효하지 않거나 만료된 토큰입니다.",
                "code": "INVALID_TOKEN",
            },
        )

    user = db.get(User, int(user_id))
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"message": "사용자를 찾을 수 없습니다.", "code": "USER_NOT_FOUND"},
        )
    return user


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    """Raise 403 if the authenticated user is not an admin."""
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"message": "관리자 권한이 필요합니다.", "code": "FORBIDDEN"},
        )
    return current_user
