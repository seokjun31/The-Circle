"""
RunPod 연결 테스트 스크립트
============================
Usage:
  python scripts/test_runpod.py

필요한 환경변수 (backend/.env에서 읽음):
  RUNPOD_API_KEY=rpa_xxxx
  RUNPOD_ENDPOINT_ID=u9xrrayq77zd68
"""

import base64
import io
import json
import os
import sys
import time
from pathlib import Path

# backend/.env 자동 로드
env_path = Path(__file__).parent.parent / "backend" / ".env"
if env_path.exists():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())

try:
    import requests
except ImportError:
    print("requests 없음. 설치: pip install requests")
    sys.exit(1)

try:
    from PIL import Image, ImageDraw
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    print("⚠️  Pillow 없음. 설치: pip install Pillow")

API_KEY     = os.environ.get("RUNPOD_API_KEY", "")
ENDPOINT_ID = os.environ.get("RUNPOD_ENDPOINT_ID", "")

if not API_KEY or not ENDPOINT_ID:
    print("❌ RUNPOD_API_KEY 또는 RUNPOD_ENDPOINT_ID가 없습니다.")
    sys.exit(1)

BASE_URL = f"https://api.runpod.ai/v2/{ENDPOINT_ID}"
HEADERS  = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

print(f"🔌 RunPod Mood 워크플로우 테스트")
print(f"   Endpoint: {ENDPOINT_ID}")
print(f"   API Key:  {API_KEY[:10]}...")
print()


# ── 테스트 이미지 생성 ──────────────────────────────────────────────────────────

def make_test_image_b64(width: int = 512, height: int = 512, color=(100, 120, 160)) -> str:
    """단색 테스트 이미지를 base64 JPEG으로 반환."""
    if not HAS_PIL:
        # PIL 없으면 1x1 흰색 픽셀 JPEG (fallback)
        return (
            "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDB"
            "kSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/"
            "wAARCAABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB/"
            "8QABRABAAAAAAAAAAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAD/"
            "xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAB//2Q=="
        )
    img = Image.new("RGB", (width, height), color=color)
    draw = ImageDraw.Draw(img)
    # 간단한 격자 패턴 (방처럼 보이게)
    for x in range(0, width, 64):
        draw.line([(x, 0), (x, height)], fill=(80, 100, 130), width=1)
    for y in range(0, height, 64):
        draw.line([(0, y), (width, y)], fill=(80, 100, 130), width=1)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


# ── mood.json 로드 ─────────────────────────────────────────────────────────────

workflow_path = Path(__file__).parent.parent / "backend" / "comfyui_workflows" / "mood.json"
if not workflow_path.exists():
    print(f"❌ mood.json 없음: {workflow_path}")
    sys.exit(1)

with open(workflow_path, encoding="utf-8") as f:
    raw = json.load(f)

# ComfyUI API 형식으로 변환 (class_type 없는 메타 키 제거)
workflow = {
    k: v for k, v in raw.items()
    if isinstance(v, dict) and "class_type" in v
}
for node in workflow.values():
    node.pop("_label", None)
    node.pop("_comment", None)

print(f"📋 mood.json 로드 완료 — 노드 {len(workflow)}개:")
for nid, node in sorted(workflow.items(), key=lambda x: int(x[0])):
    print(f"   Node {nid:>2}: {node['class_type']}")
print()

# ── 테스트 이미지 주입 ──────────────────────────────────────────────────────────

print("🖼️  테스트 이미지 생성 중...")
src_b64 = make_test_image_b64(512, 512, color=(110, 130, 155))  # 방 이미지 (파란 계열)
ref_b64 = make_test_image_b64(512, 512, color=(200, 160, 100))  # 참조 이미지 (따뜻한 계열)

workflow["1"]["inputs"]["image"] = src_b64
workflow["2"]["inputs"]["image"] = ref_b64

# 빠른 테스트를 위해 steps 줄이기
if "17" in workflow:
    workflow["17"]["inputs"]["steps"] = 5
    workflow["17"]["inputs"]["seed"]  = 12345

print(f"   소스 이미지: {len(src_b64)} chars")
print(f"   참조 이미지: {len(ref_b64)} chars")
print()

# ── 1. Endpoint 상태 확인 ─────────────────────────────────────────────────────
print("1️⃣  Endpoint 상태 확인...")
try:
    r = requests.get(f"{BASE_URL}/health", headers=HEADERS, timeout=10)
    print(f"   HTTP {r.status_code}: {r.text[:200]}")
except Exception as e:
    print(f"   ❌ 연결 실패: {e}")
    sys.exit(1)

# ── 2. Mood 워크플로우 제출 ───────────────────────────────────────────────────
print()
print("2️⃣  Mood 워크플로우 제출...")

payload = {
    "input": {
        "workflow":      workflow,
        "timeout":       300,
        "upload_result": False,
    }
}

try:
    r = requests.post(f"{BASE_URL}/run", headers=HEADERS, json=payload, timeout=30)
    print(f"   HTTP {r.status_code}")
    data = r.json()
    print(f"   Response: {json.dumps(data, indent=2)[:300]}")
except Exception as e:
    print(f"   ❌ Job 제출 실패: {e}")
    sys.exit(1)

job_id = data.get("id")
if not job_id:
    print("   ❌ job_id 없음 → 제출 실패")
    sys.exit(1)

print(f"   ✅ Job ID: {job_id}")

# ── 3. Status 폴링 (최대 10분) ────────────────────────────────────────────────
print()
print("3️⃣  Job 상태 폴링 (최대 10분)...")

for i in range(120):
    time.sleep(5)
    try:
        r = requests.get(f"{BASE_URL}/status/{job_id}", headers=HEADERS, timeout=10)
        status_data = r.json()
        status = status_data.get("status", "unknown")
        print(f"   [{i*5:3d}s] status={status}")

        if status == "IN_PROGRESS" and i == 0:
            print("         → ComfyUI 워크플로우 실행 시작!")

        if status == "COMPLETED":
            print()
            print("   ✅ 완료!")
            output = status_data.get("output", {})
            if output.get("image_base64"):
                img_len = len(output["image_base64"])
                print(f"   이미지 수신: {img_len} chars ({img_len*3//4//1024} KB)")
                # 결과 이미지 저장
                out_path = Path(__file__).parent / "test_mood_result.jpg"
                out_path.write_bytes(base64.b64decode(output["image_base64"]))
                print(f"   저장됨: {out_path}")
            print(f"   elapsed_s: {output.get('elapsed_s')}")
            print()
            print("🎉 Mood 워크플로우 완전 성공!")
            sys.exit(0)

        elif status in ("FAILED", "CANCELLED", "TIMED_OUT"):
            print()
            print(f"   ❌ Job {status}")
            err = status_data.get("error", "unknown")
            print(f"   Error: {err}")
            if status == "CANCELLED":
                print("💡 GPU 재고 없음")
            elif status == "FAILED":
                print("💡 RunPod Logs 탭에서 에러 본문 확인")
            sys.exit(1)

    except Exception as e:
        print(f"   폴링 오류: {e}")

print("   ⏰ 10분 타임아웃")
sys.exit(1)
