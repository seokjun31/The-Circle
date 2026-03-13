from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.credit_transaction import CreditType


class CreditBalanceResponse(BaseModel):
    balance: int
    user_id: int


class CreditUseRequest(BaseModel):
    amount: int = Field(gt=0, description="크레딧 차감량 (양수)")
    feature: str = Field(
        min_length=1,
        max_length=100,
        description="사용한 기능 이름 (예: 'inpainting', 'style_transfer')",
    )
    description: str = Field(default="", max_length=500)


class CreditUseResponse(BaseModel):
    success: bool
    deducted: int
    remaining_balance: int
    transaction_id: int


class CreditTransactionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    amount: int
    type: CreditType
    description: str
    feature_used: str | None
    created_at: datetime
