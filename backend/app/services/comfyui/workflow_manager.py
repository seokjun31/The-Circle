"""
WorkflowManager — ComfyUI workflow builder for The Circle
==========================================================

Loads ComfyUI API-format workflow JSONs from ``comfyui_workflows/`` and
injects runtime values (images, prompts, seeds, SDXL dimensions) before
submitting to RunPod.

Three core helpers
------------------
* ``load_and_inject_workflow(json_name, injections)``
    Deep-copy the named JSON and patch specific node inputs.

* ``calc_sdxl_size(w, h)``
    Calculate the optimal SDXL W×H for a given source resolution:
    ~1 MP target, 64-px bucket alignment, 512–1536 per-axis clamp.

* ``generate_room_prompt(image_b64, api_key)``
    Call Claude Vision (Anthropic) to auto-generate SDXL positive + negative
    prompts that describe the room's style, materials, and lighting.

Workflow catalogue
------------------
| Async method               | JSON file       | Use-case                       |
|---------------------------|-----------------|--------------------------------|
| build_mood_workflow        | mood.json       | Copy mood from reference image |
| build_material_workflow    | material.json   | Texture on masked surface      |
| build_furniture_workflow   | furniture.json  | Blend placed furniture         |
| build_lighting_workflow    | lighting.json   | Standalone lighting adjustment |
| build_full_render_workflow | full_render.json| Base + Refiner + 2× Upscale    |

Model names
-----------
All model name constants match the filenames downloaded by ``download_models.sh``.
"""

from __future__ import annotations

import base64
import copy
import io
import json
import logging
import math
import random
from pathlib import Path
from typing import Any, Optional, Union
from urllib.request import urlopen, Request
from urllib.error import URLError

from PIL import Image

logger = logging.getLogger(__name__)

# ── Workflow JSON directory ────────────────────────────────────────────────────
_WORKFLOWS_DIR = Path(__file__).parent.parent.parent.parent / "comfyui_workflows"


def _load_node_config(json_name: str) -> dict[str, str]:
    """
    Load an optional ``{json_name}.config.json`` node-ID mapping file.

    Allows local ComfyUI workflows to use different node IDs than the
    RunPod reference workflow without changing workflow_manager.py.

    Example mood.config.json::

        {
            "source_image":    "21",
            "reference_image": "23",
            "positive_prompt": "8",
            "negative_prompt": "9",
            "depth_controlnet": "10",
            "canny_controlnet": "13",
            "ipadapter_loader": "2",
            "ksampler":        "12",
            "ipadapter":       "5"
        }

    Returns an empty dict when no config file exists (uses hardcoded defaults).
    """
    config_path = _WORKFLOWS_DIR / f"{json_name}.config.json"
    if not config_path.exists():
        return {}
    with open(config_path, encoding="utf-8") as fh:
        return json.load(fh)


# ── Model names (must match files on the RunPod Network Volume) ───────────────
_CKPT_SDXL_BASE = "sd_xl_base_1.0.safetensors"
_CKPT_SDXL_REFINER = "sdxl_refiner_1.0.safetensors"
_VAE_SDXL = "sdxl_vae.safetensors"
_CLIP_VISION_H = "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"
_IPADAPTER_SDXL = "IP-Adapter-Plus_SDXL.safetensors"
_CN_DEPTH_SDXL = "controlnet-depth-sdxl-1.0.safetensors"
_CN_CANNY_SDXL = "controlnet-canny-sdxl-1.0.safetensors"
_UPSCALER = "RealESRGAN_x2plus.pth"

# ── Standard negative prompt ──────────────────────────────────────────────────
_NEGATIVE_BASE = (
    "people, person, human, text, watermark, logo, blurry, low quality, "
    "artifacts, distorted, oversaturated, cartoon, anime, illustration, "
    "painting, unrealistic, dark, gloomy"
)

# ── SDXL sizing constants ─────────────────────────────────────────────────────
_SDXL_TARGET_MP = 1024 * 1024  # 1 megapixel
_SDXL_BUCKET = 64  # snap to multiples of this
_SDXL_MIN = 512
_SDXL_MAX = 1536


