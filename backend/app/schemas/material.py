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
    # ── AI generation parameters ─────────────────────────────────────────────
    positive_prompt: str = Field(
        default="",
        description=(
            "자재에 최적화된 긍정 프롬프트. "
            "예: 'seamless large format beige porcelain tile floor, "
            "cotton beige tone, subtle natural stone texture, "
            "clean grout lines, uniform matte finish, "
            "photorealistic interior floor, 8k uhd'"
        ),
    )
    negative_prompt: str = Field(
        default="",
        description=(
            "자재에 최적화된 부정 프롬프트. "
            "예: 'wood grain, wood planks, glossy, reflective, wet, cracked, "
            "dirty, blurry, low quality, distorted, cartoon, painting'"
        ),
    )
    ip_adapter_weight: float = Field(
        default=0.6,
        ge=0.3,
        le=0.9,
        description=(
            "IP-Adapter 가중치 (범위 0.3–0.9). "
            "패턴이 뚜렷한 자재(대리석, 나무결): 0.5–0.65 | "
            "단색/무지(페인트, 무광 타일): 0.4–0.55 | "
            "복잡한 패턴(모자이크, 헤링본): 0.6–0.75"
        ),
    )
    recommended_denoise: float = Field(
        default=0.62,
        ge=0.5,
        le=0.75,
        description=(
            "KSampler denoise 강도 (범위 0.5–0.75). "
            "원본과 비슷한 톤: 0.5–0.58 | "
            "다른 톤: 0.60–0.68 | "
            "대폭 변경(밝은색→어두운색): 0.65–0.75"
        ),
    )


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
    # AI generation parameters
    positive_prompt: str
    negative_prompt: str
    ip_adapter_weight: float
    recommended_denoise: float
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
    mean_diff: float  # mean absolute colour diff at seams (0–255)
    vertical_seam_diff: float  # diff at left↔right boundary
    horizontal_seam_diff: float  # diff at top↔bottom boundary
    message: str  # human-readable verdict
    width_px: int
    height_px: int


class MaterialUploadResponse(BaseModel):
    """Returned by POST /materials (admin upload endpoint)."""

    material: MaterialResponse
    tiling_report: MaterialTilingReport


# ── Claude Vision 프롬프트 자동 생성 ──────────────────────────────────────────


class MaterialGeneratePromptsRequest(BaseModel):
    """POST /materials/generate-prompts 요청 바디."""

    image_url: str = Field(
        description="분석할 자재 타일 이미지 URL (S3 URL 또는 공개 HTTP URL)",
    )
    category: str = Field(
        description="자재 카테고리 (wallpaper/flooring/ceiling/tile/paint)",
    )
    name: str = Field(
        min_length=1,
        max_length=200,
        description="자재명 (한국어/영어 모두 가능). 프롬프트 품질에 영향.",
    )


class MaterialGeneratePromptsResponse(BaseModel):
    """POST /materials/generate-prompts 응답 바디."""

    positive_prompt: str = Field(
        description="자재에 최적화된 ComfyUI 긍정 프롬프트",
    )
    negative_prompt: str = Field(
        description="자재에 최적화된 ComfyUI 부정 프롬프트",
    )
    ip_adapter_weight: float = Field(
        ge=0.3,
        le=0.9,
        description="IP-Adapter 권장 가중치 (0.3–0.9)",
    )
    recommended_denoise: float = Field(
        ge=0.5,
        le=0.75,
        description="KSampler 권장 denoise 강도 (0.5–0.75)",
    )
    generated_by_ai: bool = Field(
        description="True: Claude Vision으로 생성. False: ANTHROPIC_API_KEY 미설정 또는 오류 → 카테고리 기본값 반환.",
    )
    model: Optional[str] = Field(
        default=None,
        description="사용된 Claude 모델 ID (generated_by_ai=False 이면 null)",
    )
