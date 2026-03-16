"""
CircleAIService — Transform an entire room to match a style preset.

Pipeline
--------
1. Load project original image URL
2. Look up style prompt from STYLE_PRESETS
3. Call WorkflowManager.build_circle_ai_workflow() → ComfyUI workflow dict
4. Submit to RunPod via RunPodClient.run_async() (timeout: 120 s)
5. Save result image to S3/local
6. Create new EditLayer (layer_type=style) with result
7. Return StyleTransformResult

The ComfyUI workflow uses:
  - SDXL img2img (denoise = strength parameter)
  - Optional Korea-apartment LoRA
  - ControlNet Canny (structural line preservation)
"""

from __future__ import annotations

import base64
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from app.models.edit_layer import EditLayer, LayerType
from app.models.project import Project, ProjectStatus
from app.services.comfyui.runpod_client import RunPodClient, RunPodError
from app.services.comfyui.workflow_manager import WorkflowManager
from app.services.s3 import storage

logger = logging.getLogger("the_circle.circle_ai")

# ── Style preset catalogue ─────────────────────────────────────────────────────
STYLE_PRESETS: dict[str, str] = {
    "modern": (
        "modern minimalist interior design, clean lines, neutral palette, "
        "sleek furniture, natural light, 8k uhd"
    ),
    "scandinavian": (
        "scandinavian interior, light birch wood, white walls, wool textiles, "
        "cozy hygge atmosphere, 8k uhd"
    ),
    "classic": (
        "classic elegant interior, crown molding, warm walnut furniture, "
        "chandelier, refined atmosphere, 8k uhd"
    ),
    "industrial": (
        "industrial loft interior, exposed brick wall, metal pipe fixtures, "
        "concrete floor, edison bulbs, 8k uhd"
    ),
    "korean_modern": (
        "modern Korean apartment interior, warm ondol floor, clean layout, "
        "natural wood accents, 8k uhd"
    ),
    "japanese": (
        "japanese zen interior, tatami, shoji screen, minimalist, "
        "natural materials, peaceful, 8k uhd"
    ),
    "coastal": (
        "coastal beach house interior, white and blue palette, rattan furniture, "
        "ocean breeze, 8k uhd"
    ),
    "art_deco": (
        "art deco luxury interior, geometric patterns, gold accents, velvet, "
        "glamorous, 8k uhd"
    ),
}

# ── Constants ─────────────────────────────────────────────────────────────────
CREDITS_PER_CIRCLE_AI = 2
_TRANSFORM_TIMEOUT_S  = 120


# ── Result dataclass ──────────────────────────────────────────────────────────

@dataclass
class StyleTransformResult:
    result_url:   str
    layer_id:     int
    elapsed_s:    float
    style_preset: str


# ── Service ───────────────────────────────────────────────────────────────────

class CircleAIService:
    """Orchestrates the full Circle AI style-transform pipeline."""

    def __init__(self) -> None:
        self._wm     = WorkflowManager()
        self._runpod = RunPodClient()

    async def transform_room_style(
        self,
        project_id:   int,
        style_preset: str,
        user_id:      int,
        db:           Session,
        strength:     float = 0.6,
    ) -> StyleTransformResult:
        """
        Transform the room image to the chosen style preset.

        Args:
            project_id:   Target project.
            style_preset: Key from STYLE_PRESETS.
            user_id:      Project owner (for S3 key + ownership check).
            db:           SQLAlchemy session.
            strength:     Denoise strength 0.3–0.8 (higher = more transformed).

        Returns:
            StyleTransformResult with result_url, layer_id, elapsed_s.

        Raises:
            ValueError:  Unknown preset, or project missing / has no image.
            RunPodError: ComfyUI job failure.
        """
        t_start = time.monotonic()

        # ── 1. Validate preset ────────────────────────────────────────────────
        if style_preset not in STYLE_PRESETS:
            raise ValueError(
                f"Unknown style preset: {style_preset!r}. "
                f"Valid options: {list(STYLE_PRESETS)}"
            )

        # ── 2. Load project ───────────────────────────────────────────────────
        project = db.query(Project).filter(
            Project.id == project_id,
            Project.user_id == user_id,
        ).first()
        if not project:
            raise ValueError(f"Project {project_id} not found for user {user_id}")
        if not project.original_image_url:
            raise ValueError(f"Project {project_id} has no original image URL")

        style_prompt = STYLE_PRESETS[style_preset]
        logger.info(
            "circle_ai START: project=%d preset=%s strength=%.2f",
            project_id, style_preset, strength,
        )

        # ── 3. Build ComfyUI workflow ─────────────────────────────────────────
        workflow = self._wm.build_circle_ai_workflow(
            image_url        = project.original_image_url,
            style_prompt     = style_prompt,
            denoise_strength = strength,
        )

        # ── 4. Submit to RunPod ───────────────────────────────────────────────
        project.status = ProjectStatus.processing
        db.commit()

        try:
            output = await self._runpod.run_async(
                workflow      = workflow,
                timeout       = _TRANSFORM_TIMEOUT_S,
                upload_result = False,
            )
        except RunPodError:
            project.status = ProjectStatus.draft
            db.commit()
            raise

        # ── 5. Decode + save result image ─────────────────────────────────────
        img_b64: Optional[str] = output.get("image_base64")
        if not img_b64:
            project.status = ProjectStatus.draft
            db.commit()
            raise ValueError("RunPod returned no image_base64 in output")

        result_bytes = base64.b64decode(img_b64)
        result_key   = storage.project_key(
            user_id, project_id,
            f"results/circle_ai_{style_preset}_{uuid.uuid4().hex[:8]}.jpg",
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
                "style_preset": style_preset,
                "strength":     strength,
                "prompt":       style_prompt,
                "result_url":   result_url,
                "source":       "circle_ai",
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
            "circle_ai DONE: project=%d layer=%d result_url=%s elapsed=%.1fs",
            project_id, layer.id, result_url, elapsed,
        )

        return StyleTransformResult(
            result_url   = result_url,
            layer_id     = layer.id,
            elapsed_s    = elapsed,
            style_preset = style_preset,
        )


# ── Module-level singleton ────────────────────────────────────────────────────
circle_ai_service = CircleAIService()
