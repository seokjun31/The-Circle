"""
가구 관리 & 배치 API — Phase 6

GET  /api/v1/furniture                         — 가구 목록 (카테고리/검색 필터)
GET  /api/v1/furniture/{id}                    — 가구 상세
POST /api/v1/furniture                         — 가구 등록 (관리자)
POST /api/v1/furniture/upload-image            — 커스텀 가구 이미지 업로드 (일반 사용자)
POST /api/v1/projects/{id}/place-furniture     — AI 가구 배치 + 블렌딩
"""
from __future__ import annotations

import math
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import update as sa_update
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_db
from app.models.furniture import Furniture, FurnitureCategory
from app.models.project import Project
from app.models.user import User
from app.schemas.furniture import FurnitureCreateRequest, FurnitureResponse
from app.services.comfyui.runpod_client import RunPodError
from app.services.furniture import (
    CREDITS_PER_PLACEMENT,
    FurnitureResult,
    furniture_service,
)
from app.services.image_processor import validate_image, ImageValidationError
from app.services.s3 import storage

router = APIRouter(prefix="/furniture", tags=["Furniture"])

_PAGE_SIZE_DEFAULT = 20
_PAGE_SIZE_MAX     = 100


# ─────────────────────────────────────────────────────────────────────────────
#  GET /furniture — list with filters
# ─────────────────────────────────────────────────────────────────────────────

class FurnitureListResponse(BaseModel):
    items:       list[FurnitureResponse]
    total:       int
    page:        int
    page_size:   int
    total_pages: int


@router.get(
    "",
    response_model=FurnitureListResponse,
    summary="가구 목록 조회 (카테고리/검색 필터)",
)
def list_furniture(
    category:  Optional[str] = None,
    style:     Optional[str] = None,
    search:    Optional[str] = None,
    page:      int           = 1,
    page_size: int           = _PAGE_SIZE_DEFAULT,
    db:        Session       = Depends(get_db),
):
    page_size = min(page_size, _PAGE_SIZE_MAX)
    offset    = (page - 1) * page_size

    q = db.query(Furniture)
    if category:
        try:
            cat_enum = FurnitureCategory(category)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid category: {category}. Valid: {[c.value for c in FurnitureCategory]}",
            )
        q = q.filter(Furniture.category == cat_enum)
    if style:
        q = q.filter(Furniture.style == style)
    if search:
        term = f"%{search}%"
        q = q.filter(
            Furniture.name.ilike(term) | Furniture.brand.ilike(term) | Furniture.product_name.ilike(term)
        )

    total = q.count()
    items = q.order_by(Furniture.created_at.desc()).offset(offset).limit(page_size).all()

    return FurnitureListResponse(
        items       = items,
        total       = total,
        page        = page,
        page_size   = page_size,
        total_pages = math.ceil(total / page_size) if total else 1,
    )


# ─────────────────────────────────────────────────────────────────────────────
#  GET /furniture/{id}
# ─────────────────────────────────────────────────────────────────────────────

@router.get(
    "/{furniture_id}",
    response_model=FurnitureResponse,
    summary="가구 상세 조회",
)
def get_furniture(
    furniture_id: int,
    db: Session = Depends(get_db),
):
    furn = db.get(Furniture, furniture_id)
    if not furn:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"message": "가구를 찾을 수 없습니다.", "code": "NOT_FOUND"},
        )
    return furn


# ─────────────────────────────────────────────────────────────────────────────
#  POST /furniture — admin create
# ─────────────────────────────────────────────────────────────────────────────

@router.post(
    "",
    response_model=FurnitureResponse,
    status_code=status.HTTP_201_CREATED,
    summary="가구 등록 (관리자 전용)",
)
def create_furniture(
    body: FurnitureCreateRequest,
    db:   Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"message": "관리자만 가구를 등록할 수 있습니다.", "code": "FORBIDDEN"},
        )
    furn = Furniture(**body.model_dump())
    db.add(furn)
    db.commit()
    db.refresh(furn)
    return furn


# ─────────────────────────────────────────────────────────────────────────────
#  POST /furniture/remove-bg — rembg background removal
# ─────────────────────────────────────────────────────────────────────────────

class RemoveBgResponse(BaseModel):
    url:       str
    width_px:  int
    height_px: int


