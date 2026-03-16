#!/usr/bin/env python3
"""
The Circle — ComfyUI 워크플로우 로컬 테스트 스크립트

ComfyUI가 localhost:8188에서 실행 중이어야 합니다.
  docker run --gpus all -p 8188:8188 <comfyui-image>
  또는 로컬 ComfyUI 직접 실행

사용법:
  # 모든 워크플로우 테스트 (합성 이미지 사용)
  python scripts/test_workflow.py --workflow all

  # 특정 워크플로우 + 실제 이미지
  python scripts/test_workflow.py --workflow material_apply \\
      --image path/to/room.jpg \\
      --mask path/to/mask.png \\
      --material path/to/tile.jpg

  # circle_ai 워크플로우
  python scripts/test_workflow.py --workflow circle_ai \\
      --image path/to/room.jpg \\
      --prompt "modern scandinavian interior, white walls, warm lighting"

워크플로우 목록:
  circle_ai         전체 방 스타일 변환
  material_apply    자재 텍스처 마스크 적용
  mood_copy         참조 이미지 분위기 복사
  furniture_place   가구 합성 블렌딩
  final_render      SDXL Base+Refiner 고품질 렌더링
  all               위 5가지 순서대로 전부 실행
"""

import argparse
import asyncio
import base64
import io
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Optional

# ── 의존성 확인 ────────────────────────────────────────────────────────────────
try:
    import websockets
except ImportError:
    print("[오류] websockets 패키지가 없습니다.")
    print("  pip install websockets")
    sys.exit(1)

try:
    from PIL import Image, ImageDraw, ImageFilter
    import numpy as np
except ImportError:
    print("[오류] Pillow 또는 numpy가 없습니다.")
    print("  pip install Pillow numpy")
    sys.exit(1)

try:
    import httpx
except ImportError:
    print("[오류] httpx 패키지가 없습니다.")
    print("  pip install httpx")
    sys.exit(1)

# ── backend WorkflowManager 임포트 ────────────────────────────────────────────
_REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(_REPO_ROOT / "backend"))

try:
    from app.services.comfyui.workflow_manager import WorkflowManager
    print("[OK] WorkflowManager 로드 성공")
except ImportError as e:
    print(f"[경고] WorkflowManager 로드 실패 ({e}) — 내장 워크플로우 사용")
    WorkflowManager = None

# ── 설정 ──────────────────────────────────────────────────────────────────────
COMFYUI_URL  = os.getenv("COMFYUI_URL", "http://localhost:8188")
COMFYUI_WS   = COMFYUI_URL.replace("http://", "ws://").replace("https://", "wss://")
OUTPUT_DIR   = Path("outputs")
OUTPUT_DIR.mkdir(exist_ok=True)

# ANSI 색상
_G = "\033[32m"
_Y = "\033[33m"
_R = "\033[31m"
_B = "\033[34m"
_C = "\033[36m"
_BOLD = "\033[1m"
_RST = "\033[0m"


# ══════════════════════════════════════════════════════════════════════════════
#  합성 테스트 이미지 생성
# ══════════════════════════════════════════════════════════════════════════════

