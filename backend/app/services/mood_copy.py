"""
MoodCopyService — Copy the mood / atmosphere of a reference image onto a room.

Pipeline
--------
1. Load project original image URL
2. Accept reference image as HTTP URL or base64 data URL
3. Call WorkflowManager.build_mood_copy_workflow() → ComfyUI workflow dict
4. Submit to RunPod via RunPodClient.run_async() (timeout: 120 s)
5. Save result image to S3/local
6. Create new EditLayer (layer_type=style) with result
7. Return MoodCopyResult

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

from sqlalchemy.orm import Session

from app.models.edit_layer import EditLayer, LayerType
from app.models.project import Project, ProjectStatus
from app.services.comfyui.runpod_client import RunPodClient, RunPodError
from app.services.comfyui.workflow_manager import WorkflowManager
from app.services.s3 import storage

logger = logging.getLogger("the_circle.mood_copy")

# ── Constants ─────────────────────────────────────────────────────────────────
CREDITS_PER_MOOD_COPY  = 3
_MOOD_COPY_TIMEOUT_S   = 120


# ── Result dataclass ──────────────────────────────────────────────────────────

@dataclass
class MoodCopyResult:
    result_url: str
    layer_id:   int
    elapsed_s:  float


# ── Service ───────────────────────────────────────────────────────────────────

class MoodCopyService:
    """Orchestrates the full Mood Copy pipeline."""

    def __init__(self) -> None:
        self._wm     = WorkflowManager()
        self._runpod = RunPodClient()

    async def copy_mood(
        self,
        project_id:           int,
        reference_image:      str,
        user_id:              int,
        db:                   Session,
        strength:             float = 0.5,
    ) -> MoodCopyResult:
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
            MoodCopyResult with result_url, layer_id, elapsed_s.

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
            "mood_copy START: project=%d strength=%.2f ref_prefix=%r",
            project_id, strength, reference_image[:60],
        )

        # ── 2. Build ComfyUI workflow ─────────────────────────────────────────
        # WorkflowManager._ensure_base64() handles URLs, data-URLs, and raw b64.
        workflow = await self._wm.build_mood_copy_workflow(
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
                timeout       = _MOOD_COPY_TIMEOUT_S,
                upload_result = False,
            )
        except RunPodError:
            project.status = ProjectStatus.draft
            db.commit()
            raise

        # ── 4. Decode + save result image ─────────────────────────────────────
        img_b64: Optional[str] = output.get("image_base64")
        if not img_b64:
            project.status = ProjectStatus.draft
            db.commit()
            raise ValueError("RunPod returned no image_base64 in output")

        result_bytes = base64.b64decode(img_b64)
        result_key   = storage.project_key(
            user_id, project_id,
            f"results/mood_copy_{uuid.uuid4().hex[:8]}.jpg",
        )
        result_url = storage.upload(
            data         = result_bytes,
            key          = result_key,
            content_type = "image/jpeg",
            public       = True,
        )

        # ── 5. Create EditLayer ───────────────────────────────────────────────
        # Store a truncated reference key (not full base64) to keep parameters lean
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
                "source":                  "mood_copy",
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
            "mood_copy DONE: project=%d layer=%d result_url=%s elapsed=%.1fs",
            project_id, layer.id, result_url, elapsed,
        )

        return MoodCopyResult(
            result_url = result_url,
            layer_id   = layer.id,
            elapsed_s  = elapsed,
        )


# ── Module-level singleton ────────────────────────────────────────────────────
mood_copy_service = MoodCopyService()