@router.post(
    "/remove-bg",
    response_model=RemoveBgResponse,
    status_code=status.HTTP_200_OK,
    summary="가구 이미지 배경 제거 (rembg)",
)
def remove_furniture_bg(
    file: UploadFile = File(..., description="배경 제거할 이미지, 최대 10 MB"),
    current_user: User = Depends(get_current_user),
):
    """
    Remove the background from a furniture image using rembg (u2net model).
    Returns a public S3 URL with transparent PNG.
    """
    import io
    from PIL import Image

    raw = file.file.read()
    if len(raw) > 10 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={"message": "파일 크기는 10 MB 이하여야 합니다.", "code": "FILE_TOO_LARGE"},
        )

    try:
        from rembg import remove as rembg_remove
        output_bytes = rembg_remove(raw)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"message": f"배경 제거 실패: {exc}", "code": "REMBG_ERROR"},
        ) from exc

    try:
        img = Image.open(io.BytesIO(output_bytes))
        w, h = img.size
    except Exception:
        w = h = 0

    key = f"users/{current_user.id}/furniture_rembg/{uuid.uuid4().hex}.png"
    url = storage.upload(
        data         = output_bytes,
        key          = key,
        content_type = "image/png",
        public       = True,
    )

    return RemoveBgResponse(url=url, width_px=w, height_px=h)


# ─────────────────────────────────────────────────────────────────────────────
#  POST /furniture/upload-image — upload custom furniture PNG
# ─────────────────────────────────────────────────────────────────────────────

class FurnitureUploadResponse(BaseModel):
    furniture_image_url: str
    width_px:            int
    height_px:           int
    file_size_kb:        float


