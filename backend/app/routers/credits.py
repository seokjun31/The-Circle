"""
GET  /api/v1/credits/balance  — 현재 크레딧 잔액 조회
POST /api/v1/credits/use      — 기능 실행 전 크레딧 원자적 차감
GET  /api/v1/credits/history  — 크레딧 거래 내역
"""
import math

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_db
from app.models.credit_transaction import CreditTransaction, CreditType
from app.models.user import User
from app.schemas.credit import (
    CreditBalanceResponse,
    CreditTransactionResponse,
    CreditUseRequest,
    CreditUseResponse,
)

router = APIRouter(prefix="/credits", tags=["Credits"])


@router.get(
    "/balance",
    response_model=CreditBalanceResponse,
    summary="크레딧 잔액 조회",
)
def get_balance(current_user: User = Depends(get_current_user)):
    return CreditBalanceResponse(balance=current_user.credit_balance, user_id=current_user.id)


@router.post(
    "/use",
    response_model=CreditUseResponse,
    summary="크레딧 차감 (기능 실행 전 호출)",
)
def use_credits(
    body: CreditUseRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Atomically deduct *amount* credits from the authenticated user.

    - Raises 402 Payment Required if balance is insufficient.
    - Writes a CreditTransaction record for audit trail.
    - Updates user.credit_balance.

    Call this endpoint BEFORE starting an AI rendering job.
    If the job fails, call POST /credits/refund (future Phase 2 endpoint).
    """
    if current_user.credit_balance < body.amount:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "message": f"크레딧이 부족합니다. (잔액: {current_user.credit_balance}, 필요: {body.amount})",
                "code": "INSUFFICIENT_CREDITS",
                "balance": current_user.credit_balance,
                "required": body.amount,
            },
        )

    description = body.description or f"[{body.feature}] 기능 사용"

    tx = CreditTransaction(
        user_id=current_user.id,
        amount=-body.amount,           # negative = consumed
        type=CreditType.usage,
        description=description,
        feature_used=body.feature,
    )
    db.add(tx)

    current_user.credit_balance -= body.amount
    db.commit()
    db.refresh(current_user)
    db.refresh(tx)

    return CreditUseResponse(
        success=True,
        deducted=body.amount,
        remaining_balance=current_user.credit_balance,
        transaction_id=tx.id,
    )


@router.get(
    "/history",
    summary="크레딧 거래 내역",
)
def credit_history(
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return paginated credit transaction history for the current user."""
    page_size = min(page_size, 100)
    offset    = (page - 1) * page_size

    q     = db.query(CreditTransaction).filter(CreditTransaction.user_id == current_user.id)
    total = q.count()
    items = (
        q.order_by(CreditTransaction.created_at.desc())
        .offset(offset)
        .limit(page_size)
        .all()
    )

    return {
        "items": [CreditTransactionResponse.model_validate(t) for t in items],
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": math.ceil(total / page_size) if total else 1,
    }
