import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, Float, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class MaterialCategory(str, enum.Enum):
    wallpaper = "wallpaper"
    flooring = "flooring"
    ceiling = "ceiling"
    tile = "tile"
    paint = "paint"


class Material(Base):
    __tablename__ = "materials"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[MaterialCategory] = mapped_column(
        Enum(MaterialCategory, name="materialcategory", create_type=True),
        nullable=False,
        index=True,
    )

    # S3 URL — seamless tile image (minimum 512×512 PNG)
    tile_image_url: Mapped[str] = mapped_column(String(2048), nullable=False)
    # Optional PBR normal map for 3-D preview
    normal_map_url: Mapped[str | None] = mapped_column(String(2048))

    # Physical dimensions (used for tiling scale calculation)
    tile_width_cm: Mapped[float | None] = mapped_column(Float)
    tile_height_cm: Mapped[float | None] = mapped_column(Float)

    # Product info
    brand: Mapped[str | None] = mapped_column(String(100))
    product_code: Mapped[str | None] = mapped_column(String(100))
    price_range: Mapped[str | None] = mapped_column(String(100))

    # Metadata for search / filtering
    tags: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    style: Mapped[str | None] = mapped_column(String(100), index=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    def __repr__(self) -> str:
        return f"<Material id={self.id} name={self.name!r} category={self.category}>"
