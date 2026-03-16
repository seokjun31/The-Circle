"""
Segmentation endpoints for The Circle.

POST /api/v1/segment/encode
    Server-side SAM encoder fallback.
    Accepts a base64 JPEG/PNG, runs the SAM ONNX encoder, and returns the
    image embedding as a base64-encoded float32 array.  Used by low-end devices
    that cannot run the 40 MB encoder in-browser within 10 seconds.
    The lightweight decoder (~3.6 MB) always runs client-side.

POST /api/v1/projects/{project_id}/masks
    Save a confirmed SAM mask to S3 (or local storage) and record it as an
    EditLayer in the database.
    Returns { mask_url, layer_id } for use in downstream ComfyUI workflows.
"""

from __future__ import annotations

import base64
import io
import logging
import os
import uuid
from typing import Optional

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from PIL import Image
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_db
from app.models.edit_layer import EditLayer, LayerType
from app.models.project import Project
from app.models.user import User
from app.services.s3 import storage

logger = logging.getLogger("the_circle.segments")

# Path where the ONNX encoder model is stored on the backend server
_ENCODER_MODEL_PATH = os.getenv(
    "SAM_ENCODER_MODEL_PATH",
    "/models/sam/sam_encoder.onnx",
)

# ── Lazy-loaded ONNX session ──────────────────────────────────────────────────
_ort_session = None

def _get_encoder_session():
    """Load the ONNX encoder session once (lazy singleton)."""
    global _ort_session
    if _ort_session is not None:
        return _ort_session

    try:
        import onnxruntime as ort
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        _ort_session = ort.InferenceSession(_ENCODER_MODEL_PATH, providers=providers)
        logger.info("SAM encoder ONNX session loaded from %s", _ENCODER_MODEL_PATH)
        return _ort_session
    except Exception as exc:
        logger.error("Failed to load SAM encoder ONNX session: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SAM 인코더 모델을 로드할 수 없습니다. 서버 관리자에게 문의하세요.",
        ) from exc


# ── SAM image pre-processing (mirrors samUtils.js) ────────────────────────────

_SAM_SIZE   = 1024
_PIXEL_MEAN = np.array([123.675, 116.28,  103.53], dtype=np.float32)
_PIXEL_STD  = np.array([ 58.395,  57.12,   57.375], dtype=np.float32)


def _preprocess_image(pil_image: Image.Image) -> np.ndarray:
    """
    Resize a PIL image to a 1024×1024 letterbox and normalise (ImageNet stats).
    Returns a float32 numpy array of shape [1, 3, 1024, 1024].
    """
    orig_w, orig_h = pil_image.size
    scale   = _SAM_SIZE / max(orig_h, orig_w)
    new_w   = round(orig_w * scale)
    new_h   = round(orig_h * scale)

    # Letterbox canvas filled with mean colour
    canvas = Image.new("RGB", (_SAM_SIZE, _SAM_SIZE), tuple(_PIXEL_MEAN.astype(np.uint8)))
    resized = pil_image.convert("RGB").resize((new_w, new_h), Image.LANCZOS)
    canvas.paste(resized, (0, 0))

    arr = np.array(canvas, dtype=np.float32)  # [H, W, 3]
    arr = (arr - _PIXEL_MEAN) / _PIXEL_STD    # normalise
    arr = arr.transpose(2, 0, 1)              # HWC → CHW
    return arr[np.newaxis, :, :, :]            # [1, 3, H, W]


# ═══════════════════════════════════════════════════════════════════════════════
#  Schemas
# ═══════════════════════════════════════════════════════════════════════════════

class EncodeRequest(BaseModel):
    image_base64: str = Field(..., description="Base64-encoded JPEG or PNG image")


class EmbeddingPayload(BaseModel):
    data: str          # base64-encoded float32 bytes
    dims: list[int]    # [1, 256, 64, 64]
    type: str = "float32"


class EncodeResponse(BaseModel):
    embedding: EmbeddingPayload


class SaveMaskRequest(BaseModel):
    mask_base64: str   = Field(..., description="Base64-encoded PNG mask image (binary, white=selected)")
    label: str         = Field("벽", description="Region label: 벽 | 바닥 | 천장 | 기타")
    layer_order: int   = Field(0, ge=0)


class SaveMaskResponse(BaseModel):
    layer_id:  int
    mask_url:  str
    label:     str


# ═══════════════════════════════════════════════════════════════════════════════
#  Router
# ═══════════════════════════════════════════════════════════════════════════════

router = APIRouter(tags=["Segmentation"])


# ── POST /segment/encode — server-side SAM encoder ────────────────────────────