# ═══════════════════════════════════════════════════════════════════════════════
#  Utilities
# ═══════════════════════════════════════════════════════════════════════════════


def _rand_seed() -> int:
    return random.randint(0, 2**32 - 1)


def _url_to_base64(url: str, timeout: int = 20) -> str:
    try:
        req = Request(url, headers={"User-Agent": "TheCircle/1.0"})
        with urlopen(req, timeout=timeout) as resp:
            data: bytes = resp.read()
        return base64.b64encode(data).decode("utf-8")
    except (URLError, Exception) as exc:
        raise ValueError(f"Failed to download image from {url!r}: {exc}") from exc


def _ensure_base64(image: Union[str, bytes]) -> str:
    """Accept URL, data-URL, local-upload path, raw base-64, or bytes; return raw base-64 string."""
    if isinstance(image, (bytes, bytearray)):
        return base64.b64encode(image).decode("utf-8")
    if isinstance(image, str):
        if image.startswith(("http://", "https://")):
            return _url_to_base64(image)
        if image.startswith("data:"):
            return image.split(",", 1)[-1]
        if image.startswith("/uploads/"):
            # Local storage URL  →  read from LOCAL_UPLOAD_DIR on disk
            from app.config import settings  # lazy import to avoid circular deps

            file_path = Path(settings.LOCAL_UPLOAD_DIR) / image[len("/uploads/") :]
            with open(file_path, "rb") as fh:
                return base64.b64encode(fh.read()).decode("utf-8")
        return image  # assume raw base-64
    raise TypeError(f"Unsupported image type: {type(image)}")


def _image_size_from_b64(image_b64: str) -> tuple[int, int]:
    """Return (width, height) by decoding base-64 bytes with PIL."""
    data = base64.b64decode(image_b64)
    with Image.open(io.BytesIO(data)) as img:
        return img.size  # (width, height)


# ═══════════════════════════════════════════════════════════════════════════════
#  WorkflowManager
# ═══════════════════════════════════════════════════════════════════════════════


