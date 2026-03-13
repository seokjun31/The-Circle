from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.models.furniture import FurnitureCategory


class FurnitureCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    category: FurnitureCategory
    brand: Optional[str] = None
    product_name: Optional[str] = None
    product_url: Optional[str] = None
    width_cm: Optional[float] = Field(default=None, gt=0)
    height_cm: Optional[float] = Field(default=None, gt=0)
    depth_cm: Optional[float] = Field(default=None, gt=0)
    image_url: Optional[str] = None
    thumbnail_url: Optional[str] = None
    tags: List[str] = []
    style: Optional[str] = None


class FurnitureResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    category: FurnitureCategory
    brand: Optional[str]
    product_name: Optional[str]
    product_url: Optional[str]
    width_cm: Optional[float]
    height_cm: Optional[float]
    depth_cm: Optional[float]
    image_url: Optional[str]
    thumbnail_url: Optional[str]
    tags: List[str]
    style: Optional[str]
    created_at: datetime
