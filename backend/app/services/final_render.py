"""
FinalRenderService — composite all visible EditLayers and run high-quality SDXL render.

Pipeline
--------
1.  Load project original image (PIL)
2.  Collect all is_visible=True EditLayers ordered by `order`
3.  Composite layers onto the base image:
    - style layer   → use result_image_url as new base (full-room restyle)
    - material layer→ blend result into composite using the stored mask PNG
    - furniture layer→ paste the AI-blended result at the stored bounding box
4.  Build `build_final_render_workflow()` with the composited image + lighting prompt
5.  Submit to RunPod (SSE-friendly: yields progress messages via async generator)
6.  Save result to S3
7.  Create EditLayer(layer_type=style, parameters={source: "final_render"})
8.  Yield final result JSON

Lighting prompts
----------------
    morning : bright natural morning light, sun rays through window, warm golden tone
    evening : warm evening ambient light, cozy atmosphere, soft shadows
    night   : night time interior, artificial warm lighting, table lamps, cozy ambient

Credit costs
------------
    standard : 3 credits  (steps=25, denoise=0.25, no upscale)
    high     : 5 credits  (steps=40, denoise=0.30, + refiner + 2× upscale)
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import time
import uuid
from dataclasses import dataclass
from typing import AsyncIterator, Optional

import httpx
from PIL import Image
from sqlalchemy.orm import Session

from app.models.edit_layer import EditLayer, LayerType
from app.models.project import Project, ProjectStatus
from app.services.comfyui.runpod_client import RunPodClient, RunPodError
from app.services.comfyui.workflow_manager import WorkflowManager
from app.services.s3 import storage

logger = logging.getLogger("the_circle.final_render")

CREDITS_STANDARD = 3
CREDITS_HIGH     = 5

_LIGHTING_PROMPTS: dict[str, str] = {
    "morning": "bright natural morning light, sun rays through window, warm golden tone, photorealistic",
    "evening": "warm evening ambient light, cozy atmosphere, warm color temperature, soft shadows, photorealistic",
    "night":   "night time interior, artificial warm lighting, table lamps turned on, cozy ambient, photorealistic",
}

_RENDER_TIMEOUT_S = 120


# ── Result type ───────────────────────────────────────────────────────────────

@dataclass
class FinalRenderResult:
    result_url:  str
    layer_id:    int
    elapsed_s:   float
    quality:     str
    lighting:    str
    credits_used: int


# ── Image helpers ─────────────────────────────────────────────────────────────

def _load_pil(url: str) -> Image.Image:
    resp = httpx.get(url, timeout=20, follow_redirects=True)
    resp.raise_for_status()
    return Image.open(io.BytesIO(resp.content))


def _pil_to_b64(img: Image.Image, fmt: str = "JPEG") -> str:
    buf = io.BytesIO()
    if fmt == "JPEG":
        img = img.convert("RGB")
    img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _sse_event(data: dict) -> str:
    """Format a dict as an SSE data line."""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


# ── Layer compositing ─────────────────────────────────────────────────────────

def _composite_layers(original_url: str, layers: list[EditLayer]) -> Image.Image:
    """
    Build a composite PIL image from the original + all visible layers.

    Strategy
    --------
    1. Start with the original room image.
    2. If any `style` layer exists, use the latest (highest order) as the new
       base — it already encodes the full-room restyle.
    3. For each `wall`/`floor`/`ceiling` (material) layer that has both a mask
       and a result image: blend the result into the composite using the mask.
    4. For each `furniture` layer with a result image: crop the furniture
       bounding-box region from the AI-blended result and paste it onto the
       composite (preserves multi-furniture stacking without re-running AI).
    """
    logger.info("composite: loading original from %s", original_url)
    base = _load_pil(original_url).convert("RGBA")
    canvas_w, canvas_h = base.size

    # ── 1. Style layers → replace base ───────────────────────────────────────
    style_layers = [
        l for l in layers
        if l.layer_type == LayerType.style and l.result_image_url
    ]
    if style_layers:
        # Use the last applied visible style result as the new base
        latest = style_layers[-1]
        logger.info("composite: using style layer %d as base", latest.id)
        base = _load_pil(latest.result_image_url).convert("RGBA")

    # ── 2. Material layers → mask-blend result into base ─────────────────────
    material_types = {LayerType.wall, LayerType.floor, LayerType.ceiling}
    for layer in layers:
        if layer.layer_type not in material_types:
            continue
        if not layer.result_image_url:
            continue

        mask_url: Optional[str] = layer.parameters.get("mask_url")
        if not mask_url:
            # No mask stored — skip to avoid corrupting the composite
            logger.warning("material layer %d has no mask_url, skipping", layer.id)
            continue

        try:
            mat_result = _load_pil(layer.result_image_url).convert("RGBA")
            mask_img   = _load_pil(mask_url).convert("L")

            # Ensure same size as base
            if mat_result.size != base.size:
                mat_result = mat_result.resize(base.size, Image.LANCZOS)
            if mask_img.size != base.size:
                mask_img = mask_img.resize(base.size, Image.LANCZOS)

            # Composite: where mask is white → use mat_result; black → keep base
            base.paste(mat_result, (0, 0), mask=mask_img)
            logger.info("composite: applied material layer %d", layer.id)
        except Exception as exc:
            logger.warning("material layer %d composite failed: %s", layer.id, exc)

    # ── 3. Furniture layers → paste bounding box from blended result ──────────
    for layer in layers:
        if layer.layer_type != LayerType.furniture:
            continue
        if not layer.result_image_url:
            continue

        params = layer.parameters
        px = params.get("position_x")
        py = params.get("position_y")
        pw = params.get("target_width_px")
        ph = params.get("target_height_px")

        if None in (px, py, pw, ph):
            # No position info — just use the whole result as new base
            logger.info("furniture layer %d: no bbox, using full result as base", layer.id)
            try:
                furn_result = _load_pil(layer.result_image_url).convert("RGBA")
                if furn_result.size != base.size:
                    furn_result = furn_result.resize(base.size, Image.LANCZOS)
                base = furn_result
            except Exception as exc:
                logger.warning("furniture layer %d (no bbox) failed: %s", layer.id, exc)
            continue

        try:
            furn_result = _load_pil(layer.result_image_url).convert("RGBA")
            if furn_result.size != base.size:
                furn_result = furn_result.resize(base.size, Image.LANCZOS)

            # Crop the furniture bounding region (+ 60px dilation for blending seam)
            dil = 60
            x0 = max(0, int(px) - dil)
            y0 = max(0, int(py) - dil)
            x1 = min(canvas_w, int(px) + int(pw) + dil)
            y1 = min(canvas_h, int(py) + int(ph) + dil)

            region = furn_result.crop((x0, y0, x1, y1))
            base.paste(region, (x0, y0))
            logger.info(
                "composite: applied furniture layer %d at (%d,%d)+(%d×%d)",
                layer.id, x0, y0, x1 - x0, y1 - y0,
            )
        except Exception as exc:
            logger.warning("furniture layer %d composite failed: %s", layer.id, exc)

    return base


# ── Service ───────────────────────────────────────────────────────────────────

class FinalRenderService:
    """Run the final render pipeline, yielding SSE progress events."""

    def __init__(self) -> None:
        self._wm     = WorkflowManager()
        self._runpod = RunPodClient()

    async def render_final_stream(
        self,
        project_id:  int,
        user_id:     int,
        db:          Session,
        lighting:    str = "morning",
        quality:     str = "standard",
    ) -> AsyncIterator[str]:
        """
        Async generator that yields SSE-formatted strings.

        Each yielded value is a ``data: {...}\\n\\n`` string.  The final event
        carries ``{ done: true, result_url, layer_id, ... }`` on success, or
        ``{ error: "..." }`` on failure.
        """
        t_start = time.monotonic()
        credits_used = CREDITS_STANDARD if quality == "standard" else CREDITS_HIGH

        # ── Validate project ──────────────────────────────────────────────────
        project = db.query(Project).filter(
            Project.id == project_id,
            Project.user_id == user_id,
        ).first()
        if not project:
            yield _sse_event({"error": f"프로젝트 {project_id}를 찾을 수 없습니다.", "code": "NOT_FOUND"})
            return
        if not project.original_image_url:
            yield _sse_event({"error": "원본 이미지가 없습니다.", "code": "NO_IMAGE"})
            return

        # ── Validate lighting ─────────────────────────────────────────────────
        if lighting not in _LIGHTING_PROMPTS:
            yield _sse_event({
                "error": f"조명 값이 올바르지 않습니다: {lighting!r}. "
                         f"가능한 값: {list(_LIGHTING_PROMPTS)}",
                "code": "INVALID_LIGHTING",
            })
            return

        yield _sse_event({"progress": 5, "step": "레이어 분석 중..."})
        await asyncio.sleep(0)

        # ── Collect visible layers ────────────────────────────────────────────
        layers = (
            db.query(EditLayer)
            .filter(
                EditLayer.project_id == project_id,
                EditLayer.is_visible == True,  # noqa: E712
            )
            .order_by(EditLayer.order)
            .all()
        )

        logger.info(
            "final_render START: project=%d layers=%d lighting=%s quality=%s",
            project_id, len(layers), lighting, quality,
        )

        yield _sse_event({"progress": 15, "step": f"레이어 {len(layers)}개 합성 중..."})
        await asyncio.sleep(0)

        # ── Composite layers ──────────────────────────────────────────────────
        try:
            composite = await asyncio.get_event_loop().run_in_executor(
                None,
                _composite_layers,
                project.original_image_url,
                layers,
            )
        except Exception as exc:
            logger.exception("Compositing failed")
            yield _sse_event({"error": f"레이어 합성 실패: {exc}", "code": "COMPOSITE_ERROR"})
            return

        yield _sse_event({"progress": 35, "step": "AI 렌더링 준비 중..."})
        await asyncio.sleep(0)

        # ── Build workflow ────────────────────────────────────────────────────
        composite_b64 = await asyncio.get_event_loop().run_in_executor(
            None, _pil_to_b64, composite, "JPEG"
        )
        lighting_prompt = _LIGHTING_PROMPTS[lighting]
        is_high = quality == "high"

        workflow = await self._wm.build_final_render_workflow(
            image_url     = composite_b64,
            lighting      = lighting_prompt,
            quality       = quality,
            base_denoise  = 0.30 if is_high else 0.25,
            base_steps    = 40 if is_high else 25,
            refiner_steps = 10 if is_high else 0,
            upscale       = is_high,
        )

        yield _sse_event({"progress": 45, "step": "AI 렌더링 실행 중..." })
        await asyncio.sleep(0)

        # ── Submit to RunPod ──────────────────────────────────────────────────
        project.status = ProjectStatus.processing
        db.commit()

        # Start RunPod job in background, stream synthetic progress while waiting
        runpod_task = asyncio.create_task(
            self._runpod.run_async(
                workflow      = workflow,
                timeout       = _RENDER_TIMEOUT_S,
                upload_result = False,
            )
        )

        # Synthetic progress: 45 → 90 over the expected render time
        expected_s = 60 if is_high else 25
        progress_step = 45.0 / expected_s  # points per second (45 → 90)
        current_progress = 45
        step_labels = [
            "Depth map 분석 중...",
            "SDXL Base 렌더링 중...",
            "디테일 강화 중...",
            "후처리 중...",
        ]
        label_idx = 0

        while not runpod_task.done():
            await asyncio.sleep(1)
            current_progress = min(90, current_progress + progress_step)
            if label_idx < len(step_labels) - 1 and current_progress > 45 + (label_idx + 1) * 12:
                label_idx += 1
            yield _sse_event({
                "progress": int(current_progress),
                "step": step_labels[min(label_idx, len(step_labels) - 1)],
            })

        try:
            output = await runpod_task
        except RunPodError:
            project.status = ProjectStatus.error
            db.commit()
            yield _sse_event({"error": "AI 렌더링에 실패했습니다. 잠시 후 다시 시도해주세요.", "code": "RUNPOD_ERROR"})
            return

        yield _sse_event({"progress": 92, "step": "결과 이미지 저장 중..."})
        await asyncio.sleep(0)

        # ── Save result ───────────────────────────────────────────────────────
        img_b64_out: Optional[str] = output.get("image_base64")
        if not img_b64_out:
            project.status = ProjectStatus.error
            db.commit()
            yield _sse_event({"error": "렌더링 결과가 없습니다.", "code": "NO_OUTPUT"})
            return

        try:
            result_bytes = base64.b64decode(img_b64_out)
        except Exception:
            project.status = ProjectStatus.error
            db.commit()
            yield _sse_event({"error": "결과 이미지 디코딩에 실패했습니다.", "code": "DECODE_ERROR"})
            return

        result_key = storage.project_key(
            user_id, project_id,
            f"results/final_render_{uuid.uuid4().hex[:8]}.jpg",
        )
        result_url = storage.upload(
            data         = result_bytes,
            key          = result_key,
            content_type = "image/jpeg",
            public       = True,
        )

        # ── Create EditLayer ──────────────────────────────────────────────────
        layer = EditLayer(
            project_id       = project_id,
            layer_type       = LayerType.style,
            parameters       = {
                "source":       "final_render",
                "lighting":     lighting,
                "quality":      quality,
                "credits_used": credits_used,
                "layer_count":  len(layers),
                "result_url":   result_url,
            },
            result_image_url = result_url,
            is_visible       = True,
            order            = 9999,
        )
        db.add(layer)
        project.status = ProjectStatus.completed
        db.commit()
        db.refresh(layer)

        elapsed = round(time.monotonic() - t_start, 2)
        logger.info(
            "final_render DONE: project=%d layer=%d result_url=%s elapsed=%.1fs",
            project_id, layer.id, result_url, elapsed,
        )

        yield _sse_event({
            "done":          True,
            "progress":      100,
            "step":          "완료!",
            "result_url":    result_url,
            "layer_id":      layer.id,
            "elapsed_s":     elapsed,
            "quality":       quality,
            "lighting":      lighting,
            "credits_used":  credits_used,
        })


# ── Module-level singleton ────────────────────────────────────────────────────
final_render_service = FinalRenderService()
