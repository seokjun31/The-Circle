"""
GET  /api/v1/credits/balance   — 현재 크레딧 잔액 조회 (+ 이번 달 사용량)
POST /api/v1/credits/use       — 기능 실행 전 크레딧 원자적 차감
GET  /api/v1/credits/history   — 크레딧 거래 내역
POST /api/v1/credits/purchase  — 크레딧 충전 (PG 연동 전 stub)
"""

import math
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func
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

# ── Pricing plans ─────────────────────────────────────────────────────────────
PLANS = {
    "basic": {"name": "Basic", "price_krw": 9900, "credits": 50},
    "pro": {"name": "Pro", "price_krw": 29900, "credits": 200},
}


class CreditPurchaseRequest(BaseModel):
    plan: str = Field(description="요금제 키: 'basic' | 'pro'")


class CreditPurchaseResponse(BaseModel):
    success: bool
    plan: str
    credits_added: int
    new_balance: int
    message: str


# ── GET /balance ──────────────────────────────────────────────────────────────


@router.get(
    "/balance",
    response_model=CreditBalanceResponse,
    summary="크레딧 잔액 조회",
)
def get_balance(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    used_this_month = (
        db.query(func.coalesce(func.sum(CreditTransaction.amount), 0))
        .filter(
            CreditTransaction.user_id == current_user.id,
            CreditTransaction.type == CreditType.usage,
            CreditTransaction.created_at >= month_start,
        )
        .scalar()
    )
    # usage amounts are stored as negative — flip sign for display
    used_this_month = abs(int(used_this_month))

    return CreditBalanceResponse(
        balance=current_user.credit_balance,
        user_id=current_user.id,
        used_this_month=used_this_month,
    )


# ── POST /use ─────────────────────────────────────────────────────────────────


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
        amount=-body.amount,
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


# ── GET /history ──────────────────────────────────────────────────────────────


@router.get("/history", summary="크레딧 거래 내역")
def credit_history(
    page: int = 1,
    page_size: int = 20,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return paginated credit transaction history for the current user."""
    page_size = min(page_size, 100)
    offset = (page - 1) * page_size

    q = db.query(CreditTransaction).filter(CreditTransaction.user_id == current_user.id)
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


# ── POST /purchase ────────────────────────────────────────────────────────────


@router.post(
    "/purchase",
    response_model=CreditPurchaseResponse,
    summary="크레딧 충전 (요금제 구매)",
)
def purchase_credits(
    body: CreditPurchaseRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Stub endpoint for credit purchase.

    Currently adds credits directly (no real payment).
    A future PG (Payment Gateway) integration will add a payment step before
    calling this logic. The frontend can call this to simulate purchase during
    development.

    Plans:
      - basic: 9,900원 → 50 크레딧
      - pro:   29,900원 → 200 크레딧
    """
    plan = PLANS.get(body.plan)
    if not plan:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "message": f"알 수 없는 요금제입니다: {body.plan!r}. 가능한 값: {list(PLANS)}",
                "code": "UNKNOWN_PLAN",
            },
        )

    credits_to_add = plan["credits"]

    tx = CreditTransaction(
        user_id=current_user.id,
        amount=credits_to_add,
        type=CreditType.purchase,
        description=f"[{plan['name']}] 요금제 크레딧 충전 ({plan['price_krw']:,}원)",
    )
    db.add(tx)
    current_user.credit_balance += credits_to_add
    db.commit()
    db.refresh(current_user)

    return CreditPurchaseResponse(
        success=True,
        plan=body.plan,
        credits_added=credits_to_add,
        new_balance=current_user.credit_balance,
        message=f"{credits_to_add}크레딧이 충전되었습니다. (잔액: {current_user.credit_balance})",
    )
