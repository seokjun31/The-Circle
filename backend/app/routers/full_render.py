"""
Full Render & Layer Management — API endpoints

GET    /api/v1/projects/{id}/layers                  — 레이어 목록
PATCH  /api/v1/projects/{id}/layers/{layer_id}       — 레이어 업데이트 (visibility / order)
DELETE /api/v1/projects/{id}/layers/{layer_id}       — 레이어 삭제
POST   /api/v1/projects/{id}/full-render             — 최종 고품질 렌더링 (SSE streaming)
"""
from __future__ import annotations

import json
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_db
from app.models.edit_layer import EditLayer
from app.models.project import Project
from app.models.user import User
from app.schemas.edit_layer import EditLayerResponse
from app.services.full_render import CREDITS_FULL_RENDER, full_render_service

router = APIRouter(tags=["Full Render"])


# ═══════════════════════════════════════════════════════════════════════════════
#  Layer management
# ═══════════════════════════════════════════════════════════════════════════════

# ── GET /projects/{id}/layers ─────────────────────────────────────────────────

class LayerListResponse(BaseModel):
    layers: List[EditLayerResponse]
    total:  int


@router.get(
    "/projects/{project_id}/layers",
    response_model=LayerListResponse,
    summary="프로젝트 레이어 목록",
)
def list_layers(
    project_id: int,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """Return all EditLayers for a project ordered by `order`."""
    _assert_owner(project_id, current_user, db)
    layers = (
        db.query(EditLayer)
        .filter(EditLayer.project_id == project_id)
        .order_by(EditLayer.order)
        .all()
    )
    return LayerListResponse(layers=layers, total=len(layers))


# ── PATCH /projects/{id}/layers/{layer_id} ────────────────────────────────────

class LayerUpdateRequest(BaseModel):
    is_visible: Optional[bool] = None
    order:      Optional[int]  = Field(None, ge=0)
    name:       Optional[str]  = Field(None, max_length=100)


@router.patch(
    "/projects/{project_id}/layers/{layer_id}",
    response_model=EditLayerResponse,
    summary="레이어 업데이트 (가시성 / 순서)",
)
def update_layer(
    project_id: int,
    layer_id:   int,
    body:       LayerUpdateRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """Toggle layer visibility or change its stacking order."""
    _assert_owner(project_id, current_user, db)
    layer = _get_layer(project_id, layer_id, db)

    if body.is_visible is not None:
        layer.is_visible = body.is_visible
    if body.order is not None:
        layer.order = body.order
    if body.name is not None:
        params = dict(layer.parameters or {})
        params["name"] = body.name
        layer.parameters = params

    db.commit()
    db.refresh(layer)
    return layer


# ── DELETE /projects/{id}/layers/{layer_id} ───────────────────────────────────

@router.delete(
    "/projects/{project_id}/layers/{layer_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="레이어 삭제",
)
def delete_layer(
    project_id: int,
    layer_id:   int,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """Permanently remove a layer from the project."""
    _assert_owner(project_id, current_user, db)
    layer = _get_layer(project_id, layer_id, db)
    db.delete(layer)
    db.commit()


# ═══════════════════════════════════════════════════════════════════════════════
#  Full Render — SSE streaming
# ═══════════════════════════════════════════════════════════════════════════════

class FullRenderRequest(BaseModel):
    lighting: str = Field(
        "morning",
        description="조명 환경: morning | evening | night",
    )


@router.post(
    "/projects/{project_id}/full-render",
    summary="최종 고품질 렌더링 — SSE streaming (text/event-stream)",
    response_class=StreamingResponse,
    responses={
        200: {
            "description": "SSE stream of progress events. Final event has `done: true`.",
            "content": {"text/event-stream": {}},
        },
        402: {"description": "크레딧 부족"},
    },
)
def run_full_render(
    project_id: int,
    body:       FullRenderRequest,
    db:           Session = Depends(get_db),
    current_user: User    = Depends(get_current_user),
):
    """
    Start the full-quality render pipeline and stream progress via Server-Sent Events.

    Pipeline: SDXL Base (40 steps) → Refiner → Real-ESRGAN 2× Upscale.

    **Credit cost:** {credits} credits (~60 s)

    **SSE event format:**
    ```json
    {{ "progress": 0-100, "step": "단계 설명...", "done": false }}
    ```
    On completion:
    ```json
    {{ "done": true, "result_url": "...", "layer_id": 42, "elapsed_s": 38.2, ... }}
    ```
    """.format(credits=CREDITS_FULL_RENDER)

    # ── Credit check & deduction (before streaming) ───────────────────────────
    if current_user.credit_balance < CREDITS_FULL_RENDER:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "message": (
                    f"크레딧이 부족합니다. "
                    f"(잔액: {current_user.credit_balance}, 필요: {CREDITS_FULL_RENDER})"
                ),
                "code":     "INSUFFICIENT_CREDITS",
                "balance":  current_user.credit_balance,
                "required": CREDITS_FULL_RENDER,
            },
        )

    current_user.credit_balance -= CREDITS_FULL_RENDER
    db.commit()

    async def event_stream():
        got_done = False
        try:
            async for chunk in full_render_service.render_stream(
                project_id = project_id,
                user_id    = current_user.id,
                db         = db,
                lighting   = body.lighting,
            ):
                yield chunk
                try:
                    payload = json.loads(chunk.removeprefix("data: ").strip())
                    if payload.get("done") or payload.get("error"):
                        got_done = True
                        if payload.get("error"):
                            current_user.credit_balance += CREDITS_FULL_RENDER
                            db.commit()
                except Exception:
                    pass
        except Exception as exc:
            error_msg = f"렌더링 스트림 오류: {exc}"
            yield f"data: {json.dumps({'error': error_msg, 'code': 'STREAM_ERROR'}, ensure_ascii=False)}\n\n"
            if not got_done:
                current_user.credit_balance += CREDITS_FULL_RENDER
                db.commit()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _assert_owner(project_id: int, user: User, db: Session) -> Project:
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


def _get_layer(project_id: int, layer_id: int, db: Session) -> EditLayer:
    layer = db.query(EditLayer).filter(
        EditLayer.id == layer_id,
        EditLayer.project_id == project_id,
    ).first()
    if layer is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"message": f"레이어 {layer_id}를 찾을 수 없습니다.", "code": "NOT_FOUND"},
        )
    return layer
