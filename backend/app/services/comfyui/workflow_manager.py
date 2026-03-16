"""
WorkflowManager — ComfyUI workflow builder for The Circle
==========================================================

Each public method returns a *ComfyUI API-format* workflow dict that can be
sent directly to a RunPod Serverless endpoint or to a local ComfyUI instance.

Node conventions
----------------
All workflows use ``ETN_LoadImageBase64`` / ``ETN_LoadMaskBase64``
(from ComfyUI_Essentials) so images travel as Base-64 strings — no file
upload to ComfyUI required.

Image inputs can be supplied either as:
  - A data-URL / raw base-64 string   →  passed straight through
  - An HTTP/S URL                      →  downloaded and converted by
                                          ``_url_to_base64()``

Model names must match files installed on the RunPod Network Volume
(see ``download_models.sh``).

Workflow catalogue
------------------
| Method                        | Use-case                                |
|-------------------------------|-----------------------------------------|
| build_circle_ai_workflow      | Full-room style + atmosphere transform  |
| build_material_apply_workflow | Apply texture to masked surface         |
| build_mood_copy_workflow      | Copy mood / lighting from reference     |
| build_furniture_place_workflow| Blend placed furniture into room        |
| build_final_render_workflow   | High-quality SDXL-base + refiner render |
"""

from __future__ import annotations

import base64
import copy
import io
import logging
import random
from typing import Any, Optional, Union
from urllib.request import urlopen, Request
from urllib.error import URLError

logger = logging.getLogger(__name__)

# ── Model names (must match files on Network Volume) ─────────────────────────
_CKPT_SDXL_BASE     = "sdxl_base_1.0.safetensors"
_CKPT_SDXL_REFINER  = "sdxl_refiner_1.0.safetensors"
_VAE_SDXL           = "sdxl_vae.safetensors"
_CLIP_VISION_H      = "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"
_IPADAPTER_SDXL     = "ip-adapter-plus_sdxl_vit-h.bin"
_CN_DEPTH_SDXL      = "controlnet-depth-sdxl-1.0.safetensors"
_CN_CANNY_SDXL      = "controlnet-canny-sdxl-1.0.safetensors"
_LORA_KR_APT        = "korea-apartment-style_v1.safetensors"
_UPSCALER           = "RealESRGAN_x2plus.pth"

# ── Standard prompts ──────────────────────────────────────────────────────────
_NEGATIVE_BASE = (
    "people, person, human, text, watermark, logo, blurry, low quality, "
    "artifacts, distorted, oversaturated, cartoon, anime, illustration, "
    "painting, unrealistic, dark, gloomy"
)


# ═══════════════════════════════════════════════════════════════════════════════
#  Utilities
# ═══════════════════════════════════════════════════════════════════════════════

def _rand_seed() -> int:
    """Generate a random ComfyUI-compatible seed."""
    return random.randint(0, 2**32 - 1)


def _url_to_base64(url: str, timeout: int = 20) -> str:
    """
    Download an image from *url* and return it as a raw base-64 string.

    Args:
        url:     HTTP/S image URL.
        timeout: Request timeout in seconds.

    Returns:
        Base-64-encoded image bytes (no ``data:`` prefix).

    Raises:
        ValueError: If the download fails.
    """
    try:
        req = Request(url, headers={"User-Agent": "TheCircle/1.0"})
        with urlopen(req, timeout=timeout) as resp:
            data: bytes = resp.read()
        return base64.b64encode(data).decode("utf-8")
    except (URLError, Exception) as exc:
        raise ValueError(f"Failed to download image from {url!r}: {exc}") from exc


