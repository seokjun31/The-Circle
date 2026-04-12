"""
MaterialService — Apply a material texture to a masked room region.

Pipeline
--------
1. Load project original image URL + mask URL (from EditLayer.parameters)
2. Load material tile_image_url + name/category
3. Build a text prompt from material metadata
4. Call WorkflowManager.build_material_workflow() → ComfyUI workflow dict
5. Submit to RunPod via RunPodClient.run_async() (timeout: 120 s)
6. Save result image to S3/local
7. Update EditLayer.result_image_url + project.status
8. Return MaterialResult(result_url, layer_id, elapsed_s)

The ComfyUI workflow uses:
  - IP-Adapter (texture / colour fidelity from tile image)
  - ControlNet Depth (MiDaS depth map → perspective-aware placement)
  - Inpaint (VAEEncodeForInpaint, mask restricts generation to selected area)
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

from app.models.edit_layer import EditLayer
from app.models.material import Material
from app.models.project import Project, ProjectStatus
from app.services.comfyui import get_comfyui_client
from app.services.comfyui.runpod_client import RunPodError
from app.services.comfyui.workflow_manager import WorkflowManager
from app.services.s3 import storage

logger = logging.getLogger("the_circle.material")

# ── Category → English description (for prompt building) ─────────────────────
_CATEGORY_PROMPTS = {
    "wallpaper": "seamless wallpaper texture applied to the wall surface",
    "flooring": "seamless flooring material covering the floor surface",
    "ceiling": "seamless ceiling material on the ceiling surface",
    "tile": "seamless tile pattern on the surface",
    "paint": "smooth painted wall surface, flat finish",
}

# ── Default ComfyUI generation parameters ─────────────────────────────────────
_DEFAULT_STEPS = 25
_DEFAULT_CFG = 7.0
_DEFAULT_DENOISE = 0.60
_DEFAULT_IPADAPTER_W = 0.80
_DEFAULT_CN_DEPTH_W = 0.90
_APPLY_TIMEOUT_S = 120


# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class MaterialResult:
    result_url: str
    layer_id: int
    elapsed_s: float


# ─────────────────────────────────────────────────────────────────────────────


class MaterialService:
    """Orchestrates the full material-apply pipeline."""

    def __init__(self) -> None:
        self._wm = WorkflowManager()
        self._runpod = get_comfyui_client()

    async def apply_material(
        self,
        project_id: int,
        layer_id: int,
        material_id: int,
        user_id: int,
        db: Session,
        custom_prompt: Optional[str] = None,
        ipadapter_weight: Optional[float] = None,
        controlnet_weight: float = _DEFAULT_CN_DEPTH_W,
        denoise: Optional[float] = None,
        steps: int = _DEFAULT_STEPS,
        cfg: float = _DEFAULT_CFG,
    ) -> MaterialResult:
        """
        Apply *material_id* to the region defined by *layer_id*.

        Args:
            project_id:        Project to process.
            layer_id:          EditLayer whose ``parameters.mask_url`` specifies
                               the mask region.
            material_id:       Material to apply.
            user_id:           Owner of the project (for S3 key).
            db:                SQLAlchemy session.
            custom_prompt:     Optional extra text appended to the material's prompt.
            ipadapter_weight:  IP-Adapter weight override.
            controlnet_weight: ControlNet Depth weight (0.0–1.0; default 0.90).
            denoise:           KSampler denoise override.
            steps:             KSampler denoising steps.
            cfg:               Classifier-free guidance scale.

        Returns:
            MaterialResult with result_url, layer_id, elapsed_s.

        Raises:
            ValueError:  If project, layer, or material not found; or missing URLs.
            RunPodError: If the ComfyUI job fails.
        """
        t_start = time.monotonic()

        # ── 1. Load project + layer + material ───────────────────────────────
        project = (
            db.query(Project)
            .filter(Project.id == project_id, Project.user_id == user_id)
            .first()
        )
        if not project:
            raise ValueError(f"Project {project_id} not found for user {user_id}")
        if not project.original_image_url:
            raise ValueError(f"Project {project_id} has no original image URL")

        layer = db.get(EditLayer, layer_id)
        if not layer or layer.project_id != project_id:
            raise ValueError(f"EditLayer {layer_id} not found in project {project_id}")

        mask_url: Optional[str] = layer.parameters.get("mask_url")
        if not mask_url:
            raise ValueError(f"EditLayer {layer_id} has no mask_url in parameters")

        material = db.get(Material, material_id)
        if not material:
            raise ValueError(f"Material {material_id} not found")
        if not material.tile_image_url:
            raise ValueError(f"Material {material_id} has no tile_image_url")

        # ── 2. Resolve per-material AI parameters ────────────────────────────
        effective_ipadapter_weight = (
            ipadapter_weight
            if ipadapter_weight is not None
            else material.ip_adapter_weight
        )
        effective_denoise = (
            denoise if denoise is not None else material.recommended_denoise
        )

        # ── 3. Build text prompt ──────────────────────────────────────────────
        if material.positive_prompt:
            base_prompt = material.positive_prompt
        else:
            category_desc = _CATEGORY_PROMPTS.get(
                material.category.value, "material texture on the surface"
            )
            base_prompt = (
                f"{material.name}, {category_desc}, "
                "high quality, photorealistic, professionally installed, "
                "consistent lighting with the room, sharp detail"
            )
        if custom_prompt:
            base_prompt = f"{base_prompt}, {custom_prompt.strip()}"

        negative_prompt = material.negative_prompt or None

        logger.info(
            "apply_material: project=%d layer=%d material=%d(%s) "
            "ipadapter=%.2f denoise=%.2f prompt=%r",
            project_id,
            layer_id,
            material_id,
            material.name,
            effective_ipadapter_weight,
            effective_denoise,
            base_prompt[:80],
        )

        # ── 4. Build ComfyUI workflow ─────────────────────────────────────────
        wf_kwargs: dict = dict(
            image_url=project.original_image_url,
            mask_data=mask_url,
            material_texture_url=material.tile_image_url,
            prompt=base_prompt,
            ipadapter_weight=effective_ipadapter_weight,
            controlnet_strength=controlnet_weight,
            denoise=effective_denoise,
            steps=steps,
            cfg=cfg,
        )
        if negative_prompt:
            wf_kwargs["negative_prompt"] = negative_prompt

        workflow = await self._wm.build_material_workflow(**wf_kwargs)

        # ── 5. Submit to RunPod ───────────────────────────────────────────────
        project.status = ProjectStatus.processing
        db.commit()

        try:
            output = await self._runpod.run_async(
                workflow=workflow,
                timeout=_APPLY_TIMEOUT_S,
                upload_result=False,
            )
        except RunPodError:
            _set_project_status(db, project_id, ProjectStatus.error)
            raise

        # ── 6. Decode + save result image ─────────────────────────────────────
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
            user_id,
            project_id,
            f"results/material_{layer_id}_{uuid.uuid4().hex[:8]}.jpg",
        )
        result_url = storage.upload(
            data=result_bytes,
            key=result_key,
            content_type="image/jpeg",
            public=True,
        )

        # ── 7. Update DB ──────────────────────────────────────────────────────
        layer.result_image_url = result_url
        layer.parameters = {
            **layer.parameters,
            "material_id": material_id,
            "material_name": material.name,
            "result_url": result_url,
            "prompt": base_prompt,
            "ipadapter_weight": effective_ipadapter_weight,
            "denoise": effective_denoise,
        }
        project.status = ProjectStatus.completed
        db.commit()

        elapsed = round(time.monotonic() - t_start, 2)
        logger.info(
            "apply_material DONE: project=%d layer=%d result_url=%s elapsed=%.1fs",
            project_id,
            layer_id,
            result_url,
            elapsed,
        )

        return MaterialResult(
            result_url=result_url,
            layer_id=layer_id,
            elapsed_s=elapsed,
        )


# ── Helpers ───────────────────────────────────────────────────────────────────


def _set_project_status(db: Session, project_id: int, status: ProjectStatus) -> None:
    """Update project status using direct SQL to avoid ORM lazy-load issues."""
    try:
        db.rollback()
        db.execute(
            sa_update(Project).where(Project.id == project_id).values(status=status)
        )
        db.commit()
    except Exception as exc:
        logger.error(
            "Failed to set project %d status to %s: %s", project_id, status, exc
        )
        try:
            db.rollback()
        except Exception:
            pass


# ── Module-level singleton ────────────────────────────────────────────────────
material_service = MaterialService()
