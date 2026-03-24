"""
LightingService — Apply a lighting atmosphere to the current room state.

Pipeline
--------
1.  Load project original image
2.  Composite all visible EditLayers
3.  Call WorkflowManager.build_lighting_workflow() → ComfyUI workflow dict
4.  Submit to RunPod via RunPodClient.run_async() (timeout: 90 s)
5.  Save result image to S3/local
6.  Create new EditLayer (layer_type=style) with result
7.  Return LightingResult

Lighting presets
----------------
    morning : bright natural morning light, sun rays through window, warm golden tone
    evening : warm evening ambient light, cozy atmosphere, soft shadows
    night   : night time interior, artificial warm lighting, table lamps, cozy ambient

Credit cost: 2 credits
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Optional

import httpx
from PIL import Image
from sqlalchemy.orm import Session

from app.models.edit_layer import EditLayer, LayerType
from app.models.project import Project, ProjectStatus
from app.services.comfyui.runpod_client import RunPodClient, RunPodError
from app.services.comfyui.workflow_manager import WorkflowManager
from app.services.s3 import storage

logger = logging.getLogger("the_circle.lighting")

CREDITS_PER_LIGHTING = 2
_LIGHTING_TIMEOUT_S  = 90

_LIGHTING_PROMPTS: dict[str, str] = {
    "morning": "bright natural morning light, sun rays through window, warm golden tone, photorealistic",
    "evening": "warm evening ambient light, cozy atmosphere, warm color temperature, soft shadows, photorealistic",
    "night":   "night time interior, artificial warm lighting, table lamps turned on, cozy ambient, photorealistic",
}


# ── Result type ───────────────────────────────────────────────────────────────

@dataclass
class LightingResult:
    result_url: str
    layer_id:   int
    elapsed_s:  float
    lighting:   str


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


def _composite_layers(original_url: str, layers: list[EditLayer]) -> Image.Image:
    """Build a composite PIL image from the original + all visible layers."""
    base = _load_pil(original_url).convert("RGBA")
    canvas_w, canvas_h = base.size

    # Style layers → replace base
    style_layers = [
        l for l in layers
        if l.layer_type == LayerType.style and l.result_image_url
    ]
    if style_layers:
        base = _load_pil(style_layers[-1].result_image_url).convert("RGBA")

    # Material layers → mask-blend
    material_types = {LayerType.wall, LayerType.floor, LayerType.ceiling}
    for layer in layers:
        if layer.layer_type not in material_types or not layer.result_image_url:
            continue
        mask_url: Optional[str] = layer.parameters.get("mask_url")
        if not mask_url:
            continue
        try:
            mat_result = _load_pil(layer.result_image_url).convert("RGBA")
            mask_img   = _load_pil(mask_url).convert("L")
            if mat_result.size != base.size:
                mat_result = mat_result.resize(base.size, Image.LANCZOS)
            if mask_img.size != base.size:
                mask_img = mask_img.resize(base.size, Image.LANCZOS)
            base.paste(mat_result, (0, 0), mask=mask_img)
        except Exception as exc:
            logger.warning("material layer %d composite failed: %s", layer.id, exc)

    # Furniture layers → paste bounding box
    for layer in layers:
        if layer.layer_type != LayerType.furniture or not layer.result_image_url:
            continue
        params = layer.parameters
        px = params.get("position_x")
        py = params.get("position_y")
        pw = params.get("target_width_px")
        ph = params.get("target_height_px")
        if None in (px, py, pw, ph):
            try:
                furn_result = _load_pil(layer.result_image_url).convert("RGBA")
                if furn_result.size != base.size:
                    furn_result = furn_result.resize(base.size, Image.LANCZOS)
                base = furn_result
            except Exception as exc:
                logger.warning("furniture layer %d failed: %s", layer.id, exc)
            continue
        try:
            furn_result = _load_pil(layer.result_image_url).convert("RGBA")
            if furn_result.size != base.size:
                furn_result = furn_result.resize(base.size, Image.LANCZOS)
            dil = 60
            x0 = max(0, int(px) - dil)
            y0 = max(0, int(py) - dil)
            x1 = min(canvas_w, int(px) + int(pw) + dil)
            y1 = min(canvas_h, int(py) + int(ph) + dil)
            region = furn_result.crop((x0, y0, x1, y1))
            base.paste(region, (x0, y0))
        except Exception as exc:
            logger.warning("furniture layer %d composite failed: %s", layer.id, exc)

    return base


# ── Service ───────────────────────────────────────────────────────────────────

class LightingService:
    """Apply a lighting preset to the current room state."""

    def __init__(self) -> None:
        self._wm     = WorkflowManager()
        self._runpod = RunPodClient()

    async def apply_lighting(
        self,
        project_id: int,
        user_id:    int,
        db:         Session,
        lighting:   str   = "morning",
        strength:   float = 0.35,
    ) -> LightingResult:
        """
        Apply a lighting atmosphere to the composited room image.

        Args:
            project_id: Target project.
            user_id:    Project owner.
            db:         SQLAlchemy session.
            lighting:   Lighting preset key (morning | evening | night).
            strength:   Denoise strength 0.25–0.45 (lower = subtler lighting shift).

        Returns:
            LightingResult with result_url, layer_id, elapsed_s, lighting.

        Raises:
            ValueError:  Invalid lighting preset or project not found.
            RunPodError: ComfyUI job failure.
        """
        t_start = time.monotonic()

        if lighting not in _LIGHTING_PROMPTS:
            raise ValueError(
                f"올바르지 않은 조명 값: {lighting!r}. "
                f"가능한 값: {list(_LIGHTING_PROMPTS)}"
            )

        # ── 1. Load project ───────────────────────────────────────────────────
        project = db.query(Project).filter(
            Project.id == project_id,
            Project.user_id == user_id,
        ).first()
        if not project:
            raise ValueError(f"Project {project_id} not found for user {user_id}")
        if not project.original_image_url:
            raise ValueError(f"Project {project_id} has no original image URL")

        logger.info(
            "lighting START: project=%d lighting=%s strength=%.2f",
            project_id, lighting, strength,
        )

        # ── 2. Composite visible layers ───────────────────────────────────────
        layers = (
            db.query(EditLayer)
            .filter(
                EditLayer.project_id == project_id,
                EditLayer.is_visible == True,  # noqa: E712
            )
            .order_by(EditLayer.order)
            .all()
        )

        composite = await asyncio.get_event_loop().run_in_executor(
            None,
            _composite_layers,
            project.original_image_url,
            layers,
        )
        composite_b64 = await asyncio.get_event_loop().run_in_executor(
            None, _pil_to_b64, composite, "JPEG"
        )

        # ── 3. Build ComfyUI workflow ─────────────────────────────────────────
        lighting_prompt = _LIGHTING_PROMPTS[lighting]
        workflow = await self._wm.build_lighting_workflow(
            image_url = composite_b64,
            lighting  = lighting_prompt,
            denoise   = strength,
        )

        # ── 4. Submit to RunPod ───────────────────────────────────────────────
        project.status = ProjectStatus.processing
        db.commit()

        try:
            output = await self._runpod.run_async(
                workflow      = workflow,
                timeout       = _LIGHTING_TIMEOUT_S,
                upload_result = False,
            )
        except RunPodError:
            project.status = ProjectStatus.error
            db.commit()
            raise

        # ── 5. Decode + save result ───────────────────────────────────────────
        img_b64_out: Optional[str] = output.get("image_base64")
        if not img_b64_out:
            project.status = ProjectStatus.error
            db.commit()
            raise ValueError("RunPod returned no image_base64 in output")

        try:
            result_bytes = base64.b64decode(img_b64_out)
        except Exception as exc:
            project.status = ProjectStatus.error
            db.commit()
            raise ValueError(f"RunPod 결과 base64 디코딩 실패: {exc}") from exc

        result_key = storage.project_key(
            user_id, project_id,
            f"results/lighting_{lighting}_{uuid.uuid4().hex[:8]}.jpg",
        )
        result_url = storage.upload(
            data         = result_bytes,
            key          = result_key,
            content_type = "image/jpeg",
            public       = True,
        )

        # ── 6. Create EditLayer ───────────────────────────────────────────────
        layer = EditLayer(
            project_id       = project_id,
            layer_type       = LayerType.style,
            parameters       = {
                "source":   "lighting",
                "lighting": lighting,
                "strength": strength,
                "result_url": result_url,
            },
            result_image_url = result_url,
            is_visible       = True,
            order            = 0,
        )
        db.add(layer)
        project.status = ProjectStatus.completed
        db.commit()
        db.refresh(layer)

        elapsed = round(time.monotonic() - t_start, 2)
        logger.info(
            "lighting DONE: project=%d layer=%d lighting=%s elapsed=%.1fs",
            project_id, layer.id, lighting, elapsed,
        )

        return LightingResult(
            result_url = result_url,
            layer_id   = layer.id,
            elapsed_s  = elapsed,
            lighting   = lighting,
        )


# ── Module-level singleton ────────────────────────────────────────────────────
lighting_service = LightingService()
