"""
RunPod 연결 테스트 스크립트
============================
Usage:
  python scripts/test_runpod.py

필요한 환경변수 (backend/.env에서 읽음):
  RUNPOD_API_KEY=rpa_xxxx
  RUNPOD_ENDPOINT_ID=u9xrrayq77zd68
"""

import os
import sys
import time
import json
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

API_KEY     = os.environ.get("RUNPOD_API_KEY", "")
ENDPOINT_ID = os.environ.get("RUNPOD_ENDPOINT_ID", "")

if not API_KEY or not ENDPOINT_ID:
    print("❌ RUNPOD_API_KEY 또는 RUNPOD_ENDPOINT_ID가 없습니다.")
    print(f"   .env 경로: {env_path}")
    sys.exit(1)

BASE_URL = f"https://api.runpod.ai/v2/{ENDPOINT_ID}"
HEADERS  = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

print(f"🔌 RunPod 연결 테스트")
print(f"   Endpoint: {ENDPOINT_ID}")
print(f"   API Key:  {API_KEY[:10]}...")
print()

# ── 1. Endpoint 상태 확인 ─────────────────────────────────────────────────────
print("1️⃣  Endpoint 상태 확인...")
try:
    r = requests.get(f"{BASE_URL}/health", headers=HEADERS, timeout=10)
    print(f"   HTTP {r.status_code}: {r.text[:200]}")
except Exception as e:
    print(f"   ❌ 연결 실패: {e}")
    sys.exit(1)

# ── 2. 최소 Job 제출 (Note 노드만 있는 워크플로우) ────────────────────────────
print()
print("2️⃣  최소 Job 제출 (ComfyUI Note 노드 테스트)...")

payload = {
    "input": {
        "workflow": {
            "1": {
                "class_type": "EmptyLatentImage",
                "inputs": {
                    "width": 64,
                    "height": 64,
                    "batch_size": 1
                }
            }
        },
        "timeout": 60,
        "upload_result": False
    }
}

try:
    r = requests.post(f"{BASE_URL}/run", headers=HEADERS, json=payload, timeout=15)
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

# ── 3. Status 폴링 ────────────────────────────────────────────────────────────
print()
print("3️⃣  Job 상태 폴링 (최대 5분)...")

for i in range(60):
    time.sleep(3)
    try:
        r = requests.get(f"{BASE_URL}/status/{job_id}", headers=HEADERS, timeout=10)
        status_data = r.json()
        status = status_data.get("status", "unknown")
        print(f"   [{i*3:3d}s] status={status}")

        if status == "IN_PROGRESS":
            print()
            print("   ✅ Job IN_PROGRESS — ComfyUI 연결 확인!")
            print("🎉 RunPod + ComfyUI 연결 정상! (워크플로우 실행 중)")

        if status == "COMPLETED":
            print()
            print("   ✅ Job 완료!")
            output = status_data.get("output", {})
            print(f"   Output: {json.dumps(output, indent=2)[:300]}")
            print()
            print("🎉 RunPod 연결 정상!")
            sys.exit(0)

        elif status in ("FAILED", "CANCELLED", "TIMED_OUT"):
            print()
            print(f"   ❌ Job {status}")
            print(f"   Error: {status_data.get('error', 'unknown')}")
            print()
            if status == "CANCELLED":
                print("💡 원인: GPU 재고 없음 → Active Workers=1 설정 필요")
            elif status == "FAILED":
                print("💡 원인: 핸들러 오류 → RunPod Logs 탭 확인")
            sys.exit(1)

    except Exception as e:
        print(f"   폴링 오류: {e}")

print("   ⏰ 5분 타임아웃")
print("💡 워커가 시작 중일 수 있습니다. Active Workers=1 설정을 권장합니다.")