def make_room_image(width: int = 768, height: int = 512) -> bytes:
    """그라디언트 + 기하 도형으로 실내 느낌의 합성 이미지 생성."""
    img = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(img)

    # 배경 그라디언트 (천장 → 바닥)
    for y in range(height):
        t = y / height
        r = int(240 - t * 60)
        g = int(235 - t * 55)
        b = int(225 - t * 50)
        draw.line([(0, y), (width, y)], fill=(r, g, b))

    # 바닥 영역
    floor_y = int(height * 0.65)
    draw.rectangle([0, floor_y, width, height], fill=(180, 160, 130))

    # 벽 (왼쪽)
    draw.rectangle([0, 0, int(width * 0.12), height], fill=(220, 215, 205))

    # 창문
    win_x1, win_y1 = int(width * 0.55), int(height * 0.1)
    win_x2, win_y2 = int(width * 0.85), int(height * 0.55)
    draw.rectangle([win_x1, win_y1, win_x2, win_y2], fill=(180, 210, 240))
    draw.rectangle([win_x1, win_y1, win_x2, win_y2], outline=(150, 140, 120), width=4)

    # 소파 실루엣
    sofa_x1, sofa_y1 = int(width * 0.05), int(height * 0.55)
    sofa_x2, sofa_y2 = int(width * 0.45), int(height * 0.75)
    draw.rectangle([sofa_x1, sofa_y1, sofa_x2, sofa_y2], fill=(100, 90, 80))
    draw.rectangle([sofa_x1, sofa_y1, sofa_x2, sofa_y1 + 30], fill=(120, 110, 100))

    # 블러로 자연스럽게
    img = img.filter(ImageFilter.GaussianBlur(1))

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def make_mask_image(width: int = 768, height: int = 512) -> bytes:
    """바닥 영역을 흰색으로 마스킹한 이미지 생성 (inpaint mask)."""
    img = Image.new("L", (width, height), 0)  # 검정 배경
    draw = ImageDraw.Draw(img)
    floor_y = int(height * 0.65)
    draw.rectangle([0, floor_y, width, height], fill=255)  # 흰색 = 변경 영역

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def make_material_tile(width: int = 512, height: int = 512) -> bytes:
    """오크 나무 패턴 합성 타일 이미지 생성."""
    img = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(img)

    base_color = (190, 155, 110)
    draw.rectangle([0, 0, width, height], fill=base_color)

    rng = np.random.default_rng(42)
    grain_data = rng.normal(0, 12, (height, width, 3)).astype(np.int16)
    base_arr = np.array(img, dtype=np.int16)
    grained = np.clip(base_arr + grain_data, 0, 255).astype(np.uint8)
    img = Image.fromarray(grained)
    draw = ImageDraw.Draw(img)

    # 나뭇결 줄무늬
    for i in range(0, height, 80):
        offset = rng.integers(-5, 5)
        draw.line([(0, i + offset), (width, i + 5 + offset)],
                  fill=(160, 125, 85), width=2)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return buf.getvalue()


def make_reference_image(width: int = 512, height: int = 512) -> bytes:
    """무드 레퍼런스용 이미지 (따뜻한 조명 느낌)."""
    img = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(img)
    for y in range(height):
        t = y / height
        r = int(255 - t * 40)
        g = int(240 - t * 60)
        b = int(200 - t * 80)
        draw.line([(0, y), (width, y)], fill=(r, g, b))

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _load_or_synth(path: Optional[str], synth_fn, label: str) -> bytes:
    if path and Path(path).exists():
        data = Path(path).read_bytes()
        print(f"  {_G}[파일]{_RST} {label}: {path}")
        return data
    else:
        data = synth_fn()
        print(f"  {_Y}[합성]{_RST} {label}: 테스트용 이미지 자동 생성")
        return data


# ══════════════════════════════════════════════════════════════════════════════
#  ComfyUI HTTP + WebSocket 클라이언트
# ══════════════════════════════════════════════════════════════════════════════

