"""
MoodService — Copy the mood / atmosphere of a reference image onto a room.

Pipeline
--------
1. Load project original image URL
2. Accept reference image as HTTP URL or base64 data URL
3. Call WorkflowManager.build_mood_workflow() → ComfyUI workflow dict
4. Submit to RunPod via RunPodClient.run_async() (timeout: 120 s)
5. Save result image to S3/local
6. Create new EditLayer (layer_type=style) with result
7. Return MoodResult

The ComfyUI workflow uses:
  - IP-Adapter (high weight) — extracts style/mood from reference image
  - SDXL img2img (moderate denoise) — preserves room structure
"""

from __future__ import annotations

import base64
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Optional

from sqlalchemy import update as sa_update
from sqlalchemy.orm import Session

from app.models.edit_layer import EditLayer, LayerType
from app.models.project import Project, ProjectStatus
from app.services.comfyui.runpod_client import RunPodClient, RunPodError
from app.services.comfyui.workflow_manager import WorkflowManager
from app.services.s3 import storage

logger = logging.getLogger("the_circle.mood")

# ── Constants ─────────────────────────────────────────────────────────────────
CREDITS_PER_MOOD  = 3
_MOOD_TIMEOUT_S   = 120

# ── Style Presets ─────────────────────────────────────────────────────────────
VALID_PRESETS = ["wood_white", "mid_century", "japandi"]

# 1×1 white JPEG as a neutral placeholder reference image (base64)
_PLACEHOLDER_REF_B64 = (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDB"
    "kSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAAR"
    "CAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB/8QABRABAAAA"
    "AAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAA"
    "AAAA/9oADAMBAAIRAxEAPwCwAB//2Q=="
)

_PRESET_CONFIGS: dict[str, dict] = {
    "wood_white": {
        "label": "우드 앤 화이트",
        "prompt": (
            "interior photography, Scandinavian wood and white style, "
            "light natural wood floors, white walls, white furniture, "
            "minimalist decor, warm neutral tones, natural light, "
            "clean lines, cozy atmosphere, high quality, 8k, professional photo"
        ),
        "negative_prompt": (
            "dark colors, heavy furniture, clutter, ornate details, "
            "gold accents, velvet, dramatic lighting, dark wood, "
            "CGI, 3D render, blurry, watercolor, painting, distorted"
        ),
        "ipadapter_weight": 0.05,
        "denoise": 0.62,
        "cfg": 6.0,
    },
    "mid_century": {
        "label": "미드센추리 모던",
        "prompt": (
            "interior photography, mid-century modern style, "
            "warm walnut wood tones, organic curves, tapered legs, "
            "mustard yellow and terracotta accents, clean geometric forms, "
            "retro modern furniture, natural light, professional photo, 8k"
        ),
        "negative_prompt": (
            "contemporary minimalism, all-white, Scandinavian, dark gothic, "
            "industrial, ornate baroque, heavy drapes, clutter, "
            "CGI, 3D render, blurry, watercolor, painting, distorted"
        ),
        "ipadapter_weight": 0.05,
        "denoise": 0.65,
        "cfg": 6.0,
    },
    "japandi": {
        "label": "재팬디",
        "prompt": (
            "interior photography, Japandi style, Japanese-Scandinavian fusion, "
            "wabi-sabi aesthetic, natural linen and cotton textiles, "
            "low profile furniture, bamboo and light wood, muted earth tones, "
            "zen atmosphere, soft diffused light, professional photo, 8k"
        ),
        "negative_prompt": (
            "bright saturated colors, maximalist decor, heavy ornate details, "
            "gold accents, dramatic lighting, bold patterns, "
            "CGI, 3D render, blurry, watercolor, painting, distorted"
        ),
        "ipadapter_weight": 0.05,
        "denoise": 0.60,
        "cfg": 5.5,
    },
}


# ── Result dataclass ──────────────────────────────────────────────────────────

@dataclass
class MoodResult:
    result_url: str
    layer_id:   int
    elapsed_s:  float


