"""
RunPod Serverless Handler: ComfyUI Workflow for Apartment Interior Rendering

Input:
    {
        "workflow": { ...ComfyUI workflow JSON (assembled by server)... },
        "prompt": "photorealistic interior render...",
        "negative_prompt": "low quality, blurry..."
    }

    OR (simplified input - handler assembles workflow):
    {
        "image": "<base64>",
        "mask": "<base64>",
        "prompt": "<string>",
        "negative_prompt": "<string>",
        "material_image": "<base64 or null>"
    }

Output:
    { "image": "<base64-encoded result PNG>" }
"""

import base64
import io
import json
import os
import time
import uuid
import runpod
import requests
from PIL import Image


# ─── ComfyUI server config (running in same pod) ─────────────────────────────
COMFY_HOST = os.environ.get("COMFY_HOST", "127.0.0.1")
COMFY_PORT = os.environ.get("COMFY_PORT", "8188")
COMFY_URL = f"http://{COMFY_HOST}:{COMFY_PORT}"
CLIENT_ID = str(uuid.uuid4())


def wait_for_comfyui(max_wait: int = 120) -> bool:
    """Wait until ComfyUI HTTP server is ready."""
    for _ in range(max_wait):
        try:
            r = requests.get(f"{COMFY_URL}/system_stats", timeout=2)
            if r.status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(1)
    return False


def upload_image_to_comfy(image_b64: str, name: str) -> str:
    """Upload a base64 image to ComfyUI's /upload/image endpoint."""
    image_bytes = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)

    response = requests.post(
        f"{COMFY_URL}/upload/image",
        files={"image": (name, buf, "image/png")},
        data={"overwrite": "true"},
    )
    response.raise_for_status()
    result = response.json()
    return result.get("name", name)


def queue_workflow(workflow: dict) -> str:
    """Submit workflow to ComfyUI queue and return prompt_id."""
    payload = {"prompt": workflow, "client_id": CLIENT_ID}
    response = requests.post(f"{COMFY_URL}/prompt", json=payload)
    response.raise_for_status()
    return response.json()["prompt_id"]


def poll_until_done(prompt_id: str, timeout: int = 300) -> dict:
    """Poll ComfyUI history until prompt is done."""
    start = time.time()
    while time.time() - start < timeout:
        r = requests.get(f"{COMFY_URL}/history/{prompt_id}")
        if r.status_code == 200:
            history = r.json()
            if prompt_id in history:
                return history[prompt_id]
        time.sleep(2)
    raise TimeoutError(f"ComfyUI job {prompt_id} timed out after {timeout}s")


def get_output_image(history_entry: dict) -> bytes:
    """Extract the first output image bytes from ComfyUI history entry."""
    outputs = history_entry.get("outputs", {})
    for node_id, node_output in outputs.items():
        images = node_output.get("images", [])
        for img_info in images:
            filename = img_info["filename"]
            subfolder = img_info.get("subfolder", "")
            folder_type = img_info.get("type", "output")
            params = {"filename": filename, "subfolder": subfolder, "type": folder_type}
            r = requests.get(f"{COMFY_URL}/view", params=params)
            r.raise_for_status()
            return r.content
    raise ValueError("No output images found in ComfyUI history")


