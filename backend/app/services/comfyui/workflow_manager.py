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
| Async method                   | JSON file               | Use-case                       |
|-------------------------------|-------------------------|--------------------------------|
| build_circle_ai_workflow      | circle_ai.json          | Full-room style transform      |
| build_material_apply_workflow | material_apply.json     | Texture on masked surface      |
| build_mood_copy_workflow      | mood_copy.json          | Copy mood from reference image |
| build_furniture_place_workflow| furniture_place.json    | Blend placed furniture         |
| build_final_render_workflow   | final_render.json       | Base + Refiner + 2× Upscale    |
|                               | final_render_simple.json| Base only (standard quality)   |

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
_WORKFLOWS_DIR = (
    Path(__file__).parent.parent.parent.parent / "comfyui_workflows"
)

# ── Model names (must match files on the RunPod Network Volume) ───────────────
_CKPT_SDXL_BASE    = "sd_xl_base_1.0.safetensors"
_CKPT_SDXL_REFINER = "sdxl_refiner_1.0.safetensors"
_VAE_SDXL          = "sdxl_vae.safetensors"
_CLIP_VISION_H     = "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"
_IPADAPTER_SDXL    = "IP-Adapter-Plus_SDXL.safetensors"
_CN_DEPTH_SDXL     = "controlnet-depth-sdxl-1.0.safetensors"
_CN_CANNY_SDXL     = "controlnet-canny-sdxl-1.0.safetensors"
_LORA_KR_APT       = "korea-apartment-style_v1.safetensors"
_UPSCALER          = "RealESRGAN_x2plus.pth"

# ── Standard negative prompt ──────────────────────────────────────────────────
_NEGATIVE_BASE = (
    "people, person, human, text, watermark, logo, blurry, low quality, "
    "artifacts, distorted, oversaturated, cartoon, anime, illustration, "
    "painting, unrealistic, dark, gloomy"
)