# ── Service ───────────────────────────────────────────────────────────────────

class MoodService:
    """Orchestrates the full Mood pipeline."""

    def __init__(self) -> None:
        self._wm     = WorkflowManager()
        self._runpod = RunPodClient()

    async def apply_mood(
        self,
        project_id:      int,
        reference_image: str,
        user_id:         int,
        db:              Session,
        strength:        float = 0.5,
    ) -> MoodResult:
        """
        Transfer the mood / atmosphere of a reference image onto the room.

        Args:
            project_id:       Target project.
            reference_image:  Reference image as HTTP URL, base64 data URL,
                              or raw base64 string.
            user_id:          Project owner (for S3 key + ownership check).
            db:               SQLAlchemy session.
            strength:         Overall transformation strength 0.3–0.8.
                              Maps to IP-Adapter weight + denoise internally.

        Returns:
            MoodResult with result_url, layer_id, elapsed_s.

        Raises:
            ValueError:  Project not found / missing image.
            RunPodError: ComfyUI job failure.
        """
        t_start = time.monotonic()

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
            "mood START: project=%d strength=%.2f ref_prefix=%r",
            project_id, strength, reference_image[:60],
        )

        # ── 2. Build ComfyUI workflow ─────────────────────────────────────────
        workflow = await self._wm.build_mood_workflow(
            source_image_url    = project.original_image_url,
            reference_image_url = reference_image,
            strength            = strength,
        )

        # ── 3. Submit to RunPod ───────────────────────────────────────────────
        project.status = ProjectStatus.processing
        db.commit()

        try:
            output = await self._runpod.run_async(
                workflow      = workflow,
                timeout       = _MOOD_TIMEOUT_S,
                upload_result = False,
            )
        except RunPodError:
            _set_project_status(db, project_id, ProjectStatus.error)
            raise

        # ── 4. Decode + save result image ─────────────────────────────────────
        img_b64: Optional[str] = output.get("image_base64")
        if not img_b64:
            _set_project_status(db, project_id, ProjectStatus.error)
            raise ValueError("RunPod returned no image_base64 in output")

        try:
            result_bytes = base64.b64decode(img_b64)
        except Exception as exc:
            _set_project_status(db, project_id, ProjectStatus.error)
            raise ValueError(f"RunPod 결과 base64 디코딩 실패: {exc}") from exc

        result_key = storage.project_key(
            user_id, project_id,
            f"results/mood_{uuid.uuid4().hex[:8]}.jpg",
        )
        result_url = storage.upload(
            data         = result_bytes,
            key          = result_key,
            content_type = "image/jpeg",
            public       = True,
        )

        # ── 5. Create EditLayer ───────────────────────────────────────────────
        ref_preview = (
            reference_image[:120]
            if reference_image.startswith(("http://", "https://"))
            else "[base64]"
        )
        layer = EditLayer(
            project_id       = project_id,
            layer_type       = LayerType.style,
            parameters       = {
                "reference_image_preview": ref_preview,
                "strength":                strength,
                "result_url":              result_url,
                "source":                  "mood",
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
            "mood DONE: project=%d layer=%d result_url=%s elapsed=%.1fs",
            project_id, layer.id, result_url, elapsed,
        )

        return MoodResult(
            result_url = result_url,
            layer_id   = layer.id,
            elapsed_s  = elapsed,
        )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _set_project_status(db: Session, project_id: int, status: ProjectStatus) -> None:
    """Update project status using direct SQL to avoid ORM lazy-load issues."""
    try:
        db.rollback()
        db.execute(
            sa_update(Project)
            .where(Project.id == project_id)
            .values(status=status)
        )
        db.commit()
    except Exception as exc:
        logger.error("Failed to set project %d status to %s: %s", project_id, status, exc)
        try:
            db.rollback()
        except Exception:
            pass


# ── Preset Service ────────────────────────────────────────────────────────────

class MoodPresetService:
    """Applies a curated style preset (no user-supplied reference image)."""

    def __init__(self) -> None:
        self._wm     = WorkflowManager()
        self._runpod = RunPodClient()

    async def apply_preset(
        self,
        project_id: int,
        user_id:    int,
        db:         Session,
        preset:     str,
        strength:   float = 0.55,
    ) -> MoodResult:
        """
        Apply a curated style preset to the room.

        Args:
            project_id: Target project.
            user_id:    Project owner.
            db:         SQLAlchemy session.
            preset:     One of VALID_PRESETS.
            strength:   Transformation strength 0.3–0.8.

        Returns:
            MoodResult with result_url, layer_id, elapsed_s.
        """
        t_start = time.monotonic()
        cfg = _PRESET_CONFIGS[preset]

        # ── 0. Return cached result if already computed ───────────────────────
        existing_layers = db.query(EditLayer).filter(
            EditLayer.project_id == project_id,
        ).all()
        for layer in existing_layers:
            params = layer.parameters or {}
            if (
                params.get("source") == "mood_preset"
                and params.get("preset") == preset
                and layer.result_image_url
            ):
                logger.info(
                    "mood_preset CACHE HIT: project=%d preset=%s layer=%d",
                    project_id, preset, layer.id,
                )
                return MoodResult(
                    result_url=layer.result_image_url,
                    layer_id=layer.id,
                    elapsed_s=0.0,
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
            "mood_preset START: project=%d preset=%s strength=%.2f",
            project_id, preset, strength,
        )

        # ── 2. Build workflow — use placeholder as reference ──────────────────
        # IP-Adapter weight is near-zero so the style comes from the text prompt.
        workflow = await self._wm.build_mood_workflow(
            source_image_url    = project.original_image_url,
            reference_image_url = _PLACEHOLDER_REF_B64,
            strength            = strength,
            prompt              = cfg["prompt"],
            negative_prompt     = cfg["negative_prompt"],
            ipadapter_weight    = cfg["ipadapter_weight"],
            denoise             = cfg["denoise"],
            cfg                 = cfg["cfg"],
        )

        # ── 3. Submit to RunPod ───────────────────────────────────────────────
        project.status = ProjectStatus.processing
        db.commit()

        try:
            output = await self._runpod.run_async(
                workflow      = workflow,
                timeout       = _MOOD_TIMEOUT_S,
                upload_result = False,
            )
        except RunPodError:
            _set_project_status(db, project_id, ProjectStatus.error)
            raise

        # ── 4. Decode + save result ───────────────────────────────────────────
        img_b64: Optional[str] = output.get("image_base64")
        if not img_b64:
            _set_project_status(db, project_id, ProjectStatus.error)
            raise ValueError("RunPod returned no image_base64 in output")

        try:
            result_bytes = base64.b64decode(img_b64)
        except Exception as exc:
            _set_project_status(db, project_id, ProjectStatus.error)
            raise ValueError(f"RunPod 결과 base64 디코딩 실패: {exc}") from exc

        result_key = storage.project_key(
            user_id, project_id,
            f"results/preset_{preset}_{uuid.uuid4().hex[:8]}.jpg",
        )
        result_url = storage.upload(
            data         = result_bytes,
            key          = result_key,
            content_type = "image/jpeg",
            public       = True,
        )

        # ── 5. Create EditLayer ───────────────────────────────────────────────
        layer = EditLayer(
            project_id       = project_id,
            layer_type       = LayerType.style,
            parameters       = {
                "preset":      preset,
                "preset_label": cfg["label"],
                "strength":    strength,
                "result_url":  result_url,
                "source":      "mood_preset",
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
            "mood_preset DONE: project=%d preset=%s layer=%d elapsed=%.1fs",
            project_id, preset, layer.id, elapsed,
        )

        return MoodResult(
            result_url = result_url,
            layer_id   = layer.id,
            elapsed_s  = elapsed,
        )


# ── Module-level singletons ───────────────────────────────────────────────────
mood_service        = MoodService()
mood_preset_service = MoodPresetService()
