"""
Room Analysis — AI 공간 유형 자동 인식

POST /api/v1/projects/{id}/analyze-room
    방 유형 자동 분석 후 projects.room_type / room_type_confidence 저장.
    현재: 모크 응답 반환 (테스트용)
    추후: ComfyUI BLIP Analyze 또는 WD14 Tagger 노드로 교체 예정

PATCH /api/v1/projects/{id}/room-type
    사용자가 직접 방 유형 확인/수정.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import update as sa_update
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_db
from app.models.project import Project
from app.models.user import User

logger = logging.getLogger("the_circle.room_analysis")

router = APIRouter(tags=["Room Analysis"])

VALID_ROOM_TYPES = [
    "living room",
    "master bedroom",
    "kitchen",
    "bathroom",
    "dining room",
    "study room",
    "balcony",
    "empty room",
]

ROOM_TYPE_KR = {
    "living room":    "거실",
    "master bedroom": "안방",
    "kitchen":        "주방",
    "bathroom":       "욕실",
    "dining room":    "다이닝룸",
    "study room":     "서재",
    "balcony":        "발코니",
    "empty room":     "빈 방",
}


# ── Response schemas ───────────────────────────────────────────────────────────

class AnalyzeRoomResponse(BaseModel):
    room_type:    str
    room_type_kr: str
    confidence:   float
    project_id:   int
    is_mock:      bool = False


class UpdateRoomTypeRequest(BaseModel):
    room_type: str = Field(..., description="방 유형 (영문): living room | master bedroom | ...")


class UpdateRoomTypeResponse(BaseModel):
    project_id:   int
    room_type:    str
    room_type_kr: str


# ── POST /projects/{id}/analyze-room ──────────────────────────────────────────

@router.post(
    "/projects/{project_id}/analyze-room",
    response_model=AnalyzeRoomResponse,
    summary="방 유형 자동 인식 (현재: 모크 / 추후: ComfyUI BLIP)",
)
def analyze_room(
    project_id:   int,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    방 유형을 자동으로 분석합니다.

    **현재 동작 (테스트 모드):**
    - 모크 응답으로 "living room" 반환
    - 사용자가 다이얼로그에서 직접 수정 가능

    **추후 ComfyUI 연동 시:**
    - BLIP Analyze 노드로 이미지 캡셔닝 → 방 유형 분류
    - 또는 WD14 Tagger 노드로 태그 기반 분류
    """
    project = _get_owned_project(project_id, current_user, db)

    if not project.original_image_url:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"message": "프로젝트에 이미지가 없습니다.", "code": "NO_IMAGE"},
        )

    # ── TODO: ComfyUI BLIP / WD14 연동 후 이 블록을 실제 분석으로 교체 ──────
    # 현재는 모크 응답 반환
    room_type  = "living room"
    confidence = 0.5
    logger.info(
        "analyze_room MOCK: project=%d → room_type=%s (BLIP/WD14 연동 전 임시값)",
        project_id, room_type,
    )
    # ─────────────────────────────────────────────────────────────────────────

    # DB 저장 (모크 값이라도 저장 — 사용자가 수정 후 PATCH로 덮어씀)
    try:
        db.execute(
            sa_update(Project)
            .where(Project.id == project_id)
            .values(room_type=room_type, room_type_confidence=confidence)
        )
        db.commit()
    except Exception as exc:
        logger.error("Failed to save room_type for project %d: %s", project_id, exc)
        try:
            db.rollback()
        except Exception:
            pass

    return AnalyzeRoomResponse(
        room_type    = room_type,
        room_type_kr = ROOM_TYPE_KR[room_type],
        confidence   = confidence,
        project_id   = project_id,
        is_mock      = True,
    )


# ── PATCH /projects/{id}/room-type ────────────────────────────────────────────

@router.patch(
    "/projects/{project_id}/room-type",
    response_model=UpdateRoomTypeResponse,
    summary="방 유형 수동 확인/수정",
)
def update_room_type(
    project_id:   int,
    body:         UpdateRoomTypeRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """사용자가 확인하거나 직접 선택한 방 유형을 저장합니다."""
    _get_owned_project(project_id, current_user, db)

    room_type = body.room_type.strip().lower()
    if room_type not in VALID_ROOM_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "message": f"유효하지 않은 방 유형: {room_type}",
                "code": "INVALID_ROOM_TYPE",
                "valid": VALID_ROOM_TYPES,
            },
        )

    db.execute(
        sa_update(Project)
        .where(Project.id == project_id)
        .values(room_type=room_type, room_type_confidence=1.0)
    )
    db.commit()

    return UpdateRoomTypeResponse(
        project_id   = project_id,
        room_type    = room_type,
        room_type_kr = ROOM_TYPE_KR.get(room_type, room_type),
    )


# ── Helper ────────────────────────────────────────────────────────────────────

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
