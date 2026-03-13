from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field, HttpUrl

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