@router.post(
    "/segment/encode",
    response_model=EncodeResponse,
    summary="SAM 인코더 서버 폴백 — 이미지 임베딩 생성",
)
def encode_image(
    body: EncodeRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Run the SAM image encoder on the server and return the embedding.

    Used by the frontend when:
      - WebGL is unavailable (low-end device)
      - Browser-side encoding exceeds 10 seconds (ENCODER_TIMEOUT_MS)

    The client then uses the returned embedding to run the lightweight decoder
    locally for real-time click-based segmentation.
    """
    # 1. Decode base64 → PIL Image
    try:
        img_bytes = base64.b64decode(body.image_base64)
        pil_img   = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"이미지 디코딩 실패: {exc}",
        ) from exc

    # 2. Pre-process
    input_tensor = _preprocess_image(pil_img)  # [1,3,1024,1024]

    # 3. Run ONNX encoder
    session = _get_encoder_session()
    try:
        outputs = session.run(
            output_names=["image_embeddings"],
            input_feed={"image": input_tensor},
        )
        embedding: np.ndarray = outputs[0]  # [1,256,64,64]
    except Exception as exc:
        logger.exception("SAM encoder inference failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"SAM 인코더 실행 오류: {exc}",
        ) from exc

    # 4. Serialise: float32 → bytes → base64
    emb_bytes  = embedding.astype(np.float32).tobytes()
    emb_b64    = base64.b64encode(emb_bytes).decode("ascii")

    return EncodeResponse(
        embedding=EmbeddingPayload(
            data=emb_b64,
            dims=list(embedding.shape),
        )
    )


# ── POST /projects/{project_id}/masks — save confirmed mask ───────────────────

@router.post(
    "/projects/{project_id}/masks",
    response_model=SaveMaskResponse,
    status_code=status.HTTP_201_CREATED,
    summary="확정 마스크를 S3에 저장 + EditLayer 생성",
)
def save_mask(
    project_id: int,
    body: SaveMaskRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Save a SAM-generated mask PNG for a project.

    Flow:
      1. Verify project ownership
      2. Decode base64 PNG → raw bytes
      3. Upload to S3 at  users/{uid}/projects/{pid}/masks/{uuid}.png
      4. Create EditLayer record (layer_type = wall/floor/ceiling/etc.)
      5. Return { layer_id, mask_url, label }

    The mask_url is subsequently passed to WorkflowManager for ComfyUI inpainting.
    """
    # ── 1. Ownership check ─────────────────────────────────────────────────
    project: Optional[Project] = db.query(Project).filter(
        Project.id == project_id,
        Project.user_id == current_user.id,
    ).first()

    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="프로젝트를 찾을 수 없습니다.",
        )

    # ── 2. Decode mask PNG ─────────────────────────────────────────────────
    try:
        mask_bytes = base64.b64decode(body.mask_base64)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"마스크 데이터 디코딩 실패: {exc}",
        ) from exc

    # Validate it is a real PNG
    try:
        with Image.open(io.BytesIO(mask_bytes)) as img:
            img.verify()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"유효하지 않은 PNG 파일입니다: {exc}",
        ) from exc

    # ── 3. Upload to S3 / local ─────────────────────────────────────────────
    mask_filename = f"mask_{uuid.uuid4().hex}.png"
    s3_key = storage.project_key(
        current_user.id, project_id, f"masks/{mask_filename}"
    )
    try:
        mask_url = storage.upload(
            data=mask_bytes,
            key=s3_key,
            content_type="image/png",
            public=True,
        )
    except Exception as exc:
        logger.exception("Mask upload failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"마스크 업로드 실패: {exc}",
        ) from exc

    # ── 4. Map label → LayerType ────────────────────────────────────────────
    label_map = {
        "벽":  LayerType.wall,
        "바닥": LayerType.floor,
        "천장": LayerType.ceiling,
    }
    layer_type = label_map.get(body.label, LayerType.style)

    # ── 5. Persist EditLayer ────────────────────────────────────────────────
    layer = EditLayer(
        project_id=project_id,
        layer_type=layer_type,
        parameters={
            "mask_url":    mask_url,
            "label":       body.label,
            "source":      "sam_browser",
        },
        result_image_url=None,
        is_visible=True,
        order=body.layer_order,
    )
    db.add(layer)
    db.commit()
    db.refresh(layer)

    logger.info(
        "Mask saved: project_id=%d layer_id=%d label=%s url=%s",
        project_id, layer.id, body.label, mask_url,
    )

    return SaveMaskResponse(
        layer_id=layer.id,
        mask_url=mask_url,
        label=body.label,
    )