def _ensure_base64(image: Union[str, bytes]) -> str:
    """
    Accept either a base-64 string, a data-URL, an HTTP URL, or raw bytes
    and always return a raw base-64 string.

    Args:
        image: Image as base-64 str, data-URL, HTTP URL, or raw bytes.

    Returns:
        Raw base-64 string (no ``data:`` prefix).
    """
    if isinstance(image, (bytes, bytearray)):
        return base64.b64encode(image).decode("utf-8")

    if isinstance(image, str):
        # HTTP(S) URL — download first
        if image.startswith(("http://", "https://")):
            return _url_to_base64(image)
        # Data-URL → strip header
        if image.startswith("data:"):
            return image.split(",", 1)[-1]
        # Assume raw base-64
        return image

    raise TypeError(f"Unsupported image type: {type(image)}")


def _deep(obj: Any) -> Any:
    """Return a deep copy of *obj*."""
    return copy.deepcopy(obj)


# ═══════════════════════════════════════════════════════════════════════════════
#  WorkflowManager
# ═══════════════════════════════════════════════════════════════════════════════

class WorkflowManager:
    """
    Builds ComfyUI API-format workflow dicts for each The Circle feature.

    All methods are synchronous (image downloads happen inline).  For
    high-throughput use, run them in a thread-pool executor.

    Example::

        wm = WorkflowManager()
        workflow = wm.build_material_apply_workflow(
            image_url       = "https://…/room.jpg",
            mask_data       = mask_b64,
            material_texture_url = "https://…/oak_floor.jpg",
        )
        result = await runpod_client.run(workflow)
    """

    # ──────────────────────────────────────────────────────────────────────────
    #  1. Circle AI — full-room style transform
    # ──────────────────────────────────────────────────────────────────────────

    def build_circle_ai_workflow(
        self,
        image_url: Union[str, bytes],
        style_prompt: str,
        denoise_strength: float = 0.65,
        negative_prompt: str = _NEGATIVE_BASE,
        steps: int = 25,
        cfg: float = 7.0,
        seed: Optional[int] = None,
        use_lora: bool = True,
    ) -> dict[str, Any]:
        """
        Transform an entire room image to match a style prompt (img2img).

        Uses SDXL-base with an optional Korea-apartment LoRA for localised style.
        ControlNet Canny preserves the room's structural lines.

        Args:
            image_url:        Original room photo (URL, base-64, or bytes).
            style_prompt:     Positive style description in English.
            denoise_strength: 0.0 = keep original, 1.0 = full generation.
                              Recommended range: 0.45–0.75.
            negative_prompt:  Negative conditioning text.
            steps:            KSampler denoising steps (15–40).
            cfg:              Classifier-free guidance scale (6–9).
            seed:             Fixed seed for reproducibility; None = random.
            use_lora:         Inject the Korea-apartment LoRA if available.

        Returns:
            ComfyUI API-format workflow dict.
        """
        img_b64 = _ensure_base64(image_url)
        seed    = seed if seed is not None else _rand_seed()

        # Base model (optionally with LoRA)
        model_ref   = ["1", 0]
        clip_ref    = ["1", 1]
        vae_ref     = ["1", 2]
        workflow: dict[str, Any] = {}

        # Node 1: Load SDXL checkpoint
        workflow["1"] = {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": _CKPT_SDXL_BASE},
        }

        if use_lora:
            # Node 20: LoRA (Korea apartment style)
            workflow["20"] = {
                "class_type": "LoraLoader",
                "inputs": {
                    "model":           ["1", 0],
                    "clip":            ["1", 1],
                    "lora_name":       _LORA_KR_APT,
                    "strength_model":  0.7,
                    "strength_clip":   0.7,
                },
            }
            model_ref = ["20", 0]
            clip_ref  = ["20", 1]

        # Node 2 & 3: CLIP text encoding
        workflow["2"] = {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": style_prompt, "clip": clip_ref},
        }
        workflow["3"] = {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": negative_prompt, "clip": clip_ref},
        }

        # Node 4: Load source image
        workflow["4"] = {
            "class_type": "ETN_LoadImageBase64",
            "inputs": {"image": img_b64},
        }

        # Node 5: Canny edge preprocessor (structural line preservation)
        workflow["5"] = {
            "class_type": "CannyEdgePreprocessor",
            "inputs": {"image": ["4", 0], "low_threshold": 80, "high_threshold": 200},
        }

        # Node 6: ControlNet Canny loader
        workflow["6"] = {
            "class_type": "ControlNetLoader",
            "inputs": {"control_net_name": _CN_CANNY_SDXL},
        }

        # Node 7: Apply ControlNet (canny) to conditioning
        workflow["7"] = {
            "class_type": "ControlNetApplyAdvanced",
            "inputs": {
                "positive":      ["2", 0],
                "negative":      ["3", 0],
                "control_net":   ["6", 0],
                "image":         ["5", 0],
                "strength":      0.55,
                "start_percent": 0.0,
                "end_percent":   0.7,
            },
        }

        # Node 8: VAE Encode (img2img latent)
        workflow["8"] = {
            "class_type": "VAEEncode",
            "inputs": {"pixels": ["4", 0], "vae": vae_ref},
        }

        # Node 9: KSampler
        workflow["9"] = {
            "class_type": "KSampler",
            "inputs": {
                "model":         model_ref,
                "positive":      ["7", 0],
                "negative":      ["7", 1],
                "latent_image":  ["8", 0],
                "seed":          seed,
                "steps":         steps,
                "cfg":           cfg,
                "sampler_name":  "dpmpp_2m",
                "scheduler":     "karras",
                "denoise":       denoise_strength,
            },
        }

        # Node 10: VAE Decode
        workflow["10"] = {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["9", 0], "vae": vae_ref},
        }

        # Node 11: Save result
        workflow["11"] = {
            "class_type": "SaveImage",
            "inputs": {"images": ["10", 0], "filename_prefix": "circle_ai"},
        }

        return workflow

    # ──────────────────────────────────────────────────────────────────────────
    #  2. Material Apply — IP-Adapter + ControlNet(Depth) + Inpainting
    # ──────────────────────────────────────────────────────────────────────────

    def build_material_apply_workflow(
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

        ★ Design decision: uses IP-Adapter + ControlNet(Depth) + Inpainting.
        ★ Perspective-warp custom nodes are intentionally omitted (unstable).

        The mask (white = inpaint, black = keep) is provided directly.
        SAM2 should have been run *before* calling this method to generate
        a precise segment mask.

        Pipeline:
          image → DepthPreprocessor → ControlNet Depth (preserves room geometry)
          material_texture → CLIP Vision → IP-Adapter (injects material style)
          mask → VAEEncodeForInpaint → KSampler → output

        Args:
            image_url:            Original room photo.
            mask_data:            White/black mask (white = area to retexture).
                                  Accepts URL, base-64, or raw bytes.
            material_texture_url: Seamless tile image (512×512+ recommended).
            prompt:               Positive prompt appended after material style.
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

        workflow: dict[str, Any] = {
            # ── Checkpoint ──────────────────────────────────────────────────
            "1": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": _CKPT_SDXL_BASE},
            },

            # ── Load images ──────────────────────────────────────────────────
            # Node 2: original room image
            "2": {
                "class_type": "ETN_LoadImageBase64",
                "inputs": {"image": img_b64},
            },
            # Node 3: inpainting mask (white = change, black = keep)
            "3": {
                "class_type": "ETN_LoadMaskBase64",
                "inputs": {"mask": mask_b64},
            },
            # Node 4: material texture image
            "4": {
                "class_type": "ETN_LoadImageBase64",
                "inputs": {"image": mat_b64},
            },

            # ── IP-Adapter ─────────────────────────────────────────────────
            # Node 5: load IP-Adapter SDXL model
            "5": {
                "class_type": "IPAdapterModelLoader",
                "inputs": {"ipadapter_file": _IPADAPTER_SDXL},
            },
            # Node 6: load CLIP Vision encoder (must be separate from text CLIP)
            "6": {
                "class_type": "CLIPVisionLoader",
                "inputs": {"clip_name": _CLIP_VISION_H},
            },
            # Node 7: apply IP-Adapter to base model
            "7": {
                "class_type": "IPAdapterApply",
                "inputs": {
                    "ipadapter":   ["5", 0],
                    "clip_vision": ["6", 0],
                    "image":       ["4", 0],   # material texture
                    "model":       ["1", 0],
                    "weight":      ipadapter_weight,
                    "noise":       0.01,
                    "weight_type": "linear",
                    "start_at":    0.0,
                    "end_at":      0.85,
                },
            },

            # ── ControlNet Depth ───────────────────────────────────────────
            # Node 8: depth-map preprocessor
            "8": {
                "class_type": "MiDaS-DepthMapPreprocessor",
                "inputs": {
                    "image":        ["2", 0],
                    "a":            6.283185307179586,
                    "bg_threshold": 0.1,
                },
            },
            # Node 9: ControlNet loader
            "9": {
                "class_type": "ControlNetLoader",
                "inputs": {"control_net_name": _CN_DEPTH_SDXL},
            },

            # ── CLIP Text Encoding ─────────────────────────────────────────
            # Node 10 & 11
            "10": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": prompt, "clip": ["1", 1]},
            },
            "11": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": negative_prompt, "clip": ["1", 1]},
            },

            # Node 12: Apply ControlNet (depth) to conditioning
            "12": {
                "class_type": "ControlNetApplyAdvanced",
                "inputs": {
                    "positive":      ["10", 0],
                    "negative":      ["11", 0],
                    "control_net":   ["9", 0],
                    "image":         ["8", 0],   # depth map
                    "strength":      controlnet_strength,
                    "start_percent": 0.0,
                    "end_percent":   0.8,
                },
            },

            # ── Inpainting ─────────────────────────────────────────────────
            # Node 13: VAE Encode for inpainting (uses mask)
            "13": {
                "class_type": "VAEEncodeForInpaint",
                "inputs": {
                    "pixels":       ["2", 0],
                    "vae":          ["1", 2],
                    "mask":         ["3", 0],
                    "grow_mask_by": 6,
                },
            },

            # Node 14: KSampler (IP-Adapter model → inpaint latent → result)
            "14": {
                "class_type": "KSampler",
                "inputs": {
                    "model":         ["7", 0],    # IP-Adapter enhanced model
                    "positive":      ["12", 0],   # ControlNet positive conditioning
                    "negative":      ["12", 1],   # ControlNet negative conditioning
                    "latent_image":  ["13", 0],
                    "seed":          seed,
                    "steps":         steps,
                    "cfg":           cfg,
                    "sampler_name":  "dpmpp_2m",
                    "scheduler":     "karras",
                    "denoise":       denoise,
                },
            },

            # Node 15: VAE Decode
            "15": {
                "class_type": "VAEDecode",
                "inputs": {"samples": ["14", 0], "vae": ["1", 2]},
            },

            # Node 16: Save result
            "16": {
                "class_type": "SaveImage",
                "inputs": {
                    "images":           ["15", 0],
                    "filename_prefix":  "material_apply",
                },
            },
        }

        return workflow

    # ──────────────────────────────────────────────────────────────────────────
    #  3. Mood Copy — transfer atmosphere from a reference image
    # ──────────────────────────────────────────────────────────────────────────

    def build_mood_copy_workflow(
        self,
        source_image_url: Union[str, bytes],
        reference_image_url: Union[str, bytes],
        strength: float = 0.70,
        prompt: str = (
            "photorealistic interior photography, perfect lighting, "
            "architectural visualization, 8k resolution"
        ),
        negative_prompt: str = _NEGATIVE_BASE,
        steps: int = 25,
        cfg: float = 7.0,
        seed: Optional[int] = None,
    ) -> dict[str, Any]:
        """
        Copy the mood, lighting, and atmosphere of a reference image.

        Uses IP-Adapter at a high weight to impose the reference's visual
        language onto the source room (img2img), preserving structure.

        Args:
            source_image_url:    The room to transform.
            reference_image_url: Inspiration / mood board image.
            strength:            Overall transformation strength (0.5–0.9).
                                 Also maps to img2img denoise and IP-Adapter weight.
            prompt:              Additional positive conditioning.
            negative_prompt:     Negative conditioning.
            steps:               KSampler steps.
            cfg:                 CFG scale.
            seed:                Fixed seed; None = random.

        Returns:
            ComfyUI API-format workflow dict.
        """
        src_b64 = _ensure_base64(source_image_url)
        ref_b64 = _ensure_base64(reference_image_url)
        seed    = seed if seed is not None else _rand_seed()

        # Map overall strength → component weights
        ipadapter_w = min(strength + 0.1, 0.95)
        denoise     = max(strength - 0.1, 0.30)

        return {
            # Checkpoint
            "1": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": _CKPT_SDXL_BASE},
            },

            # Images
            "2": {"class_type": "ETN_LoadImageBase64", "inputs": {"image": src_b64}},
            "3": {"class_type": "ETN_LoadImageBase64", "inputs": {"image": ref_b64}},

            # IP-Adapter
            "4": {"class_type": "IPAdapterModelLoader", "inputs": {"ipadapter_file": _IPADAPTER_SDXL}},
            "5": {"class_type": "CLIPVisionLoader",     "inputs": {"clip_name": _CLIP_VISION_H}},
            "6": {
                "class_type": "IPAdapterApply",
                "inputs": {
                    "ipadapter":   ["4", 0],
                    "clip_vision": ["5", 0],
                    "image":       ["3", 0],      # reference image for mood
                    "model":       ["1", 0],
                    "weight":      ipadapter_w,
                    "noise":       0.0,
                    "weight_type": "ease in",     # gradual mood ramp-up
                    "start_at":    0.0,
                    "end_at":      1.0,
                },
            },

            # Text conditioning
            "7": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt,          "clip": ["1", 1]}},
            "8": {"class_type": "CLIPTextEncode", "inputs": {"text": negative_prompt, "clip": ["1", 1]}},

            # img2img
            "9":  {"class_type": "VAEEncode",   "inputs": {"pixels": ["2", 0], "vae": ["1", 2]}},
            "10": {
                "class_type": "KSampler",
                "inputs": {
                    "model":        ["6", 0],
                    "positive":     ["7", 0],
                    "negative":     ["8", 0],
                    "latent_image": ["9", 0],
                    "seed":         seed,
                    "steps":        steps,
                    "cfg":          cfg,
                    "sampler_name": "dpmpp_2m",
                    "scheduler":    "karras",
                    "denoise":      denoise,
                },
            },
            "11": {"class_type": "VAEDecode",  "inputs": {"samples": ["10", 0], "vae": ["1", 2]}},
            "12": {
                "class_type": "SaveImage",
                "inputs": {"images": ["11", 0], "filename_prefix": "mood_copy"},
            },
        }

    # ──────────────────────────────────────────────────────────────────────────
    #  4. Furniture Place — seamlessly blend placed furniture into the room
    # ──────────────────────────────────────────────────────────────────────────

    def build_furniture_place_workflow(
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

        Assumes the client has already:
          1. Resized and positioned the furniture PNG (background-removed).
          2. Alpha-composited it onto the room canvas.
          3. Passed the composite as ``image_url``.

        The workflow uses inpainting around the furniture boundary to:
          - Remove compositing artefacts
          - Add natural shadows and reflections
          - Match the room's lighting tone

        Note: Perspective-warp nodes are intentionally excluded.
        The client is responsible for correct perspective alignment.

        Args:
            image_url:           Composite image (room + placed furniture).
            furniture_image_url: Original furniture crop (background removed, PNG).
                                 Used to auto-generate the boundary mask.
            position:            Normalised position dict (unused in this workflow —
                                 kept for API compatibility and future use).
                                 Example: {"x": 0.4, "y": 0.7}
            scale:               Scale factor (unused — applied client-side).
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

        return {
            # Checkpoint
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": _CKPT_SDXL_BASE}},

            # Images
            # Node 2: composite scene (room + furniture already merged)
            "2": {"class_type": "ETN_LoadImageBase64", "inputs": {"image": img_b64}},
            # Node 3: isolated furniture image (used to derive the blend mask)
            "3": {"class_type": "ETN_LoadImageBase64", "inputs": {"image": furn_b64}},

            # Node 4: auto-generate mask from furniture's alpha channel
            #   ImageToMask extracts the alpha as a mask (white where furniture exists)
            "4": {
                "class_type": "ImageToMask",
                "inputs": {"image": ["3", 0], "channel": "alpha"},
            },

            # Node 5: dilate the mask to cover blending boundary
            "5": {
                "class_type": "GrowMask",
                "inputs": {"mask": ["4", 0], "expand": 20, "tapered_corners": True},
            },

            # Text conditioning
            "6": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt,          "clip": ["1", 1]}},
            "7": {"class_type": "CLIPTextEncode", "inputs": {"text": negative_prompt, "clip": ["1", 1]}},

            # VAE Encode for inpainting (blends only around furniture boundary)
            "8": {
                "class_type": "VAEEncodeForInpaint",
                "inputs": {
                    "pixels":       ["2", 0],
                    "vae":          ["1", 2],
                    "mask":         ["5", 0],
                    "grow_mask_by": 8,
                },
            },

            # KSampler
            "9": {
                "class_type": "KSampler",
                "inputs": {
                    "model":        ["1", 0],
                    "positive":     ["6", 0],
                    "negative":     ["7", 0],
                    "latent_image": ["8", 0],
                    "seed":         seed,
                    "steps":        steps,
                    "cfg":          cfg,
                    "sampler_name": "euler_ancestral",
                    "scheduler":    "normal",
                    "denoise":      blend_denoise,
                },
            },

            # VAE Decode + Save
            "10": {"class_type": "VAEDecode",  "inputs": {"samples": ["9", 0], "vae": ["1", 2]}},
            "11": {
                "class_type": "SaveImage",
                "inputs": {"images": ["10", 0], "filename_prefix": "furniture_place"},
            },
        }

    # ──────────────────────────────────────────────────────────────────────────
    #  5. Final Render — SDXL Base + Refiner two-stage high-quality output
    # ──────────────────────────────────────────────────────────────────────────

    def build_final_render_workflow(
        self,
        image_url: Union[str, bytes],
        lighting: str = "soft natural daylight, warm interior lighting",
        quality: str = "high",
        prompt_prefix: str = "",
        negative_prompt: str = _NEGATIVE_BASE,
        base_denoise: float = 0.45,
        base_steps: int = 20,
        refiner_steps: int = 10,
        cfg: float = 7.5,
        seed: Optional[int] = None,
        upscale: bool = True,
    ) -> dict[str, Any]:
        """
        High-quality two-stage SDXL render (Base → Refiner → optional upscale).

        Stage 1 (Base):  img2img at moderate denoise to improve overall quality.
        Stage 2 (Refiner): low-denoise pass to add fine detail and sharpness.
        Stage 3 (optional): Real-ESRGAN 2× upscale for print-ready resolution.

        Args:
            image_url:       Source room image (after all edits applied).
            lighting:        Lighting description appended to positive prompt.
            quality:         "high" → more steps, "fast" → fewer steps.
            prompt_prefix:   Optional custom text prepended to the prompt.
            negative_prompt: Negative conditioning.
            base_denoise:    Base-stage denoise (0.3–0.6; lower = more faithful).
            base_steps:      Base-stage sampling steps.
            refiner_steps:   Refiner-stage steps (8–15 typical).
            cfg:             CFG scale.
            seed:            Fixed seed; None = random.
            upscale:         If True, add Real-ESRGAN 2× upscale node.

        Returns:
            ComfyUI API-format workflow dict.
        """
        img_b64 = _ensure_base64(image_url)
        seed    = seed if seed is not None else _rand_seed()

        # Quality presets
        if quality == "fast":
            base_steps    = max(base_steps - 8, 10)
            refiner_steps = max(refiner_steps - 4, 5)

        positive_text = (
            f"{prompt_prefix + ', ' if prompt_prefix else ''}"
            f"photorealistic interior architectural photography, {lighting}, "
            "8k resolution, perfect composition, ultra detailed, sharp focus, "
            "cinematic lighting, professional interior design"
        )

        workflow: dict[str, Any] = {
            # ── Stage 1: SDXL Base ────────────────────────────────────────
            "1": {"class_type": "CheckpointLoaderSimple",  "inputs": {"ckpt_name": _CKPT_SDXL_BASE}},
            "2": {"class_type": "ETN_LoadImageBase64",     "inputs": {"image": img_b64}},
            "3": {"class_type": "CLIPTextEncode",          "inputs": {"text": positive_text,  "clip": ["1", 1]}},
            "4": {"class_type": "CLIPTextEncode",          "inputs": {"text": negative_prompt, "clip": ["1", 1]}},
            "5": {"class_type": "VAEEncode",               "inputs": {"pixels": ["2", 0], "vae": ["1", 2]}},
            "6": {
                "class_type": "KSamplerAdvanced",
                "inputs": {
                    "model":            ["1", 0],
                    "positive":         ["3", 0],
                    "negative":         ["4", 0],
                    "latent_image":     ["5", 0],
                    "noise_seed":       seed,
                    "steps":            base_steps + refiner_steps,
                    "cfg":              cfg,
                    "sampler_name":     "dpmpp_2m",
                    "scheduler":        "karras",
                    "start_at_step":    0,
                    "end_at_step":      base_steps,
                    "add_noise":        "enable",
                    "return_with_leftover_noise": "enable",
                },
            },

            # ── Stage 2: SDXL Refiner ──────────────────────────────────────
            "7": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": _CKPT_SDXL_REFINER}},

            # Refiner uses its own CLIP (different from base CLIP)
            "8": {"class_type": "CLIPTextEncode", "inputs": {"text": positive_text,  "clip": ["7", 1]}},
            "9": {"class_type": "CLIPTextEncode", "inputs": {"text": negative_prompt, "clip": ["7", 1]}},

            "10": {
                "class_type": "KSamplerAdvanced",
                "inputs": {
                    "model":            ["7", 0],
                    "positive":         ["8", 0],
                    "negative":         ["9", 0],
                    "latent_image":     ["6", 0],   # base output latent
                    "noise_seed":       seed,
                    "steps":            base_steps + refiner_steps,
                    "cfg":              cfg,
                    "sampler_name":     "dpmpp_2m",
                    "scheduler":        "karras",
                    "start_at_step":    base_steps,
                    "end_at_step":      base_steps + refiner_steps,
                    "add_noise":        "disable",
                    "return_with_leftover_noise": "disable",
                },
            },
            "11": {"class_type": "VAEDecode", "inputs": {"samples": ["10", 0], "vae": ["1", 2]}},
        }

        if upscale:
            # ── Stage 3: Real-ESRGAN 2× upscale ───────────────────────────
            workflow["12"] = {
                "class_type": "UpscaleModelLoader",
                "inputs": {"model_name": _UPSCALER},
            }
            workflow["13"] = {
                "class_type": "ImageUpscaleWithModel",
                "inputs": {"upscale_model": ["12", 0], "image": ["11", 0]},
            }
            # Downscale back to 2048px (Real-ESRGAN 2× → up to 4096px)
            workflow["14"] = {
                "class_type": "ImageScale",
                "inputs": {
                    "image":          ["13", 0],
                    "upscale_method": "lanczos",
                    "width":          2048,
                    "height":         0,      # 0 = auto (maintain aspect ratio)
                    "crop":           "disabled",
                },
            }
            output_image_ref = ["14", 0]
        else:
            output_image_ref = ["11", 0]

        workflow["15"] = {
            "class_type": "SaveImage",
            "inputs": {"images": output_image_ref, "filename_prefix": "final_render"},
        }

        return workflow
