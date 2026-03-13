from datetime import datetime
from typing import Any, Dict, Optional

from pydantic import BaseModel, ConfigDict

from app.models.edit_layer import LayerType


class EditLayerCreateRequest(BaseModel):
    layer_type: LayerType
    parameters: Dict[str, Any] = {}
    order: int = 0


class EditLayerResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    layer_type: LayerType
    parameters: Dict[str, Any]
    result_image_url: Optional[str]
    is_visible: bool
    order: int
    created_at: datetime
