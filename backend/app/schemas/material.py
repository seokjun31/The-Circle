from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.models.material import MaterialCategory


class MaterialCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    category: MaterialCategory
    tile_image_url: str = Field(description="S3 URL — seamless PNG, min 512×512")
    normal_map_url: Optional[str] = None
    tile_width_cm: Optional[float] = Field(default=None, gt=0)
    tile_height_cm: Optional[float] = Field(default=None, gt=0)
    brand: Optional[str] = None
    product_code: Optional[str] = None
    price_range: Optional[str] = None
    tags: List[str] = []
    style: Optional[str] = None


class MaterialResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    category: MaterialCategory
    tile_image_url: str
    normal_map_url: Optional[str]
    tile_width_cm: Optional[float]
    tile_height_cm: Optional[float]
    brand: Optional[str]
    product_code: Optional[str]
    price_range: Optional[str]
    tags: List[str]
    style: Optional[str]
    created_at: datetime


class MaterialListResponse(BaseModel):
    items: List[MaterialResponse]
    total: int
    page: int
    page_size: int
    total_pages: int


class MaterialTilingReport(BaseModel):
    """Result of the seamless-tiling validation check."""
    verdict: Literal["pass", "warn", "fail"]
    mean_diff: float              # mean absolute colour diff at seams (0–255)
    vertical_seam_diff: float     # diff at left↔right boundary
    horizontal_seam_diff: float   # diff at top↔bottom boundary
    message: str                  # human-readable verdict
    width_px: int
    height_px: int


class MaterialUploadResponse(BaseModel):
    """Returned by POST /materials (admin upload endpoint)."""
    material: MaterialResponse
    tiling_report: MaterialTilingReport
