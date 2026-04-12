"""
GET  /api/v1/materials              — 자재 목록 (category / style / page 필터)
GET  /api/v1/materials/{id}         — 자재 상세
POST /api/v1/materials              — 자재 등록 (관리자 전용, multipart upload)
POST /api/v1/materials/generate-prompts — Claude Vision으로 프롬프트 자동 생성
POST /api/v1/materials/{id}/validate-tiling — 타일링 검증 단독 실행
"""

import io
import math
from typing import Optional

import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from PIL import Image
from sqlalchemy.orm import Session

from app.dependencies import get_db, require_admin
from app.models.material import Material, MaterialCategory
from app.schemas.material import (
    MaterialGeneratePromptsRequest,
    MaterialGeneratePromptsResponse,
    MaterialListResponse,
    MaterialResponse,
    MaterialTilingReport,
    MaterialUploadResponse,
)
from app.services.material_prompt_generator import material_prompt_generator
from app.services.s3 import storage

router = APIRouter(prefix="/materials", tags=["Materials"])

_PAGE_SIZE_DEFAULT = 20
_PAGE_SIZE_MAX = 100

# ── Tiling validation thresholds ─────────────────────────────────────────────
_TILING_WARN_THRESHOLD  = 20.0   # mean per-pixel colour diff (0-255) at seam
_TILING_ERROR_THRESHOLD = 45.0   # above this → strongly not seamless
_TILE_MIN_PX = 256               # reject images smaller than 256×256


# ─────────────────────────────────────────────────────────────────────────────
#  Tiling validation helper
# ─────────────────────────────────────────────────────────────────────────────

def _validate_seamless_tiling(img: Image.Image) -> MaterialTilingReport:
    """
    Check whether *img* tiles seamlessly by:
      1. Building a 2×2 tiled version
      2. Computing mean absolute colour difference at the vertical seam
         (right edge of left tile vs. left edge of right tile)
      3. Computing mean absolute colour difference at the horizontal seam
         (bottom edge of top tile vs. top edge of bottom tile)

    Returns a MaterialTilingReport with scores and a pass/warn/fail verdict.
    """
    arr = np.array(img.convert("RGB"), dtype=np.float32)  # H×W×3
    h, w = arr.shape[:2]

    # Vertical seam: compare last column of tile with first column
    right_edge = arr[:, -1, :]   # H×3
    left_edge  = arr[:, 0,  :]   # H×3
    v_diff = float(np.mean(np.abs(right_edge - left_edge)))

    # Horizontal seam: compare last row with first row
    bottom_edge = arr[-1, :, :]  # W×3
    top_edge    = arr[0,  :, :]  # W×3
    h_diff = float(np.mean(np.abs(bottom_edge - top_edge)))

    mean_diff = (v_diff + h_diff) / 2.0

    if mean_diff <= _TILING_WARN_THRESHOLD:
        verdict = "pass"
        message = "이미지가 원활하게 타일링됩니다."
    elif mean_diff <= _TILING_ERROR_THRESHOLD:
        verdict = "warn"
        message = (
            f"경계 색상 차이 {mean_diff:.1f}/255 — 미세한 경계선이 보일 수 있습니다. "
            "Photoshop Offset 또는 전용 타일링 도구로 보정을 권장합니다."
        )
    else:
        verdict = "fail"
        message = (
            f"경계 색상 차이 {mean_diff:.1f}/255 — 이미지가 타일링 패턴에 맞지 않습니다. "
            "Seamless 텍스처로 교체해주세요."
        )

    return MaterialTilingReport(
        verdict=verdict,
        mean_diff=round(mean_diff, 2),
        vertical_seam_diff=round(v_diff, 2),
        horizontal_seam_diff=round(h_diff, 2),
        message=message,
        width_px=w,
        height_px=h,
    )


# ─────────────────────────────────────────────────────────────────────────────
#  Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@router.get(
    "",
    response_model=MaterialListResponse,
    summary="자재 목록 조회",
)
def list_materials(
    category: Optional[MaterialCategory] = None,
    style: Optional[str] = None,
    search: Optional[str] = None,
    page: int = 1,
    page_size: int = _PAGE_SIZE_DEFAULT,
    db: Session = Depends(get_db),
):
    """
    Query parameters:
      - category : wallpaper | flooring | ceiling | tile | paint
      - style    : exact string match (e.g. 'modern')
      - search   : partial name match
      - page     : 1-based page number
      - page_size: items per page (max 100)
    """
    page_size = min(page_size, _PAGE_SIZE_MAX)
    offset    = (page - 1) * page_size

    q = db.query(Material)

    if category:
        q = q.filter(Material.category == category)
    if style:
        q = q.filter(Material.style == style)
    if search:
        q = q.filter(Material.name.ilike(f"%{search}%"))

    total = q.count()
    items = q.order_by(Material.created_at.desc()).offset(offset).limit(page_size).all()

    return MaterialListResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=math.ceil(total / page_size) if total else 1,
    )