@router.post(
    "/upload-image",
    response_model=FurnitureUploadResponse,
    status_code=status.HTTP_201_CREATED,
    summary="커스텀 가구 이미지 업로드 (배경 제거된 PNG)",
)
def upload_furniture_image(
    file: UploadFile = File(..., description="배경 제거된 PNG 이미지, 최대 10 MB"),
    db:   Session    = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Upload a custom furniture image (background-removed PNG).
    Returns the S3 URL to use in POST /projects/{id}/place-furniture.

    The image is NOT saved to the furniture catalog — it is ephemeral.
    """
    raw          = file.file.read()
    content_type = file.content_type or ""

    # Validate
    try:
        validate_image(raw, content_type, max_bytes=10 * 1024 * 1024)
    except ImageValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"message": str(exc), "code": "INVALID_IMAGE"},
        )

    # Quick dimension check via Pillow
    from PIL import Image
    import io
    try:
        img = Image.open(io.BytesIO(raw))
        w, h = img.size
    except Exception:
        w = h = 0

    key = f"users/{current_user.id}/furniture_uploads/{uuid.uuid4().hex}.png"
    url = storage.upload(
        data         = raw,
        key          = key,
        content_type = "image/png",
        public       = True,
    )

    return FurnitureUploadResponse(
        furniture_image_url = url,
        width_px            = w,
        height_px           = h,
        file_size_kb        = round(len(raw) / 1024, 1),
    )


# ─────────────────────────────────────────────────────────────────────────────
#  POST /projects/{id}/place-furniture — AI placement
# ─────────────────────────────────────────────────────────────────────────────

# NOTE: This endpoint lives on the /furniture router but references a project_id.
# We route it separately below so the prefix is /api/v1/projects/{id}/...

place_router = APIRouter(tags=["Furniture"])


class PlaceFurnitureRequest(BaseModel):
    # Furniture source — provide one
    furniture_id:         Optional[int]   = Field(None, description="DB 가구 ID")
    furniture_image_url:  Optional[str]   = Field(None, description="업로드된 가구 이미지 URL (upload-image 반환값)")

    # Physical dimensions (cm)
    furniture_width_cm:   Optional[float] = Field(None, gt=0, description="가구 실제 너비(cm)")
    furniture_height_cm:  Optional[float] = Field(None, gt=0, description="가구 실제 높이(cm)")
    space_width_cm:       Optional[float] = Field(None, gt=0, description="배치할 공간 너비(cm) — 적합성 판단용")

    # Placement in original-image pixels
    position_x:           int   = Field(0, ge=0, description="가구 좌상단 X 좌표 (원본 이미지 픽셀)")
    position_y:           int   = Field(0, ge=0, description="가구 좌상단 Y 좌표 (원본 이미지 픽셀)")
    target_width_px:      int   = Field(200, ge=10, le=4096, description="합성 이미지 내 가구 너비(px)")


class FitCheckResponse(BaseModel):
    fits:               bool
    furniture_width_cm: float
    space_width_cm:     float
    margin_cm:          float
    category:           str


class PlaceFurnitureResponse(BaseModel):
    result_url:        str
    layer_id:          int
    elapsed_s:         float
    fit_check:         Optional[FitCheckResponse]
    credits_used:      int
    remaining_balance: int


@place_router.post(
    "/projects/{project_id}/place-furniture",
    response_model=PlaceFurnitureResponse,
    summary="AI 가구 배치 — Pillow 합성 + ComfyUI 자연 블렌딩",
)
async def place_furniture(
    project_id: int,
    body:       PlaceFurnitureRequest,
    db:         Session = Depends(get_db),
    current_user: User  = Depends(get_current_user),
):
    """
    Composite a furniture PNG onto the room image and AI-blend it naturally.

    Workflow:
      1. Verify project ownership and credit balance
      2. Deduct credits
      3. Pillow alpha-composite: room + furniture at (position_x, position_y)
      4. Build ComfyUI inpainting workflow (denoise 0.25 — blend only)
      5. Run on RunPod (timeout 90 s)
      6. Return result + optional fit check

    Fit check: provided when both furniture_width_cm and space_width_cm are given.
    - margin ≥ 20 cm → "comfortable" (green)
    - margin ≥  0 cm → "tight"       (yellow)
    - margin <  0 cm → "too_large"   (red)

    Expected response time: 15–30 s.
    """
    if body.furniture_id is None and body.furniture_image_url is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"message": "furniture_id 또는 furniture_image_url 중 하나를 제공해야 합니다.", "code": "MISSING_FURNITURE"},
        )

    _get_owned_project(project_id, current_user, db)

    # Credit check
    if current_user.credit_balance < CREDITS_PER_PLACEMENT:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "message": (
                    f"크레딧이 부족합니다. "
                    f"(잔액: {current_user.credit_balance}, 필요: {CREDITS_PER_PLACEMENT})"
                ),
                "code":     "INSUFFICIENT_CREDITS",
                "balance":  current_user.credit_balance,
                "required": CREDITS_PER_PLACEMENT,
            },
        )

    current_user.credit_balance -= CREDITS_PER_PLACEMENT
    db.commit()

    user_id = current_user.id

    try:
        result: FurnitureResult = await furniture_service.place_furniture(
            project_id          = project_id,
            user_id             = user_id,
            db                  = db,
            furniture_id        = body.furniture_id,
            furniture_image_url = body.furniture_image_url,
            furniture_width_cm  = body.furniture_width_cm,
            furniture_height_cm = body.furniture_height_cm,
            space_width_cm      = body.space_width_cm,
            position_x          = body.position_x,
            position_y          = body.position_y,
            target_width_px     = body.target_width_px,
        )
    except ValueError as exc:
        _refund_credits(db, user_id, CREDITS_PER_PLACEMENT)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"message": str(exc), "code": "INVALID_INPUT"},
        ) from exc
    except RunPodError as exc:
        _refund_credits(db, user_id, CREDITS_PER_PLACEMENT)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"message": f"AI 처리 실패: {exc}", "code": "RUNPOD_ERROR"},
        ) from exc
    except Exception as exc:
        _refund_credits(db, user_id, CREDITS_PER_PLACEMENT)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"message": f"처리 중 오류 발생: {exc}", "code": "INTERNAL_ERROR"},
        ) from exc

    db.refresh(current_user)

    fit_resp = None
    if result.fit_check:
        fc = result.fit_check
        fit_resp = FitCheckResponse(
            fits               = fc.fits,
            furniture_width_cm = fc.furniture_width_cm,
            space_width_cm     = fc.space_width_cm,
            margin_cm          = fc.margin_cm,
            category           = fc.category,
        )

    return PlaceFurnitureResponse(
        result_url        = result.result_url,
        layer_id          = result.layer_id,
        elapsed_s         = result.elapsed_s,
        fit_check         = fit_resp,
        credits_used      = CREDITS_PER_PLACEMENT,
        remaining_balance = current_user.credit_balance,
    )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _refund_credits(db: Session, user_id: int, amount: int) -> None:
    """Refund credits using direct SQL to avoid ORM lazy-load issues."""
    try:
        db.rollback()
        db.execute(
            sa_update(User)
            .where(User.id == user_id)
            .values(credit_balance=User.credit_balance + amount)
        )
        db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass


def _get_owned_project(project_id: int, user: User, db: Session) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"message": "프로젝트를 찾을 수 없습니다.", "code": "NOT_FOUND"},
        )
    if project.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"message": "접근 권한이 없습니다.", "code": "FORBIDDEN"},
        )
    return project
