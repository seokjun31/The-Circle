"""
Circle AI & 분위기 Copy — Phase 5 API endpoints

GET  /api/v1/circle-ai/styles              — 사용 가능한 스타일 프리셋 목록
POST /api/v1/projects/{id}/circle-ai       — 스타일 프리셋으로 전체 방 변환
POST /api/v1/projects/{id}/mood-copy       — 참조 이미지 분위기를 내 방에 적용
"""
import asyncio

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_db
from app.models.project import Project
from app.models.user import User
from app.services.circle_ai import (
    CREDITS_PER_CIRCLE_AI,
    STYLE_PRESETS,
    circle_ai_service,
)
from app.services.comfyui.runpod_client import RunPodError
from app.services.mood_copy import CREDITS_PER_MOOD_COPY, mood_copy_service

router = APIRouter(tags=["Style Transform"])

# ── Style metadata (display labels + descriptions) ────────────────────────────
_STYLE_META: dict[str, dict] = {
    "modern":        {"label": "모던 미니멀",     "label_en": "Modern",        "description": "깔끔한 라인, 뉴트럴 팔레트"},
    "scandinavian":  {"label": "스칸디나비안",    "label_en": "Scandinavian",  "description": "자작나무, 울 텍스타일, 아늑한 분위기"},
    "classic":       {"label": "클래식 엘레강스", "label_en": "Classic",       "description": "몰딩, 월넛 가구, 샹들리에"},
    "industrial":    {"label": "인더스트리얼",    "label_en": "Industrial",    "description": "노출 벽돌, 금속 배관, 에디슨 전구"},
    "korean_modern": {"label": "한국 모던",       "label_en": "Korean Modern", "description": "따뜻한 마루, 심플한 레이아웃"},
    "japanese":      {"label": "재패니즈 젠",     "label_en": "Japanese",      "description": "다다미, 쇼지 스크린, 자연 소재"},
    "coastal":       {"label": "코스탈",          "label_en": "Coastal",       "description": "화이트 & 블루, 라탄 가구"},
    "art_deco":      {"label": "아르데코",         "label_en": "Art Deco",      "description": "기하학 패턴, 골드 포인트, 벨벳"},
}


# ─────────────────────────────────────────────────────────────────────────────
#  GET /circle-ai/styles
# ─────────────────────────────────────────────────────────────────────────────

class StylePresetInfo(BaseModel):
    id:          str
    label:       str
    label_en:    str
    description: str
    prompt:      str
    credits:     int


@router.get(
    "/circle-ai/styles",
    response_model=list[StylePresetInfo],
    summary="Circle AI 스타일 프리셋 목록 (인증 불필요)",
)
def list_styles():
    """Return all available style presets with display metadata."""
    return [
        StylePresetInfo(
            id          = key,
            label       = meta["label"],
            label_en    = meta["label_en"],
            description = meta["description"],
            prompt      = STYLE_PRESETS[key],
            credits     = CREDITS_PER_CIRCLE_AI,
        )
        for key, meta in _STYLE_META.items()
    ]


# ─────────────────────────────────────────────────────────────────────────────
#  POST /projects/{id}/circle-ai
# ─────────────────────────────────────────────────────────────────────────────

class CircleAIRequest(BaseModel):
    style_preset: str = Field(
        ...,
        description=f"스타일 프리셋 키. 가능한 값: {list(_STYLE_META)}",
    )
    strength: float = Field(
        0.6,
        ge=0.3,
        le=0.8,
        description="변환 강도 (0.3=원본 유지, 0.8=강한 변환)",
    )


class StyleTransformResponse(BaseModel):
    result_url:        str
    layer_id:          int
    elapsed_s:         float
    style_preset:      str
    credits_used:      int
    remaining_balance: int