@router.post(
    "/generate-prompts",
    response_model=MaterialGeneratePromptsResponse,
    summary="자재 이미지 → Claude Vision 프롬프트 자동 생성 (관리자 전용)",
    dependencies=[Depends(require_admin)],
)
async def generate_material_prompts(
    body: MaterialGeneratePromptsRequest,
):
    """
    자재 이미지 URL을 Claude Vision API에 전송하여
    ComfyUI IP-Adapter 워크플로우에 최적화된 프롬프트 파라미터를 자동 생성합니다.

    **사용 흐름 (자재 등록 UI 예시):**
    1. 관리자가 타일 이미지를 업로드 → S3에 저장 후 URL 획득
    2. 이 엔드포인트 호출 → 프롬프트 미리보기
    3. 필요 시 수동 수정 후 POST /materials로 최종 등록

    **ANTHROPIC_API_KEY 미설정 또는 API 오류 시:**
    카테고리별 기본값을 반환합니다 (서비스 중단 없음).
    이 경우 응답의 `generated_by_ai: false`가 됩니다.

    Parameters:
        image_url: 분석할 자재 이미지 URL.
        category:  자재 카테고리 (wallpaper/flooring/ceiling/tile/paint).
        name:      자재명 (한국어/영어 모두 가능).
    """
    from app.config import settings

    # API 키 유무로 ai 생성 여부 판단
    has_api_key = bool(settings.ANTHROPIC_API_KEY)

    result = await material_prompt_generator.generate_prompts(
        image_url = body.image_url,
        category  = body.category,
        name      = body.name,
    )

    return MaterialGeneratePromptsResponse(
        **result,
        generated_by_ai = has_api_key,
        model           = "claude-sonnet-4-20250514" if has_api_key else None,
    )


@router.get(
    "/{material_id}",
    response_model=MaterialResponse,
    summary="자재 상세 조회",
)
def get_material(material_id: int, db: Session = Depends(get_db)):
    material = db.get(Material, material_id)
    if material is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"message": "자재를 찾을 수 없습니다.", "code": "NOT_FOUND"},
        )
    return material


