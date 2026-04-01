"""
FurnitureService — composite + AI-blend a furniture item into a room photo.

Pipeline
--------
1.  Load project original image (from URL → PIL)
2.  Load furniture image (PNG, transparent background — from DB URL or uploaded URL)
3.  Scale furniture to target_width_px (aspect ratio preserved)
4.  Alpha-composite furniture onto room at (position_x, position_y)
5.  Generate blend mask: furniture bounding box + 40 px dilation
6.  Encode composite + masked furniture as base64
7.  Call WorkflowManager.build_furniture_workflow()
8.  Submit to RunPod via RunPodClient.run_async() (timeout: 90 s)
9.  Save result to S3/local
10. Compute fit check (furniture_width_cm vs space_width_cm)
11. Create EditLayer(layer_type=furniture)
12. Return FurnitureResult

Fit-check categories
--------------------
    margin ≥ 20 cm  → "comfortable"  (green)
    margin ≥  0 cm  → "tight"        (yellow)
    margin <  0 cm  → "too_large"    (red)
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
from PIL import Image, ImageDraw
from sqlalchemy import update as sa_update
from sqlalchemy.orm import Session

from app.models.edit_layer import EditLayer, LayerType
from app.models.furniture import Furniture
from app.models.project import Project, ProjectStatus
from app.services.comfyui.runpod_client import RunPodClient, RunPodError
from app.services.comfyui.workflow_manager import WorkflowManager
from app.services.s3 import storage

logger = logging.getLogger("the_circle.furniture")

CREDITS_PER_PLACEMENT = 1
_PLACE_TIMEOUT_S      = 90


# ── Result types ──────────────────────────────────────────────────────────────

@dataclass
class FitCheck:
    fits:               bool
    furniture_width_cm: float
    space_width_cm:     float
    margin_cm:          float
    category:           str   # "comfortable" | "tight" | "too_large"


@dataclass
class FurnitureResult:
    result_url: str
    layer_id:   int
    elapsed_s:  float
    fit_check:  Optional[FitCheck]


# ── Image helpers ─────────────────────────────────────────────────────────────

def _load_image_from_url(url: str) -> Image.Image:
    resp = httpx.get(url, timeout=20, follow_redirects=True)
    resp.raise_for_status()
    return Image.open(io.BytesIO(resp.content))


def _image_to_b64(img: Image.Image, fmt: str = "JPEG") -> str:
    buf = io.BytesIO()
    if fmt == "JPEG":
        img = img.convert("RGB")
    img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _make_blend_mask(
    canvas_w: int,
    canvas_h: int,
    furn_x: int,
    furn_y: int,
    furn_w: int,
    furn_h: int,
    dilation: int = 40,
) -> Image.Image:
    mask = Image.new("L", (canvas_w, canvas_h), 0)
    draw = ImageDraw.Draw(mask)
    x0 = max(0, furn_x - dilation)
    y0 = max(0, furn_y - dilation)
    x1 = min(canvas_w, furn_x + furn_w + dilation)
    y1 = min(canvas_h, furn_y + furn_h + dilation)
    draw.rectangle([x0, y0, x1, y1], fill=255)
    return mask


def _compute_fit_check(
    furniture_width_cm: Optional[float],
    space_width_cm: Optional[float],
) -> Optional[FitCheck]:
    if furniture_width_cm is None or space_width_cm is None:
        return None
    margin = space_width_cm - furniture_width_cm
    if margin >= 20:
        cat = "comfortable"
    elif margin >= 0:
        cat = "tight"
    else:
        cat = "too_large"
    return FitCheck(
        fits               = margin >= 0,
        furniture_width_cm = round(furniture_width_cm, 1),
        space_width_cm     = round(space_width_cm, 1),
        margin_cm          = round(margin, 1),
        category           = cat,
    )


# ── Service ───────────────────────────────────────────────────────────────────

class FurnitureService:
    """Orchestrate the full furniture-placement pipeline."""

    def __init__(self) -> None:
        self._wm     = WorkflowManager()
        self._runpod = RunPodClient()

    async def place_furniture(
        self,
        project_id:           int,
        user_id:              int,
        db:                   Session,
        furniture_id:         Optional[int]   = None,
        furniture_image_url:  Optional[str]   = None,
        furniture_width_cm:   Optional[float] = None,
        furniture_height_cm:  Optional[float] = None,
        space_width_cm:       Optional[float] = None,
        position_x:           int             = 0,
        position_y:           int             = 0,
        target_width_px:      int             = 200,
    ) -> FurnitureResult:
        """
        Composite a furniture PNG onto a room image and AI-blend it.

        Args:
            project_id:          Target project.
            user_id:             Project owner.
            db:                  SQLAlchemy session.
            furniture_id:        DB Furniture record ID (optional).
            furniture_image_url: Direct image URL (alternative to furniture_id).
            furniture_width_cm:  Actual furniture width in cm (for fit check).
            furniture_height_cm: Actual furniture height in cm.
            space_width_cm:      Available space width in cm (for fit check).
            position_x:          Top-left X in original-image pixels.
            position_y:          Top-left Y in original-image pixels.
            target_width_px:     Desired rendered width in pixels.

        Returns:
            FurnitureResult with result_url, layer_id, fit_check, elapsed_s.

        Raises:
            ValueError:  Missing data or furniture not found.
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

        # ── 2. Resolve furniture source ───────────────────────────────────────
        furn_meta: Optional[Furniture] = None
        if furniture_id is not None:
            furn_meta = db.get(Furniture, furniture_id)
            if not furn_meta:
                raise ValueError(f"Furniture {furniture_id} not found")
            if not furn_meta.image_url and not furniture_image_url:
                raise ValueError(f"Furniture {furniture_id} has no image URL")

        furn_url = furniture_image_url or (furn_meta.image_url if furn_meta else None)
        if not furn_url:
            raise ValueError(
                "Provide either furniture_id (with image_url) or furniture_image_url"
            )

        fw_cm = furniture_width_cm  or (furn_meta.width_cm  if furn_meta else None)
        fh_cm = furniture_height_cm or (furn_meta.height_cm if furn_meta else None)

        logger.info(
            "furniture START: project=%d furniture_id=%s pos=(%d,%d) w_px=%d",
            project_id, furniture_id, position_x, position_y, target_width_px,
        )

        # ── 3. Load images (PIL) ──────────────────────────────────────────────
        room_img = _load_image_from_url(project.original_image_url).convert("RGBA")
        furn_img = _load_image_from_url(furn_url).convert("RGBA")

        # ── 4. Scale furniture to target_width_px ─────────────────────────────
        orig_w, orig_h = furn_img.size
        scale    = target_width_px / orig_w
        scaled_w = target_width_px
        scaled_h = max(1, round(orig_h * scale))
        furn_scaled = furn_img.resize((scaled_w, scaled_h), Image.LANCZOS)

        # ── 5. Clamp position to canvas bounds ────────────────────────────────
        canvas_w, canvas_h = room_img.size
        px = max(0, min(position_x, canvas_w - scaled_w))
        py = max(0, min(position_y, canvas_h - scaled_h))

        # ── 6. Alpha-composite furniture onto room ────────────────────────────
        composite = room_img.copy()
        composite.alpha_composite(furn_scaled, dest=(px, py))
        composite_rgb = composite.convert("RGB")

        # ── 7. Generate blend mask ────────────────────────────────────────────
        blend_mask = _make_blend_mask(
            canvas_w, canvas_h, px, py, scaled_w, scaled_h, dilation=40
        )

        # ── 8. Build ComfyUI workflow ─────────────────────────────────────────
        composite_b64 = _image_to_b64(composite_rgb, fmt="JPEG")
        furn_b64      = _image_to_b64(furn_scaled,   fmt="PNG")

        workflow = self._wm.build_furniture_workflow(
            image_url           = composite_b64,
            furniture_image_url = furn_b64,
        )

        # ── 9. Submit to RunPod ───────────────────────────────────────────────
        project.status = ProjectStatus.processing
        db.commit()

        try:
            output = await self._runpod.run_async(
                workflow      = workflow,
                timeout       = _PLACE_TIMEOUT_S,
                upload_result = False,
            )
        except RunPodError:
            _set_project_status(db, project_id, ProjectStatus.error)
            raise

        # ── 10. Decode + save result ──────────────────────────────────────────
        img_b64_out: Optional[str] = output.get("image_base64")
        if not img_b64_out:
            _set_project_status(db, project_id, ProjectStatus.error)
            raise ValueError("RunPod returned no image_base64 in output")

        try:
            result_bytes = base64.b64decode(img_b64_out)
        except Exception as exc:
            _set_project_status(db, project_id, ProjectStatus.error)
            raise ValueError(f"RunPod 결과 base64 디코딩 실패: {exc}") from exc

        result_key = storage.project_key(
            user_id, project_id,
            f"results/furniture_{uuid.uuid4().hex[:8]}.jpg",
        )
        result_url = storage.upload(
            data         = result_bytes,
            key          = result_key,
            content_type = "image/jpeg",
            public       = True,
        )

        # ── 11. Fit check ─────────────────────────────────────────────────────
        fit_check = _compute_fit_check(fw_cm, space_width_cm)

        # ── 12. Create EditLayer ──────────────────────────────────────────────
        params: dict = {
            "position_x":       px,
            "position_y":       py,
            "target_width_px":  scaled_w,
            "target_height_px": scaled_h,
            "result_url":       result_url,
            "source":           "furniture",
        }
        if furniture_id:
            params["furniture_id"] = furniture_id
        if fw_cm:
            params["furniture_width_cm"] = fw_cm
        if fh_cm:
            params["furniture_height_cm"] = fh_cm
        if fit_check:
            params["fit_check"] = {
                "fits":             fit_check.fits,
                "margin_cm":        fit_check.margin_cm,
                "space_width_cm":   fit_check.space_width_cm,
                "category":         fit_check.category,
            }

        layer = EditLayer(
            project_id       = project_id,
            layer_type       = LayerType.furniture,
            parameters       = params,
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
            "furniture DONE: project=%d layer=%d result_url=%s elapsed=%.1fs",
            project_id, layer.id, result_url, elapsed,
        )

        return FurnitureResult(
            result_url = result_url,
            layer_id   = layer.id,
            elapsed_s  = elapsed,
            fit_check  = fit_check,
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


# ── Module-level singleton ────────────────────────────────────────────────────
furniture_service = FurnitureService()