class ComfyUIClient:
    def __init__(self, base_url: str = COMFYUI_URL):
        self.base_url = base_url.rstrip("/")
        self.ws_url   = self.base_url.replace("http://", "ws://").replace("https://", "wss://")
        self.client_id = str(uuid.uuid4())

    def check_connection(self) -> bool:
        """ComfyUI 연결 확인."""
        try:
            with httpx.Client(timeout=5) as c:
                r = c.get(f"{self.base_url}/system_stats")
                return r.status_code == 200
        except Exception:
            return False

    def queue_prompt(self, workflow: dict[str, Any]) -> str:
        """워크플로우를 큐에 추가하고 prompt_id 반환."""
        payload = {"prompt": workflow, "client_id": self.client_id}
        with httpx.Client(timeout=30) as c:
            r = c.post(f"{self.base_url}/prompt", json=payload)
            r.raise_for_status()
            return r.json()["prompt_id"]

    def get_history(self, prompt_id: str) -> dict:
        """완료된 작업 히스토리 조회."""
        with httpx.Client(timeout=10) as c:
            r = c.get(f"{self.base_url}/history/{prompt_id}")
            r.raise_for_status()
            return r.json()

    def download_image(self, filename: str, subfolder: str = "", folder_type: str = "output") -> bytes:
        """결과 이미지 다운로드."""
        params = {"filename": filename, "subfolder": subfolder, "type": folder_type}
        with httpx.Client(timeout=60) as c:
            r = c.get(f"{self.base_url}/view", params=params)
            r.raise_for_status()
            return r.content

    async def wait_for_completion(self, prompt_id: str, timeout: int = 300) -> bool:
        """
        WebSocket으로 진행률 모니터링.
        True = 완료, False = 타임아웃/오류
        """
        uri = f"{self.ws_url}/ws?clientId={self.client_id}"
        start = time.time()

        try:
            async with websockets.connect(uri, ping_interval=20) as ws:
                print(f"    {_C}[WS]{_RST} WebSocket 연결됨")
                current_node = None

                while True:
                    if time.time() - start > timeout:
                        print(f"    {_R}[타임아웃]{_RST} {timeout}초 초과")
                        return False

                    try:
                        msg_raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    except asyncio.TimeoutError:
                        continue

                    if isinstance(msg_raw, bytes):
                        # 이미지 데이터 (미리보기) — 무시
                        continue

                    msg = json.loads(msg_raw)
                    mtype = msg.get("type", "")
                    data  = msg.get("data", {})

                    if mtype == "executing":
                        pid  = data.get("prompt_id")
                        node = data.get("node")
                        if pid == prompt_id:
                            if node is None:
                                # 실행 완료
                                elapsed = time.time() - start
                                print(f"    {_G}[완료]{_RST} {elapsed:.1f}초")
                                return True
                            if node != current_node:
                                current_node = node
                                print(f"    {_B}[노드 {node}]{_RST} 실행 중...", end="\r")

                    elif mtype == "progress":
                        pid   = data.get("prompt_id", "")
                        value = data.get("value", 0)
                        total = data.get("max", 1)
                        bar_w = 30
                        filled = int(bar_w * value / max(total, 1))
                        bar = "█" * filled + "░" * (bar_w - filled)
                        print(f"    [{bar}] {value}/{total}", end="\r")

                    elif mtype == "execution_error":
                        if data.get("prompt_id") == prompt_id:
                            err = data.get("exception_message", "알 수 없는 오류")
                            print(f"\n    {_R}[오류]{_RST} {err}")
                            return False

        except Exception as e:
            print(f"    {_R}[WS 오류]{_RST} {e}")
            return False


# ══════════════════════════════════════════════════════════════════════════════
#  워크플로우 빌더 (WorkflowManager 없을 때 fallback)
# ══════════════════════════════════════════════════════════════════════════════

