"""
MaterialApplyService — Apply a material texture to a masked room region.

Pipeline
--------
1. Load project original image URL + mask URL (from EditLayer.parameters)
2. Load material tile_image_url + name/category
3. Build a text prompt from material metadata
4. Call WorkflowManager.build_material_apply_workflow() → ComfyUI workflow dict
5. Submit to RunPod via RunPodClient.run_async() (timeout: 120 s)
6. Save result image to S3/local
7. Update EditLayer.result_image_url + project.status
8. Return ApplyResult(result_url, layer_id, elapsed_s)

The ComfyUI workflow uses:
  - IP-Adapter (texture / colour fidelity from tile image)
  - ControlNet Depth (MiDaS depth map → perspective-aware placement)
  - Inpaint (VAEEncodeForInpaint, mask restricts generation to selected area)
  ★ NO perspective-warp nodes — depth-guided AI handles all perspective.
"""

from __future__ import annotations

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

from app.config import settings
from app.models.edit_layer import EditLayer, LayerType
from app.models.material import Material
from app.models.project import Project, ProjectStatus
from app.services.comfyui.runpod_client import RunPodClient, RunPodError
from app.services.comfyui.workflow_manager import WorkflowManager
from app.services.s3 import storage

logger = logging.getLogger("the_circle.material_apply")

# ── Category → English description (for prompt building) ─────────────────────
_CATEGORY_PROMPTS = {
    "wallpaper": "seamless wallpaper texture applied to the wall surface",
    "flooring":  "seamless flooring material covering the floor surface",
    "ceiling":   "seamless ceiling material on the ceiling surface",
    "tile":      "seamless tile pattern on the surface",
    "paint":     "smooth painted wall surface, flat finish",
}

# ── Default ComfyUI generation parameters ─────────────────────────────────────
_DEFAULT_STEPS       = 25
_DEFAULT_CFG         = 7.0
_DEFAULT_DENOISE     = 0.60      # 0.5–0.7: preserve room structure well
_DEFAULT_IPADAPTER_W = 0.80      # texture fidelity
_DEFAULT_CN_DEPTH_W  = 0.90      # perspective/structure preservation
_APPLY_TIMEOUT_S     = 120


# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class ApplyResult:
    result_url: str
    layer_id: int
    elapsed_s: float


# ─────────────────────────────────────────────────────────────────────────────

class MaterialApplyService:
    """Orchestrates the full material-apply pipeline."""

    def __init__(self) -> None:
        self._wm     = WorkflowManager()
        self._runpod = RunPodClient()

    async def apply_material_to_region(
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
    ) -> ApplyResult:
        """
        Apply *material_id* to the region defined by *layer_id*.

        Args:
            project_id:        Project to process.
            layer_id:          EditLayer whose ``parameters.mask_url`` specifies
                               the mask region (created by POST /projects/{id}/masks).
            material_id:       Material to apply.
            user_id:           Owner of the project (for S3 key).
            db:                SQLAlchemy session.
            custom_prompt:     Optional extra text appended to the material's prompt.
            ipadapter_weight:  IP-Adapter weight override. If None, uses
                               ``material.ip_adapter_weight`` (per-material tuned value).
            controlnet_weight: ControlNet Depth weight (0.0–1.0; default 0.90).
            denoise:           KSampler denoise override. If None, uses
                               ``material.recommended_denoise`` (per-material tuned value).
            steps:             KSampler denoising steps.
            cfg:               Classifier-free guidance scale.

        Returns:
            ApplyResult with result_url, layer_id, elapsed_s.

        Raises:
            ValueError:  If project, layer, or material not found; or missing URLs.
            RunPodError: If the ComfyUI job fails.
        """
        t_start = time.monotonic()

        # ── 1. Load project + layer + material ───────────────────────────────
        project  = db.query(Project).filter(
            Project.id == project_id, Project.user_id == user_id
        ).first()
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
        # Prefer the material's own tuned values; caller may override explicitly.
        effective_ipadapter_weight = (
            ipadapter_weight if ipadapter_weight is not None
            else material.ip_adapter_weight
        )
        effective_denoise = (
            denoise if denoise is not None
            else material.recommended_denoise
        )

        # ── 3. Build text prompt ──────────────────────────────────────────────
        # If the material has a custom positive_prompt, use it as the base.
        # Otherwise fall back to the auto-generated category description.
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

        # Negative prompt: material-specific if set, otherwise empty (WorkflowManager uses its own default)
        negative_prompt = material.negative_prompt or None

        logger.info(
            "apply_material: project=%d layer=%d material=%d(%s) "
            "ipadapter=%.2f denoise=%.2f prompt=%r",
            project_id, layer_id, material_id, material.name,
            effective_ipadapter_weight, effective_denoise, base_prompt[:80],
        )

        # ── 4. Build ComfyUI workflow ─────────────────────────────────────────
        wf_kwargs: dict = dict(
            image_url            = project.original_image_url,
            mask_data            = mask_url,
            material_texture_url = material.tile_image_url,
            prompt               = base_prompt,
            ipadapter_weight     = effective_ipadapter_weight,
            controlnet_strength  = controlnet_weight,
            denoise              = effective_denoise,
            steps                = steps,
            cfg                  = cfg,
        )
        if negative_prompt:
            wf_kwargs["negative_prompt"] = negative_prompt

        workflow = self._wm.build_material_apply_workflow(**wf_kwargs)

        # ── 5. Submit to RunPod ───────────────────────────────────────────────
        # Mark project as processing
        project.status = ProjectStatus.processing
        db.commit()

        try:
            output = await self._runpod.run_async(
                workflow      = workflow,
                timeout       = _APPLY_TIMEOUT_S,
                upload_result = False,   # we handle S3 ourselves
            )
        except RunPodError:
            project.status = ProjectStatus.draft
            db.commit()
            raise

        # ── 6. Decode + save result image ─────────────────────────────────────
        img_b64: Optional[str] = output.get("image_base64")
        if not img_b64:
            project.status = ProjectStatus.draft
            db.commit()
            raise ValueError("RunPod returned no image_base64 in output")

        result_bytes  = base64.b64decode(img_b64)
        result_key    = storage.project_key(
            user_id, project_id,
            f"results/material_apply_{layer_id}_{uuid.uuid4().hex[:8]}.jpg"
        )
        result_url = storage.upload(
            data         = result_bytes,
            key          = result_key,
            content_type = "image/jpeg",
            public       = True,
        )

        # ── 7. Update DB ──────────────────────────────────────────────────────
        layer.result_image_url = result_url
        layer.parameters = {
            **layer.parameters,
            "material_id":        material_id,
            "material_name":      material.name,
            "result_url":         result_url,
            "prompt":             base_prompt,
            "ipadapter_weight":   effective_ipadapter_weight,
            "denoise":            effective_denoise,
        }
        project.status = ProjectStatus.completed
        db.commit()

        elapsed = round(time.monotonic() - t_start, 2)
        logger.info(
            "apply_material DONE: project=%d layer=%d result_url=%s elapsed=%.1fs",
            project_id, layer_id, result_url, elapsed,
        )

        return ApplyResult(
            result_url = result_url,
            layer_id   = layer_id,
            elapsed_s  = elapsed,
        )


# ── Module-level singleton ────────────────────────────────────────────────────
material_apply_service = MaterialApplyService()