@router.post(
    "/projects/{project_id}/circle-ai",
    response_model=StyleTransformResponse,
    summary="Circle AI — 스타일 프리셋으로 전체 방 분위기 변환",
)
def run_circle_ai(
    project_id: int,
    body:       CircleAIRequest,
    db:         Session = Depends(get_db),
    current_user: User  = Depends(get_current_user),
):
    """
    Transform the entire room image to match a chosen style preset.

    Uses SDXL img2img + ControlNet Canny to preserve structure while
    changing the aesthetic.  Deducts **{credits}** credits before processing.

    Expected response time: 20–40 s (RunPod Scale-to-Zero cold start included).
    """.format(credits=CREDITS_PER_CIRCLE_AI)

    _get_owned_project(project_id, current_user, db)

    # ── Credit check & deduction ──────────────────────────────────────────────
    if current_user.credit_balance < CREDITS_PER_CIRCLE_AI:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "message": (
                    f"크레딧이 부족합니다. "
                    f"(잔액: {current_user.credit_balance}, "
                    f"필요: {CREDITS_PER_CIRCLE_AI})"
                ),
                "code":     "INSUFFICIENT_CREDITS",
                "balance":  current_user.credit_balance,
                "required": CREDITS_PER_CIRCLE_AI,
            },
        )

    current_user.credit_balance -= CREDITS_PER_CIRCLE_AI
    db.commit()

    # ── Run AI pipeline ───────────────────────────────────────────────────────
    try:
        result = asyncio.run(
            circle_ai_service.transform_room_style(
                project_id   = project_id,
                style_preset = body.style_preset,
                user_id      = current_user.id,
                db           = db,
                strength     = body.strength,
            )
        )
    except ValueError as exc:
        # Refund on validation error
        current_user.credit_balance += CREDITS_PER_CIRCLE_AI
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"message": str(exc), "code": "INVALID_INPUT"},
        ) from exc
    except RunPodError as exc:
        # Refund on AI error
        current_user.credit_balance += CREDITS_PER_CIRCLE_AI
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"message": f"AI 처리 실패: {exc}", "code": "RUNPOD_ERROR"},
        ) from exc

    db.refresh(current_user)
    return StyleTransformResponse(
        result_url        = result.result_url,
        layer_id          = result.layer_id,
        elapsed_s         = result.elapsed_s,
        style_preset      = result.style_preset,
        credits_used      = CREDITS_PER_CIRCLE_AI,
        remaining_balance = current_user.credit_balance,
    )


# ─────────────────────────────────────────────────────────────────────────────
#  POST /projects/{id}/mood-copy
# ─────────────────────────────────────────────────────────────────────────────

class MoodCopyRequest(BaseModel):
    reference_image: str = Field(
        ...,
        description=(
            "참조 이미지. 다음 형식 모두 지원: "
            "HTTP/S URL, base64 data URL (data:image/jpeg;base64,...), "
            "raw base64 문자열."
        ),
    )
    strength: float = Field(
        0.5,
        ge=0.3,
        le=0.8,
        description="분위기 적용 강도 (0.3=은은, 0.8=강렬)",
    )


class MoodCopyResponse(BaseModel):
    result_url:        str
    layer_id:          int
    elapsed_s:         float
    credits_used:      int
    remaining_balance: int


@router.post(
    "/projects/{project_id}/mood-copy",
    response_model=MoodCopyResponse,
    summary="분위기 Copy — 참조 이미지의 분위기를 내 방에 적용",
)
def run_mood_copy(
    project_id: int,
    body:       MoodCopyRequest,
    db:         Session = Depends(get_db),
    current_user: User  = Depends(get_current_user),
):
    """
    Copy the mood, lighting, and atmosphere of a reference image onto the room.

    Uses IP-Adapter (style transfer) + ControlNet Depth (structure preservation).
    Accepts the reference image as an HTTP URL or base64 string.
    Deducts **{credits}** credits before processing.

    Expected response time: 20–40 s.
    """.format(credits=CREDITS_PER_MOOD_COPY)

    _get_owned_project(project_id, current_user, db)

    # ── Credit check & deduction ──────────────────────────────────────────────
    if current_user.credit_balance < CREDITS_PER_MOOD_COPY:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "message": (
                    f"크레딧이 부족합니다. "
                    f"(잔액: {current_user.credit_balance}, "
                    f"필요: {CREDITS_PER_MOOD_COPY})"
                ),
                "code":     "INSUFFICIENT_CREDITS",
                "balance":  current_user.credit_balance,
                "required": CREDITS_PER_MOOD_COPY,
            },
        )

    current_user.credit_balance -= CREDITS_PER_MOOD_COPY
    db.commit()

    # ── Run AI pipeline ───────────────────────────────────────────────────────
    try:
        result = asyncio.run(
            mood_copy_service.copy_mood(
                project_id      = project_id,
                reference_image = body.reference_image,
                user_id         = current_user.id,
                db              = db,
                strength        = body.strength,
            )
        )
    except ValueError as exc:
        current_user.credit_balance += CREDITS_PER_MOOD_COPY
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"message": str(exc), "code": "INVALID_INPUT"},
        ) from exc
    except RunPodError as exc:
        current_user.credit_balance += CREDITS_PER_MOOD_COPY
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"message": f"AI 처리 실패: {exc}", "code": "RUNPOD_ERROR"},
        ) from exc

    db.refresh(current_user)
    return MoodCopyResponse(
        result_url        = result.result_url,
        layer_id          = result.layer_id,
        elapsed_s         = result.elapsed_s,
        credits_used      = CREDITS_PER_MOOD_COPY,
        remaining_balance = current_user.credit_balance,
    )


# ── Shared helper ─────────────────────────────────────────────────────────────

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