class FallbackWorkflowBuilder:
    """WorkflowManager import 실패 시 사용하는 간단한 워크플로우 빌더."""

    def build_material_apply_workflow(self, image_url, mask_data,
                                       material_texture_url, **kwargs) -> dict:
        img_b64  = _b64(image_url) if isinstance(image_url, bytes) else image_url
        mask_b64 = _b64(mask_data) if isinstance(mask_data, bytes) else mask_data
        mat_b64  = _b64(material_texture_url) if isinstance(material_texture_url, bytes) else material_texture_url
        seed = kwargs.get("seed", 42)

        return {
            "1": {"class_type": "CheckpointLoaderSimple",
                  "inputs": {"ckpt_name": "sdxl_base_1.0.safetensors"}},
            "2": {"class_type": "ETN_LoadImageBase64", "inputs": {"image": img_b64}},
            "3": {"class_type": "ETN_LoadMaskBase64",  "inputs": {"mask": mask_b64}},
            "4": {"class_type": "ETN_LoadImageBase64", "inputs": {"image": mat_b64}},
            "5": {"class_type": "IPAdapterModelLoader",
                  "inputs": {"ipadapter_file": "ip-adapter-plus_sdxl_vit-h.bin"}},
            "6": {"class_type": "CLIPVisionLoader",
                  "inputs": {"clip_name": "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"}},
            "7": {"class_type": "IPAdapterApply",
                  "inputs": {"ipadapter": ["5", 0], "clip_vision": ["6", 0],
                             "image": ["4", 0], "model": ["1", 0],
                             "weight": 0.55, "noise": 0.01,
                             "weight_type": "linear", "start_at": 0.0, "end_at": 0.85}},
            "8": {"class_type": "MiDaS-DepthMapPreprocessor",
                  "inputs": {"image": ["2", 0], "a": 6.283185, "bg_threshold": 0.1}},
            "9": {"class_type": "ControlNetLoader",
                  "inputs": {"control_net_name": "controlnet-depth-sdxl-1.0.safetensors"}},
            "10": {"class_type": "CLIPTextEncode",
                   "inputs": {"text": "photorealistic interior, high-end material", "clip": ["1", 1]}},
            "11": {"class_type": "CLIPTextEncode",
                   "inputs": {"text": "blurry, low quality, distorted", "clip": ["1", 1]}},
            "12": {"class_type": "ControlNetApplyAdvanced",
                   "inputs": {"positive": ["10", 0], "negative": ["11", 0],
                              "control_net": ["9", 0], "image": ["8", 0],
                              "strength": 0.65, "start_percent": 0.0, "end_percent": 0.8}},
            "13": {"class_type": "VAEEncodeForInpaint",
                   "inputs": {"pixels": ["2", 0], "vae": ["1", 2],
                              "mask": ["3", 0], "grow_mask_by": 6}},
            "14": {"class_type": "KSampler",
                   "inputs": {"model": ["7", 0], "positive": ["12", 0], "negative": ["12", 1],
                              "latent_image": ["13", 0], "seed": seed,
                              "steps": 28, "cfg": 7.5,
                              "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 0.88}},
            "15": {"class_type": "VAEDecode",
                   "inputs": {"samples": ["14", 0], "vae": ["1", 2]}},
            "16": {"class_type": "SaveImage",
                   "inputs": {"images": ["15", 0], "filename_prefix": "material_apply"}},
        }

    def build_circle_ai_workflow(self, image_url, style_prompt, **kwargs) -> dict:
        img_b64 = _b64(image_url) if isinstance(image_url, bytes) else image_url
        seed = kwargs.get("seed", 42)
        return {
            "1": {"class_type": "CheckpointLoaderSimple",
                  "inputs": {"ckpt_name": "sdxl_base_1.0.safetensors"}},
            "2": {"class_type": "CLIPTextEncode",
                  "inputs": {"text": style_prompt, "clip": ["1", 1]}},
            "3": {"class_type": "CLIPTextEncode",
                  "inputs": {"text": "blurry, low quality", "clip": ["1", 1]}},
            "4": {"class_type": "ETN_LoadImageBase64", "inputs": {"image": img_b64}},
            "5": {"class_type": "VAEEncode",
                  "inputs": {"pixels": ["4", 0], "vae": ["1", 2]}},
            "6": {"class_type": "KSampler",
                  "inputs": {"model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0],
                             "latent_image": ["5", 0], "seed": seed,
                             "steps": 25, "cfg": 7.0,
                             "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 0.65}},
            "7": {"class_type": "VAEDecode",
                  "inputs": {"samples": ["6", 0], "vae": ["1", 2]}},
            "8": {"class_type": "SaveImage",
                  "inputs": {"images": ["7", 0], "filename_prefix": "circle_ai"}},
        }

    def build_mood_copy_workflow(self, source_image_url, reference_image_url, **kwargs) -> dict:
        src_b64 = _b64(source_image_url) if isinstance(source_image_url, bytes) else source_image_url
        ref_b64 = _b64(reference_image_url) if isinstance(reference_image_url, bytes) else reference_image_url
        seed = kwargs.get("seed", 42)
        return {
            "1": {"class_type": "CheckpointLoaderSimple",
                  "inputs": {"ckpt_name": "sdxl_base_1.0.safetensors"}},
            "2": {"class_type": "ETN_LoadImageBase64", "inputs": {"image": src_b64}},
            "3": {"class_type": "ETN_LoadImageBase64", "inputs": {"image": ref_b64}},
            "4": {"class_type": "IPAdapterModelLoader",
                  "inputs": {"ipadapter_file": "ip-adapter-plus_sdxl_vit-h.bin"}},
            "5": {"class_type": "CLIPVisionLoader",
                  "inputs": {"clip_name": "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"}},
            "6": {"class_type": "IPAdapterApply",
                  "inputs": {"ipadapter": ["4", 0], "clip_vision": ["5", 0],
                             "image": ["3", 0], "model": ["1", 0],
                             "weight": 0.80, "noise": 0.0,
                             "weight_type": "ease in", "start_at": 0.0, "end_at": 1.0}},
            "7": {"class_type": "CLIPTextEncode",
                  "inputs": {"text": "photorealistic interior, perfect lighting", "clip": ["1", 1]}},
            "8": {"class_type": "CLIPTextEncode",
                  "inputs": {"text": "blurry, low quality", "clip": ["1", 1]}},
            "9": {"class_type": "VAEEncode",
                  "inputs": {"pixels": ["2", 0], "vae": ["1", 2]}},
            "10": {"class_type": "KSampler",
                   "inputs": {"model": ["6", 0], "positive": ["7", 0], "negative": ["8", 0],
                              "latent_image": ["9", 0], "seed": seed,
                              "steps": 25, "cfg": 7.0,
                              "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 0.60}},
            "11": {"class_type": "VAEDecode",
                   "inputs": {"samples": ["10", 0], "vae": ["1", 2]}},
            "12": {"class_type": "SaveImage",
                   "inputs": {"images": ["11", 0], "filename_prefix": "mood_copy"}},
        }

    def build_furniture_place_workflow(self, image_url, furniture_image_url, **kwargs) -> dict:
        img_b64  = _b64(image_url)  if isinstance(image_url, bytes)  else image_url
        furn_b64 = _b64(furniture_image_url) if isinstance(furniture_image_url, bytes) else furniture_image_url
        seed = kwargs.get("seed", 42)
        return {
            "1": {"class_type": "CheckpointLoaderSimple",
                  "inputs": {"ckpt_name": "sdxl_base_1.0.safetensors"}},
            "2": {"class_type": "ETN_LoadImageBase64", "inputs": {"image": img_b64}},
            "3": {"class_type": "ETN_LoadImageBase64", "inputs": {"image": furn_b64}},
            "4": {"class_type": "ImageToMask",
                  "inputs": {"image": ["3", 0], "channel": "alpha"}},
            "5": {"class_type": "GrowMask",
                  "inputs": {"mask": ["4", 0], "expand": 20, "tapered_corners": True}},
            "6": {"class_type": "CLIPTextEncode",
                  "inputs": {"text": "photorealistic interior, furniture naturally placed", "clip": ["1", 1]}},
            "7": {"class_type": "CLIPTextEncode",
                  "inputs": {"text": "blurry, low quality", "clip": ["1", 1]}},
            "8": {"class_type": "VAEEncodeForInpaint",
                  "inputs": {"pixels": ["2", 0], "vae": ["1", 2],
                             "mask": ["5", 0], "grow_mask_by": 8}},
            "9": {"class_type": "KSampler",
                  "inputs": {"model": ["1", 0], "positive": ["6", 0], "negative": ["7", 0],
                             "latent_image": ["8", 0], "seed": seed,
                             "steps": 20, "cfg": 7.0,
                             "sampler_name": "euler_ancestral", "scheduler": "normal", "denoise": 0.55}},
            "10": {"class_type": "VAEDecode",
                   "inputs": {"samples": ["9", 0], "vae": ["1", 2]}},
            "11": {"class_type": "SaveImage",
                   "inputs": {"images": ["10", 0], "filename_prefix": "furniture_place"}},
        }

    def build_final_render_workflow(self, image_url, **kwargs) -> dict:
        img_b64 = _b64(image_url) if isinstance(image_url, bytes) else image_url
        seed = kwargs.get("seed", 42)
        return {
            "1": {"class_type": "CheckpointLoaderSimple",
                  "inputs": {"ckpt_name": "sdxl_base_1.0.safetensors"}},
            "2": {"class_type": "ETN_LoadImageBase64", "inputs": {"image": img_b64}},
            "3": {"class_type": "CLIPTextEncode",
                  "inputs": {"text": "photorealistic interior, 8k, ultra detailed", "clip": ["1", 1]}},
            "4": {"class_type": "CLIPTextEncode",
                  "inputs": {"text": "blurry, low quality", "clip": ["1", 1]}},
            "5": {"class_type": "VAEEncode",
                  "inputs": {"pixels": ["2", 0], "vae": ["1", 2]}},
            "6": {"class_type": "KSampler",
                  "inputs": {"model": ["1", 0], "positive": ["3", 0], "negative": ["4", 0],
                             "latent_image": ["5", 0], "seed": seed,
                             "steps": 20, "cfg": 7.5,
                             "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 0.45}},
            "7": {"class_type": "VAEDecode",
                  "inputs": {"samples": ["6", 0], "vae": ["1", 2]}},
            "8": {"class_type": "SaveImage",
                  "inputs": {"images": ["7", 0], "filename_prefix": "final_render"}},
        }


# ══════════════════════════════════════════════════════════════════════════════
#  테스트 실행기
# ══════════════════════════════════════════════════════════════════════════════

class WorkflowTester:
    def __init__(self, args: argparse.Namespace):
        self.args    = args
        self.comfy   = ComfyUIClient(args.comfyui_url)
        self.wm      = WorkflowManager() if WorkflowManager else FallbackWorkflowBuilder()
        self.results: list[dict] = []

    # ── 입력 이미지 준비 ────────────────────────────────────────────────────────
    def _get_images(self):
        room_bytes     = _load_or_synth(self.args.image,    make_room_image,      "방 이미지")
        mask_bytes     = _load_or_synth(self.args.mask,     make_mask_image,      "마스크 이미지")
        material_bytes = _load_or_synth(self.args.material, make_material_tile,   "자재 타일")
        ref_bytes      = _load_or_synth(self.args.reference, make_reference_image, "레퍼런스 이미지")
        # 가구 이미지: 방 이미지를 그대로 사용 (테스트용)
        furniture_bytes = _load_or_synth(self.args.furniture, make_room_image,    "가구 이미지")
        return room_bytes, mask_bytes, material_bytes, ref_bytes, furniture_bytes

    # ── 결과 저장 ───────────────────────────────────────────────────────────────
    def _save_outputs(self, prompt_id: str, workflow_name: str):
        try:
            history = self.comfy.get_history(prompt_id)
            outputs = history.get(prompt_id, {}).get("outputs", {})
            saved = 0
            for node_id, node_output in outputs.items():
                for img_info in node_output.get("images", []):
                    fname     = img_info["filename"]
                    subfolder = img_info.get("subfolder", "")
                    ftype     = img_info.get("type", "output")
                    data      = self.comfy.download_image(fname, subfolder, ftype)
                    ts        = int(time.time())
                    out_path  = OUTPUT_DIR / f"{workflow_name}_{ts}_{fname}"
                    out_path.write_bytes(data)
                    print(f"    {_G}[저장]{_RST} {out_path}")
                    saved += 1
            return saved
        except Exception as e:
            print(f"    {_Y}[경고]{_RST} 결과 저장 실패: {e}")
            return 0

    # ── 단일 워크플로우 테스트 ──────────────────────────────────────────────────
    async def run_one(self, name: str, workflow: dict) -> dict:
        print(f"\n{_BOLD}{'─'*60}{_RST}")
        print(f"{_BOLD}워크플로우: {name}{_RST}")
        print(f"{'─'*60}")

        # 노드 수 출력
        print(f"  노드 수: {len(workflow)}")

        # 큐 추가
        t_start = time.time()
        try:
            prompt_id = self.comfy.queue_prompt(workflow)
            print(f"  {_G}[큐 추가]{_RST} prompt_id = {prompt_id}")
        except Exception as e:
            print(f"  {_R}[실패]{_RST} 큐 추가 오류: {e}")
            return {"name": name, "status": "error", "error": str(e)}

        # WebSocket으로 완료 대기
        print(f"  {_C}[대기중]{_RST} 진행률 모니터링...")
        ok = await self.comfy.wait_for_completion(prompt_id, timeout=self.args.timeout)

        t_elapsed = time.time() - t_start

        if ok:
            saved = self._save_outputs(prompt_id, name)
            result = {
                "name":      name,
                "status":    "success",
                "elapsed_s": round(t_elapsed, 1),
                "saved":     saved,
                "prompt_id": prompt_id,
            }
            print(f"  {_G}[성공]{_RST} {t_elapsed:.1f}초, 이미지 {saved}장 저장")
        else:
            result = {
                "name":      name,
                "status":    "failed",
                "elapsed_s": round(t_elapsed, 1),
                "prompt_id": prompt_id,
            }
            print(f"  {_R}[실패]{_RST} {t_elapsed:.1f}초")

        self.results.append(result)
        return result

    # ── 워크플로우 목록 실행 ────────────────────────────────────────────────────
    async def run(self):
        print(f"\n{_BOLD}{'═'*60}{_RST}")
        print(f"{_BOLD} The Circle — ComfyUI 워크플로우 테스트{_RST}")
        print(f"{_BOLD}{'═'*60}{_RST}")
        print(f"  ComfyUI URL : {self.comfy.base_url}")
        print(f"  출력 폴더   : {OUTPUT_DIR.absolute()}")

        # 연결 확인
        print(f"\n  ComfyUI 연결 확인 중...")
        if not self.comfy.check_connection():
            print(f"  {_R}[오류]{_RST} ComfyUI에 연결할 수 없습니다.")
            print(f"         URL: {self.comfy.base_url}")
            print(f"         ComfyUI가 실행 중인지 확인하세요.")
            sys.exit(1)
        print(f"  {_G}[연결됨]{_RST} ComfyUI 정상")

        # 이미지 로드
        print(f"\n  입력 이미지 준비:")
        room, mask, material, reference, furniture = self._get_images()

        # 실행할 워크플로우 목록 결정
        target = self.args.workflow
        wf_to_run = []

        prompt = self.args.prompt or "modern scandinavian interior, white walls, soft lighting, cozy atmosphere"

        if target in ("circle_ai", "all"):
            wf_to_run.append(("circle_ai", self.wm.build_circle_ai_workflow(
                image_url=room, style_prompt=prompt
            )))

        if target in ("material_apply", "all"):
            wf_to_run.append(("material_apply", self.wm.build_material_apply_workflow(
                image_url=room, mask_data=mask, material_texture_url=material
            )))

        if target in ("mood_copy", "all"):
            wf_to_run.append(("mood_copy", self.wm.build_mood_copy_workflow(
                source_image_url=room, reference_image_url=reference
            )))

        if target in ("furniture_place", "all"):
            wf_to_run.append(("furniture_place", self.wm.build_furniture_place_workflow(
                image_url=room, furniture_image_url=furniture
            )))

        if target in ("final_render", "all"):
            wf_to_run.append(("final_render", self.wm.build_final_render_workflow(
                image_url=room
            )))

        if not wf_to_run:
            print(f"  {_R}[오류]{_RST} 알 수 없는 워크플로우: {target}")
            print(f"  사용 가능: circle_ai, material_apply, mood_copy, furniture_place, final_render, all")
            sys.exit(1)

        # JSON 저장 (--save-json 옵션)
        if self.args.save_json:
            for name, wf in wf_to_run:
                json_path = OUTPUT_DIR / f"{name}_workflow.json"
                json_path.write_text(json.dumps(wf, indent=2, ensure_ascii=False))
                print(f"  {_G}[JSON]{_RST} {json_path}")

        # Dry-run 모드
        if self.args.dry_run:
            print(f"\n  {_Y}[Dry-run 모드]{_RST} 워크플로우를 실제로 실행하지 않습니다.")
            for name, wf in wf_to_run:
                print(f"  - {name}: 노드 {len(wf)}개")
            return

        # 순차 실행
        for name, workflow in wf_to_run:
            await self.run_one(name, workflow)

        # 최종 요약
        self._print_summary()

    def _print_summary(self):
        print(f"\n{_BOLD}{'═'*60}{_RST}")
        print(f"{_BOLD} 테스트 결과 요약{_RST}")
        print(f"{'─'*60}")
        ok  = sum(1 for r in self.results if r["status"] == "success")
        fail= sum(1 for r in self.results if r["status"] != "success")
        for r in self.results:
            icon = _G + "✓" + _RST if r["status"] == "success" else _R + "✗" + _RST
            elapsed = r.get("elapsed_s", "?")
            print(f"  {icon} {r['name']:<20} {elapsed}s")
        print(f"{'─'*60}")
        print(f"  합계: {_G}{ok}성공{_RST} / {_R}{fail}실패{_RST} / 전체 {len(self.results)}")
        if ok > 0:
            print(f"  결과 이미지: {OUTPUT_DIR.absolute()}/")
        print(f"{_BOLD}{'═'*60}{_RST}\n")


# ══════════════════════════════════════════════════════════════════════════════
#  CLI 진입점
# ══════════════════════════════════════════════════════════════════════════════

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="ComfyUI 워크플로우 로컬 테스트",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--workflow", "-w",
        default="all",
        choices=["all", "circle_ai", "material_apply", "mood_copy",
                 "furniture_place", "final_render"],
        help="실행할 워크플로우 (기본: all)",
    )
    p.add_argument("--image",     "-i", default=None, help="방 이미지 경로 (없으면 합성)")
    p.add_argument("--mask",      "-m", default=None, help="마스크 이미지 경로")
    p.add_argument("--material",  default=None, help="자재 타일 이미지 경로")
    p.add_argument("--reference", default=None, help="무드 레퍼런스 이미지 경로")
    p.add_argument("--furniture", default=None, help="가구 이미지 경로")
    p.add_argument("--prompt",    "-p", default=None, help="스타일 프롬프트 (circle_ai용)")
    p.add_argument("--comfyui-url", default=COMFYUI_URL, help=f"ComfyUI URL (기본: {COMFYUI_URL})")
    p.add_argument("--timeout",  "-t", type=int, default=300, help="워크플로우 타임아웃 초 (기본: 300)")
    p.add_argument("--save-json", action="store_true", help="워크플로우 JSON을 outputs/에 저장")
    p.add_argument("--dry-run",  action="store_true", help="연결/빌드만 확인, 실제 실행 안 함")
    return p.parse_args()


def main():
    args = parse_args()
    tester = WorkflowTester(args)
    asyncio.run(tester.run())


if __name__ == "__main__":
    main()
