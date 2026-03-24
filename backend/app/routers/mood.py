"""
Mood — 분위기 변환 API

POST /api/v1/projects/{id}/mood  — 참조 이미지의 분위기를 내 방에 적용
"""
import asyncio

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_db
from app.models.project import Project
from app.models.user import User
from app.services.comfyui.runpod_client import RunPodError
from app.services.mood import CREDITS_PER_MOOD, mood_service

router = APIRouter(tags=["Mood"])


# ─────────────────────────────────────────────────────────────────────────────
#  POST /projects/{id}/mood
# ─────────────────────────────────────────────────────────────────────────────

class MoodRequest(BaseModel):
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


class MoodResponse(BaseModel):
    result_url:        str
    layer_id:          int
    elapsed_s:         float
    credits_used:      int
    remaining_balance: int


@router.post(
    "/projects/{project_id}/mood",
    response_model=MoodResponse,
    summary="분위기 변환 — 참조 이미지의 분위기를 내 방에 적용",
)
def apply_mood(
    project_id:   int,
    body:         MoodRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Copy the mood, lighting, and atmosphere of a reference image onto the room.

    Uses IP-Adapter (style transfer) + SDXL img2img (structure preservation).
    Accepts the reference image as an HTTP URL or base64 string.
    Deducts **{credits}** credits before processing.

    Expected response time: 20–40 s.
    """.format(credits=CREDITS_PER_MOOD)

    _get_owned_project(project_id, current_user, db)

    if current_user.credit_balance < CREDITS_PER_MOOD:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "message": (
                    f"크레딧이 부족합니다. "
                    f"(잔액: {current_user.credit_balance}, 필요: {CREDITS_PER_MOOD})"
                ),
                "code":     "INSUFFICIENT_CREDITS",
                "balance":  current_user.credit_balance,
                "required": CREDITS_PER_MOOD,
            },
        )

    current_user.credit_balance -= CREDITS_PER_MOOD
    db.commit()

    try:
        result = asyncio.run(
            mood_service.apply_mood(
                project_id      = project_id,
                reference_image = body.reference_image,
                user_id         = current_user.id,
                db              = db,
                strength        = body.strength,
            )
        )
    except ValueError as exc:
        current_user.credit_balance += CREDITS_PER_MOOD
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"message": str(exc), "code": "INVALID_INPUT"},
        ) from exc
    except RunPodError as exc:
        current_user.credit_balance += CREDITS_PER_MOOD
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"message": f"AI 처리 실패: {exc}", "code": "RUNPOD_ERROR"},
        ) from exc

    db.refresh(current_user)
    return MoodResponse(
        result_url        = result.result_url,
        layer_id          = result.layer_id,
        elapsed_s         = result.elapsed_s,
        credits_used      = CREDITS_PER_MOOD,
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
