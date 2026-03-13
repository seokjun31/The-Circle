import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class CreditType(str, enum.Enum):
    purchase = "purchase"   # User bought credits
    usage = "usage"         # Feature consumed credits (negative amount)
    bonus = "bonus"         # Free bonus credits
    refund = "refund"       # Credits returned after failure


class CreditTransaction(Base):
    __tablename__ = "credit_transactions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Positive = credit added, Negative = credit consumed
    amount: Mapped[int] = mapped_column(Integer, nullable=False)
    type: Mapped[CreditType] = mapped_column(
        Enum(CreditType, name="credittype", create_type=True), nullable=False
    )
    description: Mapped[str] = mapped_column(String(500), nullable=False)
    # Which feature triggered this transaction (e.g. "inpainting", "style_transfer")
    feature_used: Mapped[str | None] = mapped_column(String(100))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    user: Mapped["User"] = relationship("User", back_populates="credit_transactions")  # noqa: F821

    def __repr__(self) -> str:
        return f"<CreditTransaction id={self.id} user_id={self.user_id} amount={self.amount} type={self.type}>"