# ── SDXL sizing constants ─────────────────────────────────────────────────────
_SDXL_TARGET_MP = 1024 * 1024   # 1 megapixel
_SDXL_BUCKET    = 64            # snap to multiples of this
_SDXL_MIN       = 512
_SDXL_MAX       = 1536


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
    """Accept URL, data-URL, raw base-64, or bytes; return raw base-64 string."""
    if isinstance(image, (bytes, bytearray)):
        return base64.b64encode(image).decode("utf-8")
    if isinstance(image, str):
        if image.startswith(("http://", "https://")):
            return _url_to_base64(image)
        if image.startswith("data:"):
            return image.split(",", 1)[-1]
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
    ) -> dict[str, Any]:
        """
        Load ``{json_name}.json`` from the comfyui_workflows directory,
        deep-copy it, and patch the specified node inputs.

        Only entries that contain a ``class_type`` key are kept; top-level
        metadata fields such as ``_comment`` and ``_description`` are stripped
        so the result is a valid ComfyUI API-format workflow.  Per-node
        ``_label`` and ``_comment`` keys are also removed.

        Args:
            json_name:   Filename without extension, e.g. ``"material_apply"``.
            injections:  ``{ node_id: { input_field: value, … }, … }``
                         where node IDs are strings (ComfyUI API format).

        Returns:
            Deep-copied, patched workflow dict ready for submission.

        Raises:
            FileNotFoundError: Workflow JSON does not exist.
            KeyError:          A node_id in *injections* is not in the workflow.
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
                raise KeyError(
                    f"Node '{node_id}' not found in workflow '{json_name}'"
                )
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
        new_h  = math.sqrt(_SDXL_TARGET_MP / aspect)
        new_w  = _SDXL_TARGET_MP / new_h
        new_w  = round(new_w / _SDXL_BUCKET) * _SDXL_BUCKET
        new_h  = round(new_h / _SDXL_BUCKET) * _SDXL_BUCKET
        new_w  = int(max(_SDXL_MIN, min(_SDXL_MAX, new_w)))
        new_h  = int(max(_SDXL_MIN, min(_SDXL_MAX, new_h)))
        return new_w, new_h

    # ──────────────────────────────────────────────────────────────────────────
    #  3. generate_room_prompt
    # ──────────────────────────────────────────────────────────────────────────

    @staticmethod
    async def generate_room_prompt(
        image_b64:  str,
        api_key:    str,
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

        client   = anthropic.AsyncAnthropic(api_key=api_key)
        response = await client.messages.create(
            model      = "claude-opus-4-6",
            max_tokens = 512,
            messages   = [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type":       "base64",
                                "media_type": media_type,
                                "data":       image_b64,
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

        raw  = response.content[0].text.strip()
        data = json.loads(raw)
        return str(data["positive"]), str(data["negative"])

    # ──────────────────────────────────────────────────────────────────────────
    #  Build methods
    # ──────────────────────────────────────────────────────────────────────────

    async def build_circle_ai_workflow(
        self,
        image_url:        Union[str, bytes],
        style_prompt:     str,
        denoise_strength: float = 0.65,
        negative_prompt:  str   = _NEGATIVE_BASE,
        steps:            int   = 25,
        cfg:              float = 7.0,
        seed:             Optional[int] = None,
        use_lora:         bool  = True,
    ) -> dict[str, Any]:
        """
        Transform an entire room image to match a style prompt (img2img).

        Uses SDXL-base with Korea-apartment LoRA and ControlNet Canny for
        structural line preservation.  Node 100 rescales the input image to
        the optimal SDXL resolution before processing.

        Args:
            image_url:        Room photo (URL, base-64, or bytes).
            style_prompt:     Positive style description in English.
            denoise_strength: 0.0 = keep original, 1.0 = full generation.
            negative_prompt:  Negative conditioning text.
            steps:            KSampler denoising steps.
            cfg:              Classifier-free guidance scale.
            seed:             Fixed seed; None = random.
            use_lora:         Apply the Korea-apartment LoRA (disable via weight=0).

        Returns:
            ComfyUI API-format workflow dict.
        """
        img_b64       = _ensure_base64(image_url)
        seed          = seed if seed is not None else _rand_seed()
        w, h          = _image_size_from_b64(img_b64)
        nw, nh        = self.calc_sdxl_size(w, h)
        lora_strength = 0.7 if use_lora else 0.0

        return self.load_and_inject_workflow("circle_ai", {
            "4":   {"image": img_b64},
            "20":  {"strength_model": lora_strength, "strength_clip": lora_strength},
            "2":   {"text": style_prompt},
            "3":   {"text": negative_prompt},
            "9":   {
                "seed":    seed,
                "steps":   steps,
                "cfg":     cfg,
                "denoise": denoise_strength,
            },
            "100": {"width": nw, "height": nh},
        })

    async def build_material_apply_workflow(
        self,
        image_url:            Union[str, bytes],
        mask_data:            Union[str, bytes],
        material_texture_url: Union[str, bytes],
        prompt:               str   = (
            "photorealistic interior, architectural photography, high-end material finish, "
            "seamless texture, perfect lighting, 8k resolution"
        ),
        negative_prompt:      str   = _NEGATIVE_BASE,
        ipadapter_weight:     float = 0.55,
        controlnet_strength:  float = 0.65,
        denoise:              float = 0.88,
        steps:                int   = 28,
        cfg:                  float = 7.5,
        seed:                 Optional[int] = None,
    ) -> dict[str, Any]:
        """
        Apply a material texture to the masked surface area.

        Pipeline: IP-Adapter (material style) + ControlNet Depth (perspective)
        + VAEEncodeForInpaint (masked inpainting).  Node 100 rescales the room
        image to optimal SDXL dimensions; the mask is auto-resized by
        ComfyUI's VAEEncodeForInpaint node.

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
        img_b64  = _ensure_base64(image_url)
        mask_b64 = _ensure_base64(mask_data)
        mat_b64  = _ensure_base64(material_texture_url)
        seed     = seed if seed is not None else _rand_seed()
        w, h     = _image_size_from_b64(img_b64)
        nw, nh   = self.calc_sdxl_size(w, h)

        return self.load_and_inject_workflow("material_apply", {
            "2":   {"image": img_b64},
            "3":   {"mask":  mask_b64},
            "4":   {"image": mat_b64},
            "5":   {"ipadapter_file": _IPADAPTER_SDXL},
            "7":   {"weight": ipadapter_weight},
            "10":  {"text": prompt},
            "11":  {"text": negative_prompt},
            "12":  {"strength": controlnet_strength},
            "14":  {
                "seed":    seed,
                "steps":   steps,
                "cfg":     cfg,
                "denoise": denoise,
            },
            "100": {"width": nw, "height": nh},
        })

    async def build_mood_copy_workflow(
        self,
        source_image_url:    Union[str, bytes],
        reference_image_url: Union[str, bytes],
        strength:            float = 0.70,
        prompt:              str   = (
            "photorealistic interior photography, perfect lighting, "
            "architectural visualization, 8k resolution"
        ),
        negative_prompt:     str   = _NEGATIVE_BASE,
        steps:               int   = 25,
        cfg:                 float = 7.0,
        seed:                Optional[int] = None,
    ) -> dict[str, Any]:
        """
        Copy the mood, lighting, and atmosphere of a reference image onto
        the source room (img2img via IP-Adapter).

        Args:
            source_image_url:    Room to transform.
            reference_image_url: Inspiration / mood board image.
            strength:            0.5–0.9; maps to IP-Adapter weight + denoise.
            prompt:              Additional positive conditioning.
            negative_prompt:     Negative conditioning.
            steps:               KSampler steps.
            cfg:                 CFG scale.
            seed:                Fixed seed; None = random.

        Returns:
            ComfyUI API-format workflow dict.
        """
        src_b64     = _ensure_base64(source_image_url)
        ref_b64     = _ensure_base64(reference_image_url)
        seed        = seed if seed is not None else _rand_seed()
        w, h        = _image_size_from_b64(src_b64)
        nw, nh      = self.calc_sdxl_size(w, h)
        ipadapter_w = min(strength + 0.1, 0.95)
        denoise     = max(strength - 0.1, 0.30)

        return self.load_and_inject_workflow("mood_copy", {
            "2":   {"image": src_b64},
            "3":   {"image": ref_b64},
            "4":   {"ipadapter_file": _IPADAPTER_SDXL},
            "6":   {"weight": ipadapter_w},
            "7":   {"text": prompt},
            "8":   {"text": negative_prompt},
            "10":  {
                "seed":    seed,
                "steps":   steps,
                "cfg":     cfg,
                "denoise": denoise,
            },
            "100": {"width": nw, "height": nh},
        })

    async def build_furniture_place_workflow(
        self,
        image_url:           Union[str, bytes],
        furniture_image_url: Union[str, bytes],
        position:            Optional[dict[str, float]] = None,
        scale:               float = 1.0,
        prompt:              str   = (
            "photorealistic interior, furniture naturally placed in room, "
            "consistent lighting, soft shadow, architectural photography"
        ),
        negative_prompt:     str   = _NEGATIVE_BASE,
        blend_denoise:       float = 0.55,
        steps:               int   = 20,
        cfg:                 float = 7.0,
        seed:                Optional[int] = None,
    ) -> dict[str, Any]:
        """
        Blend a pre-composited furniture image into a room scene.

        Assumes the client has alpha-composited the furniture onto the room
        canvas and passed the result as *image_url*.  The workflow uses
        inpainting around the furniture boundary to remove artefacts and
        add natural shadows.

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
        img_b64  = _ensure_base64(image_url)
        furn_b64 = _ensure_base64(furniture_image_url)
        seed     = seed if seed is not None else _rand_seed()
        w, h     = _image_size_from_b64(img_b64)
        nw, nh   = self.calc_sdxl_size(w, h)

        return self.load_and_inject_workflow("furniture_place", {
            "2":   {"image": img_b64},
            "3":   {"image": furn_b64},
            "6":   {"text": prompt},
            "7":   {"text": negative_prompt},
            "9":   {
                "seed":    seed,
                "steps":   steps,
                "cfg":     cfg,
                "denoise": blend_denoise,
            },
            "100": {"width": nw, "height": nh},
        })

    async def build_final_render_workflow(
        self,
        image_url:     Union[str, bytes],
        lighting:      str   = "soft natural daylight, warm interior lighting",
        quality:       str   = "high",
        prompt_prefix: str   = "",
        negative_prompt: str = _NEGATIVE_BASE,
        base_denoise:  float = 0.45,
        base_steps:    int   = 20,
        refiner_steps: int   = 10,
        cfg:           float = 7.5,
        seed:          Optional[int] = None,
        upscale:       bool  = True,
    ) -> dict[str, Any]:
        """
        High-quality render pipeline.

        * ``upscale=True``  (quality="high"):  SDXL Base → Refiner → Real-ESRGAN 2×.
        * ``upscale=False`` (quality="standard"): SDXL Base only, no refiner.

        Args:
            image_url:       Source room image (after all edits applied).
            lighting:        Lighting description appended to positive prompt.
            quality:         ``"high"`` (more steps + refiner) or ``"standard"``.
            prompt_prefix:   Optional custom text prepended to the prompt.
            negative_prompt: Negative conditioning.
            base_denoise:    Base-stage denoise (0.3–0.6).
            base_steps:      Base-stage KSampler steps.
            refiner_steps:   Refiner steps (ignored when ``upscale=False``).
            cfg:             CFG scale.
            seed:            Fixed seed; None = random.
            upscale:         Use Real-ESRGAN 2× + Refiner when True.

        Returns:
            ComfyUI API-format workflow dict.
        """
        img_b64 = _ensure_base64(image_url)
        seed    = seed if seed is not None else _rand_seed()
        w, h    = _image_size_from_b64(img_b64)
        nw, nh  = self.calc_sdxl_size(w, h)

        if quality == "fast":
            base_steps    = max(base_steps - 8, 10)
            refiner_steps = max(refiner_steps - 4, 5)

        positive_text = (
            f"{prompt_prefix + ', ' if prompt_prefix else ''}"
            f"photorealistic interior architectural photography, {lighting}, "
            "8k resolution, perfect composition, ultra detailed, sharp focus, "
            "cinematic lighting, professional interior design"
        )

        if upscale:
            total_steps = base_steps + refiner_steps
            return self.load_and_inject_workflow("final_render", {
                "2":   {"image": img_b64},
                "3":   {"text": positive_text},
                "4":   {"text": negative_prompt},
                "6":   {
                    "noise_seed":  seed,
                    "steps":       total_steps,
                    "cfg":         cfg,
                    "end_at_step": base_steps,
                },
                "8":   {"text": positive_text},
                "9":   {"text": negative_prompt},
                "10":  {
                    "noise_seed":    seed,
                    "steps":         total_steps,
                    "cfg":           cfg,
                    "start_at_step": base_steps,
                    "end_at_step":   total_steps,
                },
                "100": {"width": nw, "height": nh},
            })
        else:
            return self.load_and_inject_workflow("final_render_simple", {
                "2":   {"image": img_b64},
                "3":   {"text": positive_text},
                "4":   {"text": negative_prompt},
                "6":   {
                    "seed":    seed,
                    "steps":   base_steps,
                    "cfg":     cfg,
                    "denoise": base_denoise,
                },
                "100": {"width": nw, "height": nh},
            })
