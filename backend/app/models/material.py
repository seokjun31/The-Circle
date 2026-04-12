import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, Float, Integer, String, Text, func
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

    # ── AI generation parameters ──────────────────────────────────────────────
    # Optimised positive prompt for this specific material.
    # e.g. "seamless large format beige porcelain tile floor, cotton beige tone, ..."
    positive_prompt: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Optimised negative prompt — suppress attributes that don't belong.
    # e.g. "wood grain, glossy, reflective, wet, cracked, ..."
    negative_prompt: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # IP-Adapter weight tuned per material type (range 0.3–0.9, default 0.6).
    # - Patterned materials (marble, wood grain): 0.5–0.65
    # - Solid / matte materials (paint, plain tile): 0.4–0.55
    # - Complex patterns (mosaic, herringbone): 0.6–0.75
    ip_adapter_weight: Mapped[float] = mapped_column(Float, nullable=False, default=0.6)
    # KSampler denoise strength tuned per material (range 0.5–0.75, default 0.62).
    # - Similar tone to original: 0.5–0.58
    # - Different tone: 0.60–0.68
    # - Major tone change (light → dark): 0.65–0.75
    recommended_denoise: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.62
    )

    # Metadata for search / filtering
    tags: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    style: Mapped[str | None] = mapped_column(String(100), index=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    def __repr__(self) -> str:
        return f"<Material id={self.id} name={self.name!r} category={self.category}>"
