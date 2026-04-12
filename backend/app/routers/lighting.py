"""
Lighting — 조명 변환 API

POST /api/v1/projects/{id}/lighting  — 조명 프리셋으로 방 분위기 조정
"""

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import update as sa_update
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_db
from app.models.project import Project
from app.models.user import User
from app.services.comfyui.runpod_client import RunPodError
from app.services.lighting import CREDITS_PER_LIGHTING, lighting_service

router = APIRouter(tags=["Lighting"])


# ─────────────────────────────────────────────────────────────────────────────
#  POST /projects/{id}/lighting
# ─────────────────────────────────────────────────────────────────────────────


class LightingRequest(BaseModel):
    lighting: str = Field(
        "morning",
        description="조명 프리셋: morning | evening | night",
    )
    strength: float = Field(
        0.35,
        ge=0.25,
        le=0.45,
        description="조명 변환 강도 (0.25=은은, 0.45=뚜렷)",
    )


class LightingResponse(BaseModel):
    result_url: str
    layer_id: int
    elapsed_s: float
    lighting: str
    credits_used: int
    remaining_balance: int


@router.post(
    "/projects/{project_id}/lighting",
    response_model=LightingResponse,
    summary="조명 변환 — 조명 프리셋으로 방 분위기 조정",
)
async def apply_lighting(
    project_id: int,
    body: LightingRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Apply a lighting atmosphere (morning / evening / night) to the current room state.

    Composites all visible layers first, then applies SDXL img2img with low denoise
    to shift the lighting while preserving room structure.
    Deducts **{credits}** credits before processing.

    Expected response time: 15–25 s.
    """.format(credits=CREDITS_PER_LIGHTING)

    _get_owned_project(project_id, current_user, db)

    if current_user.credit_balance < CREDITS_PER_LIGHTING:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "message": (
                    f"크레딧이 부족합니다. "
                    f"(잔액: {current_user.credit_balance}, 필요: {CREDITS_PER_LIGHTING})"
                ),
                "code": "INSUFFICIENT_CREDITS",
                "balance": current_user.credit_balance,
                "required": CREDITS_PER_LIGHTING,
            },
        )

    current_user.credit_balance -= CREDITS_PER_LIGHTING
    db.commit()

    user_id = current_user.id

    try:
        result = await lighting_service.apply_lighting(
            project_id=project_id,
            user_id=user_id,
            db=db,
            lighting=body.lighting,
            strength=body.strength,
        )
    except ValueError as exc:
        _refund_credits(db, user_id, CREDITS_PER_LIGHTING)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"message": str(exc), "code": "INVALID_INPUT"},
        ) from exc
    except RunPodError as exc:
        _refund_credits(db, user_id, CREDITS_PER_LIGHTING)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"message": f"AI 처리 실패: {exc}", "code": "COMFYUI_ERROR"},
        ) from exc
    except Exception as exc:
        _refund_credits(db, user_id, CREDITS_PER_LIGHTING)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"message": f"처리 중 오류 발생: {exc}", "code": "INTERNAL_ERROR"},
        ) from exc

    db.refresh(current_user)
    return LightingResponse(
        result_url=result.result_url,
        layer_id=result.layer_id,
        elapsed_s=result.elapsed_s,
        lighting=result.lighting,
        credits_used=CREDITS_PER_LIGHTING,
        remaining_balance=current_user.credit_balance,
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
