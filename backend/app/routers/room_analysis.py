"""
Room Analysis — AI 공간 유형 자동 인식

POST /api/v1/projects/{id}/analyze-room
    Claude Vision으로 방 유형 자동 분석.
    결과를 projects.room_type / room_type_confidence 에 저장.

PATCH /api/v1/projects/{id}/room-type
    사용자가 직접 방 유형 확인/수정.
"""
import logging

import anthropic
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import update as sa_update
from sqlalchemy.orm import Session

from app.config import settings
from app.dependencies import get_current_user, get_db
from app.models.project import Project
from app.models.user import User

logger = logging.getLogger("the_circle.room_analysis")

router = APIRouter(tags=["Room Analysis"])

# Valid room types (must match the prompt)
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

# Korean labels for display
ROOM_TYPE_KR = {
    "living room":   "거실",
    "master bedroom": "안방",
    "kitchen":       "주방",
    "bathroom":      "욕실",
    "dining room":   "다이닝룸",
    "study room":    "서재",
    "balcony":       "발코니",
    "empty room":    "빈 방",
}

_VISION_PROMPT = (
    "You are a highly accurate interior space recognition AI.\n"
    "Analyze the provided image and categorize the room into one of the following exact English terms:\n"
    "['living room', 'master bedroom', 'kitchen', 'bathroom', 'dining room', 'study room', 'balcony', 'empty room']\n"
    "Rules: 1. No explanations. 2. Valid JSON only. 3. Use exact terms. 4. Confidence 0.0-1.0.\n"
    'Output: { "room_type": "selected_term", "confidence": 0.95 }'
)


# ── Response schemas ───────────────────────────────────────────────────────────

class AnalyzeRoomResponse(BaseModel):
    room_type:            str
    room_type_kr:         str
    confidence:           float
    project_id:           int


class UpdateRoomTypeRequest(BaseModel):
    room_type: str = Field(..., description="방 유형 (영문): living room | master bedroom | ...")


class UpdateRoomTypeResponse(BaseModel):
    project_id: int
    room_type:  str
    room_type_kr: str


# ── POST /projects/{id}/analyze-room ──────────────────────────────────────────

@router.post(
    "/projects/{project_id}/analyze-room",
    response_model=AnalyzeRoomResponse,
    summary="AI로 방 유형 자동 인식 (Claude Vision)",
)
async def analyze_room(
    project_id:   int,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Sends the project's original image to Claude Vision (haiku) to detect the
    room type automatically.  Saves the result to the project row and returns
    ``{ room_type, room_type_kr, confidence }``.
    """
    project = _get_owned_project(project_id, current_user, db)

    if not project.original_image_url:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"message": "프로젝트에 이미지가 없습니다.", "code": "NO_IMAGE"},
        )

    if not settings.ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"message": "Anthropic API 키가 설정되지 않았습니다.", "code": "NO_API_KEY"},
        )

    # ── Call Claude Vision ────────────────────────────────────────────────────
    try:
        client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=128,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type":       "image",
                            "source":     {
                                "type": "url",
                                "url":  project.original_image_url,
                            },
                        },
                        {
                            "type": "text",
                            "text": _VISION_PROMPT,
                        },
                    ],
                }
            ],
        )
    except Exception as exc:
        logger.error("Claude Vision call failed for project %d: %s", project_id, exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"message": f"AI 분석 실패: {exc}", "code": "AI_ERROR"},
        ) from exc

    # ── Parse response ────────────────────────────────────────────────────────
    raw_text = message.content[0].text.strip()
    logger.info("Room analysis raw response for project %d: %s", project_id, raw_text)

    import json, re
    # Extract JSON even if surrounded by code fences
    json_match = re.search(r"\{.*?\}", raw_text, re.DOTALL)
    if not json_match:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"message": f"AI 응답 파싱 실패: {raw_text[:100]}", "code": "PARSE_ERROR"},
        )

    try:
        result = json.loads(json_match.group())
        room_type  = result["room_type"].strip().lower()
        confidence = float(result["confidence"])
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"message": f"AI 응답 파싱 실패: {raw_text[:100]}", "code": "PARSE_ERROR"},
        ) from exc

    # Fallback if unrecognized
    if room_type not in VALID_ROOM_TYPES:
        room_type = "empty room"
        confidence = 0.5

    # ── Persist ───────────────────────────────────────────────────────────────
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
        room_type_kr = ROOM_TYPE_KR.get(room_type, room_type),
        confidence   = round(confidence, 3),
        project_id   = project_id,
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
    """
    Store the user-confirmed (or manually entered) room type on the project.
    """
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