def build_workflow_from_inputs(
    image_name: str,
    mask_name: str,
    prompt: str,
    negative_prompt: str,
    material_name: str = None,
) -> dict:
    """
    Build a ComfyUI workflow referencing uploaded images by filename.
    Uses: ControlNet (depth) + LoRA + Inpainting (+ IP-Adapter if material given).
    """
    import random
    seed = random.randint(0, 2**32 - 1)

    workflow = {
        "1": {
            "class_type": "LoadImage",
            "inputs": {"image": image_name, "upload": "image"}
        },
        "2": {
            "class_type": "LoadImage",
            "inputs": {"image": mask_name, "upload": "image"}
        },
        "2m": {
            "class_type": "ImageToMask",
            "inputs": {"image": ["2", 0], "channel": "red"}
        },
        "3": {
            "class_type": "ControlNetLoader",
            "inputs": {"control_net_name": "control_v11f1p_sd15_depth.pth"}
        },
        "4": {
            "class_type": "MiDaS-DepthMapPreprocessor",
            "inputs": {"image": ["1", 0], "a": 6.28, "bg_threshold": 0.1}
        },
        "6": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": "sd-v1-5-inpainting.ckpt"}
        },
        "7": {
            "class_type": "LoraLoader",
            "inputs": {
                "model": ["6", 0],
                "clip": ["6", 1],
                "lora_name": "korea-apartment-style_v1.safetensors",
                "strength_model": 0.8,
                "strength_clip": 0.8
            }
        },
        "8": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt, "clip": ["7", 1]}
        },
        "9": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": negative_prompt, "clip": ["7", 1]}
        },
        "5": {
            "class_type": "ControlNetApplyAdvanced",
            "inputs": {
                "positive": ["8", 0],
                "negative": ["9", 0],
                "control_net": ["3", 0],
                "image": ["4", 0],
                "strength": 0.75,
                "start_percent": 0.0,
                "end_percent": 0.85
            }
        },
        "10": {
            "class_type": "VAEEncodeForInpaint",
            "inputs": {
                "pixels": ["1", 0],
                "vae": ["6", 2],
                "mask": ["2m", 0],
                "grow_mask_by": 6
            }
        },
        "11": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["7", 0],
                "positive": ["5", 0],
                "negative": ["5", 1],
                "latent_image": ["10", 0],
                "seed": seed,
                "steps": 30,
                "cfg": 7.5,
                "sampler_name": "dpmpp_2m",
                "scheduler": "karras",
                "denoise": 1.0
            }
        },
        "12": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["11", 0], "vae": ["6", 2]}
        },
        "13": {
            "class_type": "SaveImage",
            "inputs": {"images": ["12", 0], "filename_prefix": "interior_render"}
        }
    }

    if material_name:
        workflow["14"] = {
            "class_type": "LoadImage",
            "inputs": {"image": material_name, "upload": "image"}
        }
        workflow["15"] = {
            "class_type": "IPAdapterModelLoader",
            "inputs": {"ipadapter_file": "ip-adapter_sd15.bin"}
        }
        workflow["16"] = {
            "class_type": "IPAdapterApply",
            "inputs": {
                "ipadapter": ["15", 0],
                "clip_vision": ["6", 0],
                "image": ["14", 0],
                "model": ["7", 0],
                "weight": 0.6,
                "noise": 0.0,
                "weight_type": "original",
                "start_at": 0.0,
                "end_at": 0.9
            }
        }
        workflow["11"]["inputs"]["model"] = ["16", 0]

    return workflow


def handler(job: dict) -> dict:
    """Main RunPod job handler for ComfyUI rendering."""
    job_input = job.get("input", {})

    # Wait for ComfyUI to be ready
    if not wait_for_comfyui():
        return {"error": "ComfyUI 서버가 응답하지 않습니다."}

    prompt = job_input.get("prompt", "photorealistic interior render, modern design")
    negative_prompt = job_input.get("negative_prompt", "low quality, blurry, distorted")

    # Mode A: pre-assembled workflow JSON from server
    if "workflow" in job_input:
        workflow = job_input["workflow"]
    else:
        # Mode B: raw base64 inputs — upload and build workflow
        image_b64 = job_input.get("image")
        mask_b64 = job_input.get("mask")
        material_b64 = job_input.get("material_image")

        if not image_b64 or not mask_b64:
            return {"error": "'image'와 'mask' base64 필드가 필요합니다."}

        try:
            job_id = job.get("id", str(uuid.uuid4()))[:8]
            image_name = upload_image_to_comfy(image_b64, f"input_{job_id}.png")
            mask_name = upload_image_to_comfy(mask_b64, f"mask_{job_id}.png")
            material_name = None
            if material_b64:
                material_name = upload_image_to_comfy(material_b64, f"material_{job_id}.png")
        except Exception as e:
            return {"error": f"ComfyUI 이미지 업로드 오류: {str(e)}"}

        workflow = build_workflow_from_inputs(
            image_name, mask_name, prompt, negative_prompt, material_name
        )

    # Queue and wait
    try:
        prompt_id = queue_workflow(workflow)
        history = poll_until_done(prompt_id)
        image_bytes = get_output_image(history)
    except TimeoutError as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"ComfyUI 렌더링 오류: {str(e)}"}

    # Return as base64
    result_b64 = base64.b64encode(image_bytes).decode("utf-8")
    return {"image": result_b64}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