class WorkflowManager:
    """
    Loads ComfyUI API-format workflows from JSON files and injects runtime
    values (images, prompts, seeds, SDXL-optimal dimensions) before submission.
    """

    # ──────────────────────────────────────────────────────────────────────────
    #  1. load_and_inject_workflow
    # ──────────────────────────────────────────────────────────────────────────

    def load_and_inject_workflow(
        self,
        json_name: str,
        injections: dict[str, dict[str, Any]],
        optional_nodes: set[str] = frozenset(),
    ) -> dict[str, Any]:
        """
        Load ``{json_name}.json`` from the comfyui_workflows directory,
        deep-copy it, and patch the specified node inputs.

        Only entries that contain a ``class_type`` key are kept; top-level
        metadata fields such as ``_comment`` and ``_description`` are stripped
        so the result is a valid ComfyUI API-format workflow.  Per-node
        ``_label`` and ``_comment`` keys are also removed.

        Args:
            json_name:       Filename without extension, e.g. ``"material"``.
            injections:      ``{ node_id: { input_field: value, … }, … }``
                             where node IDs are strings (ComfyUI API format).
            optional_nodes:  Node IDs that are silently skipped when absent from
                             the workflow (useful for local ComfyUI setups that
                             omit optional nodes like IPAdapterAdvanced).

        Returns:
            Deep-copied, patched workflow dict ready for submission.

        Raises:
            FileNotFoundError: Workflow JSON does not exist.
            KeyError:          A required node_id in *injections* is not in the workflow.
        """
        path = _WORKFLOWS_DIR / f"{json_name}.json"
        if not path.exists():
            raise FileNotFoundError(f"Workflow JSON not found: {path}")

        with open(path, encoding="utf-8") as fh:
            raw: dict[str, Any] = json.load(fh)

        # Keep only valid ComfyUI node entries
        workflow: dict[str, Any] = {
            k: copy.deepcopy(v)
            for k, v in raw.items()
            if isinstance(v, dict) and "class_type" in v
        }

        # Strip internal metadata keys from each node
        for node in workflow.values():
            node.pop("_label", None)
            node.pop("_comment", None)

        # Apply injections
        for node_id, fields in injections.items():
            if node_id not in workflow:
                if node_id in optional_nodes:
                    logger.debug(
                        "Optional node '%s' not found in workflow '%s' — skipping",
                        node_id,
                        json_name,
                    )
                    continue
                raise KeyError(f"Node '{node_id}' not found in workflow '{json_name}'")
            workflow[node_id]["inputs"].update(fields)

        return workflow

    # ──────────────────────────────────────────────────────────────────────────
    #  2. calc_sdxl_size
    # ──────────────────────────────────────────────────────────────────────────

    @staticmethod
    def calc_sdxl_size(w: int, h: int) -> tuple[int, int]:
        """
        Calculate the optimal SDXL generation resolution for a source image
        of size *w* × *h*.

        Algorithm:
          1. Scale both dimensions so total pixels ≈ 1 MP, preserving aspect ratio.
          2. Snap each dimension to the nearest 64-px bucket.
          3. Clamp each dimension to [512, 1536].

        Args:
            w: Source image width  (pixels).
            h: Source image height (pixels).

        Returns:
            ``(new_w, new_h)`` aligned to 64 px, clamped to [512, 1536].
        """
        aspect = w / h
        new_h = math.sqrt(_SDXL_TARGET_MP / aspect)
        new_w = _SDXL_TARGET_MP / new_h
        new_w = round(new_w / _SDXL_BUCKET) * _SDXL_BUCKET
        new_h = round(new_h / _SDXL_BUCKET) * _SDXL_BUCKET
        new_w = int(max(_SDXL_MIN, min(_SDXL_MAX, new_w)))
        new_h = int(max(_SDXL_MIN, min(_SDXL_MAX, new_h)))
        return new_w, new_h

    # ──────────────────────────────────────────────────────────────────────────
    #  3. generate_room_prompt
    # ──────────────────────────────────────────────────────────────────────────

    @staticmethod
    async def generate_room_prompt(
        image_b64: str,
        api_key: str,
        media_type: str = "image/jpeg",
    ) -> tuple[str, str]:
        """
        Call Claude Vision (Anthropic) to generate SDXL-style interior design
        prompts for the room in *image_b64*.

        Args:
            image_b64:  Raw base-64 image string (no ``data:`` prefix).
            api_key:    Anthropic API key.
            media_type: Image MIME type (default ``image/jpeg``).

        Returns:
            ``(positive_prompt, negative_prompt)`` as English comma-separated
            tag strings suitable for SDXL CLIPTextEncode nodes.

        Raises:
            ValueError:        If the API response is not valid JSON.
            anthropic.APIError: On API failure.
        """
        import anthropic

        client = anthropic.AsyncAnthropic(api_key=api_key)
        response = await client.messages.create(
            model="claude-opus-4-6",
            max_tokens=512,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": image_b64,
                            },
                        },
                        {
                            "type": "text",
                            "text": (
                                "You are an SDXL prompt engineer for photorealistic interior design AI.\n"
                                "Analyze this room photo and generate:\n"
                                "1. A positive SDXL prompt (comma-separated tags, max 120 words) describing "
                                "the interior style, materials, lighting, and desired photorealistic aesthetic.\n"
                                "2. A negative SDXL prompt (comma-separated tags) for artefacts to avoid.\n\n"
                                "Respond ONLY with valid JSON, no markdown fences:\n"
                                '{"positive": "...", "negative": "..."}'
                            ),
                        },
                    ],
                }
            ],
        )

        raw = response.content[0].text.strip()
        data = json.loads(raw)
        return str(data["positive"]), str(data["negative"])

    # ──────────────────────────────────────────────────────────────────────────
    #  Build methods
    # ──────────────────────────────────────────────────────────────────────────

    async def build_mood_workflow(
        self,
        source_image_url: Union[str, bytes],
        reference_image_url: Union[str, bytes],
        strength: float = 0.70,
        prompt: str = (
            "interior photography, beautiful lighting, high quality, 8k, "
            "professional photo, warm ambient light, realistic textures, soft shadows"
        ),
        negative_prompt: str = (
            "((built-in oven, microwave, square ceiling panels, black boxes on wall:1.5)),"
            "(CGI, 3D render:1.2), (mirror floor, extreme reflection, glossy floor:1.2), "
            "blurry, watercolor, painting, distorted, deformed, low quality, worst quality, "
            "cartoon, anime, illustration, sketch, oversaturated, spots, polka dots, holes, "
            "trypophobia, heavy noise, dirt, stain, black dots, wet floor, floating objects, "
            "dark spots on ceiling, unrealistic, square lights, ceiling vents, track lights, "
            "floating panels, cracked floor, broken marble, chaotic lines, complex ceiling, "
            "watermark, text, signature, logo"
        ),
        steps: int = 30,
        cfg: float = 5.0,
        denoise: float = 0.62,
        depth_strength: float = 0.85,
        canny_strength: float = 0.75,
        ipadapter_weight: float = 0.70,
        ipadapter_end_at: float = 0.77,
        seed: Optional[int] = None,
    ) -> dict[str, Any]:
        """
        Copy the mood, lighting, and atmosphere of a reference image onto
        the source room using IP-Adapter Advanced + dual ControlNet (Depth + Canny).

        Args:
            source_image_url:    Room to transform.
            reference_image_url: Inspiration / mood board image.
            strength:            0.5–0.9; used to derive IP-Adapter weight + denoise
                                 when explicit values are not provided.
            prompt:              Positive conditioning.
            negative_prompt:     Negative conditioning.
            steps:               KSampler steps.
            cfg:                 CFG scale.
            denoise:             KSampler denoise strength.
            depth_strength:      ControlNet Depth strength (0.5–1.0).
            canny_strength:      ControlNet Canny strength (0.3–0.9).
            ipadapter_weight:    IP-Adapter weight (0.4–0.9).
            ipadapter_end_at:    IP-Adapter end_at (0.5–1.0).
            seed:                Fixed seed; None = random.

        Returns:
            ComfyUI API-format workflow dict.
        """
        src_b64 = _ensure_base64(source_image_url)
        ref_b64 = _ensure_base64(reference_image_url)
        seed = seed if seed is not None else _rand_seed()

        # Load optional node-ID overrides (for local ComfyUI with different IDs)
        cfg_map = _load_node_config("mood")
        n = {
            "source_image": cfg_map.get("source_image", "1"),
            "reference_image": cfg_map.get("reference_image", "2"),
            "positive_prompt": cfg_map.get("positive_prompt", "4"),
            "negative_prompt": cfg_map.get("negative_prompt", "5"),
            "depth_controlnet": cfg_map.get("depth_controlnet", "10"),
            "canny_controlnet": cfg_map.get("canny_controlnet", "13"),
            "ipadapter_loader": cfg_map.get("ipadapter_loader", "14"),
            "ksampler": cfg_map.get("ksampler", "17"),
            "ipadapter": cfg_map.get("ipadapter", "24"),
        }

        injections = {
            n["source_image"]: {"image": src_b64},
            n["reference_image"]: {"image": ref_b64},
            n["positive_prompt"]: {"text": prompt},
            n["negative_prompt"]: {"text": negative_prompt},
            n["depth_controlnet"]: {"strength": depth_strength},
            n["ksampler"]: {
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "denoise": denoise,
            },
        }
        # Optional nodes — only inject if node exists in workflow
        optional = {n["ipadapter_loader"], n["ipadapter"], n["canny_controlnet"]}
        injections[n["ipadapter_loader"]] = {"ipadapter_file": _IPADAPTER_SDXL}
        injections[n["canny_controlnet"]] = {"strength": canny_strength}
        injections[n["ipadapter"]] = {
            "weight": ipadapter_weight,
            "end_at": ipadapter_end_at,
        }

        return self.load_and_inject_workflow(
            "mood", injections, optional_nodes=optional
        )

    async def build_material_workflow(
        self,
        image_url: Union[str, bytes],
        mask_data: Union[str, bytes],
        material_texture_url: Union[str, bytes],
        prompt: str = (
            "photorealistic interior, architectural photography, high-end material finish, "
            "seamless texture, perfect lighting, 8k resolution"
        ),
        negative_prompt: str = _NEGATIVE_BASE,
        ipadapter_weight: float = 0.55,
        controlnet_strength: float = 0.65,
        denoise: float = 0.88,
        steps: int = 28,
        cfg: float = 7.5,
        seed: Optional[int] = None,
    ) -> dict[str, Any]:
        """
        Apply a material texture to the masked surface area.

        Pipeline: IP-Adapter (material style) + ControlNet Depth (perspective)
        + VAEEncodeForInpaint (masked inpainting).

        Args:
            image_url:            Original room photo.
            mask_data:            White/black mask (white = area to retexture).
            material_texture_url: Seamless tile image (512×512+ recommended).
            prompt:               Positive prompt describing the desired material.
            negative_prompt:      Negative conditioning.
            ipadapter_weight:     IP-Adapter strength (0.4–0.7 recommended).
            controlnet_strength:  ControlNet depth strength (0.5–0.8).
            denoise:              Inpaint denoise strength (0.8–1.0).
            steps:                KSampler steps.
            cfg:                  CFG scale.
            seed:                 Fixed seed; None = random.

        Returns:
            ComfyUI API-format workflow dict.
        """
        img_b64 = _ensure_base64(image_url)
        mask_b64 = _ensure_base64(mask_data)
        mat_b64 = _ensure_base64(material_texture_url)
        seed = seed if seed is not None else _rand_seed()
        w, h = _image_size_from_b64(img_b64)
        nw, nh = self.calc_sdxl_size(w, h)

        return self.load_and_inject_workflow(
            "material",
            {
                "2": {"image": img_b64},
                "3": {"mask": mask_b64},
                "4": {"image": mat_b64},
                "5": {"ipadapter_file": _IPADAPTER_SDXL},
                "7": {"weight": ipadapter_weight},
                "10": {"text": prompt},
                "11": {"text": negative_prompt},
                "12": {"strength": controlnet_strength},
                "14": {
                    "seed": seed,
                    "steps": steps,
                    "cfg": cfg,
                    "denoise": denoise,
                },
                "100": {"width": nw, "height": nh},
            },
        )

    async def build_furniture_workflow(
        self,
        image_url: Union[str, bytes],
        furniture_image_url: Union[str, bytes],
        position: Optional[dict[str, float]] = None,
        scale: float = 1.0,
        prompt: str = (
            "photorealistic interior, furniture naturally placed in room, "
            "consistent lighting, soft shadow, architectural photography"
        ),
        negative_prompt: str = _NEGATIVE_BASE,
        blend_denoise: float = 0.55,
        steps: int = 20,
        cfg: float = 7.0,
        seed: Optional[int] = None,
    ) -> dict[str, Any]:
        """
        Blend a pre-composited furniture image into a room scene.

        Assumes the client has alpha-composited the furniture onto the room
        canvas and passed the result as *image_url*.

        Args:
            image_url:           Composite scene (room + placed furniture).
            furniture_image_url: Isolated furniture PNG (background removed).
            position:            Reserved for future use.
            scale:               Reserved for future use.
            prompt:              Positive blend conditioning.
            negative_prompt:     Negative conditioning.
            blend_denoise:       Inpaint denoise for edge blending (0.4–0.7).
            steps:               KSampler steps.
            cfg:                 CFG scale.
            seed:                Fixed seed; None = random.

        Returns:
            ComfyUI API-format workflow dict.
        """
        img_b64 = _ensure_base64(image_url)
        furn_b64 = _ensure_base64(furniture_image_url)
        seed = seed if seed is not None else _rand_seed()
        w, h = _image_size_from_b64(img_b64)
        nw, nh = self.calc_sdxl_size(w, h)

        return self.load_and_inject_workflow(
            "furniture",
            {
                "2": {"image": img_b64},
                "3": {"image": furn_b64},
                "6": {"text": prompt},
                "7": {"text": negative_prompt},
                "9": {
                    "seed": seed,
                    "steps": steps,
                    "cfg": cfg,
                    "denoise": blend_denoise,
                },
                "100": {"width": nw, "height": nh},
            },
        )

    async def build_lighting_workflow(
        self,
        image_url: Union[str, bytes],
        lighting: str = "soft natural daylight, warm interior lighting",
        negative_prompt: str = _NEGATIVE_BASE,
        denoise: float = 0.35,
        steps: int = 20,
        cfg: float = 7.0,
        seed: Optional[int] = None,
    ) -> dict[str, Any]:
        """
        Apply a lighting atmosphere to the room (SDXL Base img2img, low denoise).

        Uses a lighting-focused prompt with low denoise to change the atmosphere
        while preserving room structure and contents.

        Args:
            image_url:       Source room image.
            lighting:        Lighting description (e.g. "warm morning light").
            negative_prompt: Negative conditioning.
            denoise:         Denoise strength (0.25–0.45 recommended).
            steps:           KSampler steps.
            cfg:             CFG scale.
            seed:            Fixed seed; None = random.

        Returns:
            ComfyUI API-format workflow dict.
        """
        img_b64 = _ensure_base64(image_url)
        seed = seed if seed is not None else _rand_seed()
        w, h = _image_size_from_b64(img_b64)
        nw, nh = self.calc_sdxl_size(w, h)

        positive_text = (
            f"photorealistic interior architectural photography, {lighting}, "
            "professional interior design, natural atmosphere, 8k resolution"
        )

        return self.load_and_inject_workflow(
            "lighting",
            {
                "2": {"image": img_b64},
                "3": {"text": positive_text},
                "4": {"text": negative_prompt},
                "6": {
                    "seed": seed,
                    "steps": steps,
                    "cfg": cfg,
                    "denoise": denoise,
                },
                "100": {"width": nw, "height": nh},
            },
        )

    async def build_full_render_workflow(
        self,
        image_url: Union[str, bytes],
        lighting: str = "soft natural daylight, warm interior lighting",
        prompt_prefix: str = "",
        negative_prompt: str = _NEGATIVE_BASE,
        base_denoise: float = 0.30,
        base_steps: int = 40,
        refiner_steps: int = 10,
        cfg: float = 7.5,
        seed: Optional[int] = None,
    ) -> dict[str, Any]:
        """
        High-quality render pipeline: SDXL Base → Refiner → Real-ESRGAN 2×.

        Args:
            image_url:       Source room image (after all edits applied).
            lighting:        Lighting description appended to positive prompt.
            prompt_prefix:   Optional custom text prepended to the prompt.
            negative_prompt: Negative conditioning.
            base_denoise:    Base-stage denoise (0.25–0.45).
            base_steps:      Base-stage KSampler steps.
            refiner_steps:   Refiner steps.
            cfg:             CFG scale.
            seed:            Fixed seed; None = random.

        Returns:
            ComfyUI API-format workflow dict.
        """
        img_b64 = _ensure_base64(image_url)
        seed = seed if seed is not None else _rand_seed()
        w, h = _image_size_from_b64(img_b64)
        nw, nh = self.calc_sdxl_size(w, h)

        positive_text = (
            f"{prompt_prefix + ', ' if prompt_prefix else ''}"
            f"photorealistic interior architectural photography, {lighting}, "
            "8k resolution, perfect composition, ultra detailed, sharp focus, "
            "cinematic lighting, professional interior design"
        )

        total_steps = base_steps + refiner_steps
        return self.load_and_inject_workflow(
            "full_render",
            {
                "2": {"image": img_b64},
                "3": {"text": positive_text},
                "4": {"text": negative_prompt},
                "6": {
                    "noise_seed": seed,
                    "steps": total_steps,
                    "cfg": cfg,
                    "end_at_step": base_steps,
                },
                "8": {"text": positive_text},
                "9": {"text": negative_prompt},
                "10": {
                    "noise_seed": seed,
                    "steps": total_steps,
                    "cfg": cfg,
                    "start_at_step": base_steps,
                    "end_at_step": total_steps,
                },
                "100": {"width": nw, "height": nh},
            },
        )
