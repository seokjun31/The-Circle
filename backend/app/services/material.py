"""
MaterialService — Qwen Edit 2511 fp8 기반 자재 교체 파이프라인

Pipeline
--------
1.  Load project + validate inputs
2.  If region_label is None → run ADE20K classify workflow to auto-detect surface
3.  Analyse dominant ADE20K colour in mask region → derive region_label
4.  If region still ambiguous → raise RegionUnclassifiedError (caller asks user)
5.  Build Qwen Edit workflow with region_label prompt
6.  Submit to ComfyUI (local or RunPod) via get_comfyui_client()
7.  Save result image to S3/local storage
8.  Create new EditLayer (layer_type=wall/floor/ceiling/door/cabinet)
9.  Return MaterialResult

ADE20K colour → surface mapping
--------------------------------
    (120, 120, 120)  →  wall
    (80,  50,  50)   →  floor
    (120, 120, 80)   →  ceiling
    (8,   255, 51)   →  door
    (224, 5,   255)  →  cabinet

Credit cost: 1 credit
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import time
import uuid
from collections import Counter
from dataclasses import dataclass
from typing import Optional

import numpy as np
from PIL import Image
from sqlalchemy import update as sa_update
from sqlalchemy.orm import Session

from app.models.edit_layer import EditLayer, LayerType
from app.models.project import Project, ProjectStatus
from app.services.comfyui import get_comfyui_client
from app.services.comfyui.runpod_client import RunPodError
from app.services.comfyui.workflow_manager import WorkflowManager
from app.services.s3 import storage

logger = logging.getLogger("the_circle.material")

_APPLY_TIMEOUT_S = 120
_CLASSIFY_TIMEOUT_S = 60

# ADE20K colour palette → The Circle surface label
# Colours match comfyui_controlnet_aux ade_palette() indices 0,3,5,14,10
_ADE20K_COLORS: dict[tuple[int, int, int], str] = {
    (120, 120, 120): "wall",
    (80, 50, 50): "floor",
    (120, 120, 80): "ceiling",
    (8, 255, 51): "door",
    (224, 5, 255): "cabinet",
}
_ADE20K_NEAREST_THRESHOLD = 40  # max Euclidean distance for nearest-neighbour match

# Map region_label → EditLayer LayerType
_LABEL_TO_LAYER_TYPE: dict[str, LayerType] = {
    "wall": LayerType.wall,
    "floor": LayerType.floor,
    "ceiling": LayerType.ceiling,
    "door": LayerType.wall,     # reuse wall type for door
    "cabinet": LayerType.wall,  # reuse wall type for cabinet
}

VALID_REGION_LABELS = frozenset(_ADE20K_COLORS.values())


# ── Exceptions ────────────────────────────────────────────────────────────────


class RegionUnclassifiedError(Exception):
    """Raised when ADE20K classification cannot determine the surface type."""


# ── Result type ───────────────────────────────────────────────────────────────


@dataclass
class MaterialResult:
    result_url: str
    layer_id: int
    elapsed_s: float
    region_label: str


# ── Colour analysis helpers ───────────────────────────────────────────────────


def _b64_to_pil(b64: str) -> Image.Image:
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[-1]
    return Image.open(io.BytesIO(base64.b64decode(b64)))


def _nearest_ade20k_label(color: tuple[int, int, int]) -> Optional[str]:
    """Return the closest ADE20K label for *color*, or None if too distant."""
    if color in _ADE20K_COLORS:
        return _ADE20K_COLORS[color]
    best_dist = float("inf")
    best_label: Optional[str] = None
    for ref, label in _ADE20K_COLORS.items():
        dist = float(np.sqrt(sum((a - b) ** 2 for a, b in zip(color, ref))))
        if dist < best_dist:
            best_dist = dist
            best_label = label
    return best_label if best_dist < _ADE20K_NEAREST_THRESHOLD else None


def _classify_mask_region(
    ade20k_img: Image.Image,
    mask_img: Image.Image,
) -> Optional[str]:
    """
    Find the dominant ADE20K surface label within *mask_img* region.

    Args:
        ade20k_img: Full ADE20K segmentation map (RGB).
        mask_img:   User mask (any mode; white/light pixels = selected region).

    Returns:
        Region label string, or None when classification is ambiguous.
    """
    ade20k_rgb = ade20k_img.convert("RGB")
    mask_gray = mask_img.convert("L").resize(ade20k_rgb.size, Image.LANCZOS)

    ade_arr = np.array(ade20k_rgb)          # H×W×3
    mask_arr = np.array(mask_gray)           # H×W

    roi = ade_arr[mask_arr > 128]            # N×3
    if roi.size == 0:
        return None

    # Count pixel colours
    color_counts: Counter = Counter(tuple(int(v) for v in px) for px in roi)

    # Walk from most common colour, find first recognisable label
    for color, _ in color_counts.most_common(20):
        label = _nearest_ade20k_label(color)
        if label:
            return label

    return None


# ── Service ───────────────────────────────────────────────────────────────────


class MaterialService:
    """Orchestrate the Qwen Edit 2511 fp8 material-replace pipeline."""

    def __init__(self) -> None:
        self._wm = WorkflowManager()
        self._client = get_comfyui_client()

    async def apply_material(
        self,
        project_id: int,
        user_id: int,
        db: Session,
        mask_data: str,
        material_image: str,
        region_label: Optional[str] = None,
    ) -> MaterialResult:
        """
        Replace the masked surface with the material texture.

        Args:
            project_id:     Target project.
            user_id:        Project owner.
            db:             SQLAlchemy session.
            mask_data:      SAM mask — base64 PNG or data URL (white = target area).
            material_image: Material texture — base64 or data URL.
            region_label:   Surface type override (wall/floor/ceiling/door/cabinet).
                            None = auto-detect via ADE20K classify workflow.

        Returns:
            MaterialResult with result_url, layer_id, elapsed_s, region_label.

        Raises:
            ValueError:              Invalid inputs or project not found.
            RegionUnclassifiedError: ADE20K cannot classify the mask region
                                     (caller should ask user to specify label).
            RunPodError:             ComfyUI job failure.
        """
        t_start = time.monotonic()

        # ── 1. Validate region_label if provided ──────────────────────────────
        if region_label is not None and region_label not in VALID_REGION_LABELS:
            raise ValueError(
                f"올바르지 않은 region_label: {region_label!r}. "
                f"가능한 값: {sorted(VALID_REGION_LABELS)}"
            )

        # ── 2. Load project ───────────────────────────────────────────────────
        project = (
            db.query(Project)
            .filter(Project.id == project_id, Project.user_id == user_id)
            .first()
        )
        if not project:
            raise ValueError(f"Project {project_id} not found for user {user_id}")
        if not project.original_image_url:
            raise ValueError(f"Project {project_id} has no original image URL")

        logger.info(
            "material START: project=%d region=%s",
            project_id,
            region_label or "auto",
        )

        # ── 3. Auto-classify if region_label not given ────────────────────────
        if region_label is None:
            region_label = await self._auto_classify(
                project.original_image_url, mask_data
            )
            if region_label is None:
                raise RegionUnclassifiedError(
                    "마스크 영역의 표면 유형을 자동으로 판별하지 못했습니다. "
                    "영역 유형(벽/바닥/천장/문/가구)을 직접 선택해주세요."
                )
            logger.info("material ADE20K classified: %s", region_label)

        # ── 4. Build Qwen Edit workflow ───────────────────────────────────────
        workflow = self._wm.build_material_workflow(
            image_url=project.original_image_url,
            mask_data=mask_data,
            material_image_url=material_image,
            region_label=region_label,
        )

        # ── 5. Submit to ComfyUI ──────────────────────────────────────────────
        project.status = ProjectStatus.processing
        db.commit()

        try:
            output = await self._client.run_async(
                workflow=workflow,
                timeout=_APPLY_TIMEOUT_S,
                upload_result=False,
            )
        except RunPodError:
            _set_project_status(db, project_id, ProjectStatus.error)
            raise

        # ── 6. Decode + save result ───────────────────────────────────────────
        img_b64_out: Optional[str] = output.get("image_base64")
        if not img_b64_out:
            _set_project_status(db, project_id, ProjectStatus.error)
            raise ValueError("ComfyUI returned no image_base64 in output")

        try:
            result_bytes = base64.b64decode(img_b64_out)
        except Exception as exc:
            _set_project_status(db, project_id, ProjectStatus.error)
            raise ValueError(f"결과 base64 디코딩 실패: {exc}") from exc

        result_key = storage.project_key(
            user_id,
            project_id,
            f"results/material_{region_label}_{uuid.uuid4().hex[:8]}.jpg",
        )
        result_url = storage.upload(
            data=result_bytes,
            key=result_key,
            content_type="image/jpeg",
            public=True,
        )

        # ── 7. Create EditLayer ───────────────────────────────────────────────
        layer_type = _LABEL_TO_LAYER_TYPE.get(region_label, LayerType.wall)
        layer = EditLayer(
            project_id=project_id,
            layer_type=layer_type,
            parameters={
                "source": "material",
                "region_label": region_label,
                "result_url": result_url,
                "mask_url": None,  # mask was transient (not persisted separately)
            },
            result_image_url=result_url,
            is_visible=True,
            order=0,
        )
        db.add(layer)
        project.status = ProjectStatus.completed
        db.commit()
        db.refresh(layer)

        elapsed = round(time.monotonic() - t_start, 2)
        logger.info(
            "material DONE: project=%d layer=%d region=%s elapsed=%.1fs",
            project_id,
            layer.id,
            region_label,
            elapsed,
        )

        return MaterialResult(
            result_url=result_url,
            layer_id=layer.id,
            elapsed_s=elapsed,
            region_label=region_label,
        )

    async def _auto_classify(
        self,
        room_image_url: str,
        mask_data: str,
    ) -> Optional[str]:
        """Run ADE20K segmentation workflow and classify the mask region."""
        classify_wf = self._wm.build_ade20k_classify_workflow(room_image_url)

        try:
            output = await self._client.run_async(
                workflow=classify_wf,
                timeout=_CLASSIFY_TIMEOUT_S,
                upload_result=False,
            )
        except Exception as exc:
            logger.warning("ADE20K classify failed: %s — skipping auto-detect", exc)
            return None

        ade20k_b64: Optional[str] = output.get("image_base64")
        if not ade20k_b64:
            logger.warning("ADE20K workflow returned no image")
            return None

        try:
            ade20k_img = _b64_to_pil(ade20k_b64)
            mask_img = _b64_to_pil(mask_data)
            return await asyncio.get_event_loop().run_in_executor(
                None, _classify_mask_region, ade20k_img, mask_img
            )
        except Exception as exc:
            logger.warning("ADE20K colour analysis failed: %s", exc)
            return None


# ── Helpers ───────────────────────────────────────────────────────────────────


def _set_project_status(db: Session, project_id: int, status: ProjectStatus) -> None:
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