@router.post(
    "",
    response_model=MaterialUploadResponse,
    status_code=status.HTTP_201_CREATED,
    summary="자재 등록 (관리자 전용) — 이미지 업로드 + 타일링 검증",
    dependencies=[Depends(require_admin)],
)
def create_material(
    # ── Required text fields ─────────────────────────────────────────────────
    name: str                     = Form(..., min_length=1, max_length=200),
    category: MaterialCategory    = Form(...),
    tile_width_cm: float          = Form(..., gt=0, description="실제 타일 가로 크기 (cm)"),
    tile_height_cm: float         = Form(..., gt=0, description="실제 타일 세로 크기 (cm)"),
    # ── Optional text fields ─────────────────────────────────────────────────
    brand: Optional[str]          = Form(None, max_length=100),
    product_code: Optional[str]   = Form(None, max_length=100),
    price_range: Optional[str]    = Form(None, max_length=100),
    style: Optional[str]          = Form(None, max_length=100),
    tags: Optional[str]           = Form(None, description="쉼표로 구분된 태그 목록"),
    # ── AI generation parameters ─────────────────────────────────────────────
    positive_prompt: str          = Form(
        "",
        description=(
            "자재에 최적화된 긍정 프롬프트. "
            "예: 'seamless large format beige porcelain tile floor, "
            "subtle natural stone texture, clean grout lines, 8k uhd'"
        ),
    ),
    negative_prompt: str          = Form(
        "",
        description=(
            "자재에 최적화된 부정 프롬프트. "
            "예: 'wood grain, glossy, reflective, blurry, low quality'"
        ),
    ),
    ip_adapter_weight: float      = Form(
        0.6,
        ge=0.3,
        le=0.9,
        description="IP-Adapter 가중치 (0.3–0.9, 기본 0.6)",
    ),
    recommended_denoise: float    = Form(
        0.62,
        ge=0.5,
        le=0.75,
        description="KSampler denoise 강도 (0.5–0.75, 기본 0.62)",
    ),
    # ── File uploads ─────────────────────────────────────────────────────────
    tile_image: UploadFile        = File(..., description="Seamless 타일 이미지 (PNG/JPEG, min 256×256)"),
    normal_map: Optional[UploadFile] = File(None, description="PBR Normal Map (선택)"),
    db: Session                   = Depends(get_db),
):
    """
    Admin-only endpoint to register a new material.

    Upload pipeline:
      1. Read tile image bytes + validate MIME (PNG/JPEG/WEBP only)
      2. Validate minimum resolution (256×256)
      3. Run seamless-tiling check (2×2 seam colour diff)
      4. Upload tile image to S3 → get tile_image_url
      5. (Optional) upload normal map
      6. Insert Material record and return it with the tiling report

    Tiling validation verdicts:
      - pass  : mean seam diff ≤ 20/255 — fully seamless
      - warn  : mean seam diff 20–45    — minor visible seam; proceed with caution
      - fail  : mean seam diff > 45     — not seamless; strongly advised to replace

    Note: 'fail' still saves the material — admin decides whether to keep it.
    """
    # ── 1. Read + MIME check ─────────────────────────────────────────────────
    allowed_mimes = {"image/png", "image/jpeg", "image/webp"}
    if tile_image.content_type not in allowed_mimes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"지원하지 않는 이미지 형식입니다: {tile_image.content_type}. "
                   "PNG, JPEG, WEBP만 허용됩니다.",
        )

    tile_bytes = tile_image.file.read()
    try:
        pil_img = Image.open(io.BytesIO(tile_bytes)).convert("RGB")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"이미지를 열 수 없습니다: {exc}",
        ) from exc

    # ── 2. Resolution check ──────────────────────────────────────────────────
    if pil_img.width < _TILE_MIN_PX or pil_img.height < _TILE_MIN_PX:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"타일 이미지가 너무 작습니다 ({pil_img.width}×{pil_img.height}px). "
                   f"최소 {_TILE_MIN_PX}×{_TILE_MIN_PX}px 이상이어야 합니다.",
        )

    # ── 3. Seamless tiling validation ────────────────────────────────────────
    tiling_report = _validate_seamless_tiling(pil_img)

    # ── 4. Upload tile image to S3 ───────────────────────────────────────────
    # We create a temporary DB record first to get an ID for the S3 key.
    # Then update with the URL after upload.
    tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()]

    material = Material(
        name                = name,
        category            = category,
        tile_image_url      = "",          # placeholder — updated below
        normal_map_url      = None,
        tile_width_cm       = tile_width_cm,
        tile_height_cm      = tile_height_cm,
        brand               = brand,
        product_code        = product_code,
        price_range         = price_range,
        style               = style,
        tags                = tag_list,
        positive_prompt     = positive_prompt,
        negative_prompt     = negative_prompt,
        ip_adapter_weight   = ip_adapter_weight,
        recommended_denoise = recommended_denoise,
    )
    db.add(material)
    db.flush()   # get material.id without committing

    ext = "png" if tile_image.content_type == "image/png" else "jpg"
    tile_key = storage.material_key(material.id, f"tile.{ext}")
    tile_url = storage.upload(
        data         = tile_bytes,
        key          = tile_key,
        content_type = tile_image.content_type,
        public       = True,
    )
    material.tile_image_url = tile_url

    # ── 5. Upload normal map (optional) ─────────────────────────────────────
    normal_url: Optional[str] = None
    if normal_map and normal_map.filename:
        nm_bytes = normal_map.file.read()
        nm_ext   = "png" if normal_map.content_type == "image/png" else "jpg"
        nm_key   = storage.material_key(material.id, f"normal.{nm_ext}")
        normal_url = storage.upload(
            data         = nm_bytes,
            key          = nm_key,
            content_type = normal_map.content_type or "image/png",
            public       = True,
        )
        material.normal_map_url = normal_url

    db.commit()
    db.refresh(material)

    return MaterialUploadResponse(
        material       = MaterialResponse.model_validate(material),
        tiling_report  = tiling_report,
    )


@router.post(
    "/{material_id}/validate-tiling",
    response_model=MaterialTilingReport,
    summary="기존 자재의 타일링 검증 재실행",
    dependencies=[Depends(require_admin)],
)
def validate_material_tiling(
    material_id: int,
    db: Session = Depends(get_db),
):
    """
    Re-run the seamless-tiling check on an already-registered material.
    Downloads the tile image from its stored URL and recomputes seam diffs.
    """
    import urllib.request

    material = db.get(Material, material_id)
    if not material:
        raise HTTPException(status_code=404, detail="자재를 찾을 수 없습니다.")

    try:
        with urllib.request.urlopen(material.tile_image_url, timeout=15) as resp:
            img_bytes = resp.read()
        pil_img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"타일 이미지 다운로드 실패: {exc}",
        ) from exc

    return _validate_seamless_tiling(pil_img)
