from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.models.project import ImageType, ProjectStatus
from app.schemas.edit_layer import EditLayerResponse


class ProjectCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    image_type: ImageType = ImageType.single


class ProjectResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    title: str
    original_image_url: Optional[str]
    thumbnail_url: Optional[str]
    image_type: ImageType
    status: ProjectStatus
    created_at: datetime
    updated_at: datetime


class ProjectDetailResponse(ProjectResponse):
    """Project with all layers included."""

    layers: List[EditLayerResponse] = []


class ProjectListResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    items: List[ProjectResponse]
    total: int
    page: int
    page_size: int
    total_pages: int


class PresignResponse(BaseModel):
    """Response for presigned S3 upload URL."""

    project_id: int
    upload_url: str  # presigned PUT URL
    s3_key: str  # S3 object key (for confirm step)
    expires_in: int = 3600  # URL validity in seconds
