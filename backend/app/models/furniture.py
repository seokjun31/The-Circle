import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, Float, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class FurnitureCategory(str, enum.Enum):
    sofa = "sofa"
    table = "table"
    chair = "chair"
    bed = "bed"
    shelf = "shelf"
    desk = "desk"
    lighting = "lighting"
    etc = "etc"


class Furniture(Base):
    __tablename__ = "furniture"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[FurnitureCategory] = mapped_column(
        Enum(FurnitureCategory, name="furniturecategory", create_type=True),
        nullable=False,
        index=True,
    )

    # Product metadata
    brand: Mapped[str | None] = mapped_column(String(100))
    product_name: Mapped[str | None] = mapped_column(String(200))
    product_url: Mapped[str | None] = mapped_column(String(2048))

    # Physical dimensions (cm)
    width_cm: Mapped[float | None] = mapped_column(Float)
    height_cm: Mapped[float | None] = mapped_column(Float)
    depth_cm: Mapped[float | None] = mapped_column(Float)

    # S3 URLs
    image_url: Mapped[str | None] = mapped_column(String(2048))       # background-removed PNG
    thumbnail_url: Mapped[str | None] = mapped_column(String(2048))

    # Metadata for search / filtering
    tags: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    style: Mapped[str | None] = mapped_column(String(100), index=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    def __repr__(self) -> str:
        return f"<Furniture id={self.id} name={self.name!r} category={self.category}>"
