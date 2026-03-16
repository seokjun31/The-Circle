#!/usr/bin/env bash
# ============================================================
#  The Circle — ComfyUI + RunPod handler startup script
#
#  Execution order:
#    1. (Optional) Download missing models from Network Volume
#    2. Start ComfyUI server in background
#    3. Wait for ComfyUI to respond on :8188
#    4. Start RunPod Serverless handler (blocks)
# ============================================================
set -euo pipefail

COMFYUI_DIR="/ComfyUI"
COMFYUI_PORT="${COMFYUI_PORT:-8188}"
COMFYUI_READY_TIMEOUT="${COMFYUI_READY_TIMEOUT:-120}"
LOG_FILE="/tmp/comfyui.log"

# ── 1. Download models if Network Volume is available ─────────────────────────
if [[ -d /runpod-volume ]] && [[ "${SKIP_MODEL_DOWNLOAD:-false}" != "true" ]]; then
    echo "[start.sh] Network Volume detected — checking models..."
    /download_models.sh 2>&1 | tee /tmp/model_download.log || {
        echo "[start.sh] WARN: model download had errors — continuing anyway"
    }
else
    echo "[start.sh] Skipping model download (no network volume or SKIP_MODEL_DOWNLOAD=true)"
fi

# ── 2. Start ComfyUI in background ────────────────────────────────────────────
echo "[start.sh] Starting ComfyUI on port ${COMFYUI_PORT}..."
cd "${COMFYUI_DIR}"
python main.py \
    --listen 127.0.0.1 \
    --port "${COMFYUI_PORT}" \
    --disable-auto-launch \
    --dont-upcast-attention \
    ${COMFYUI_EXTRA_ARGS:-} \
    > "${LOG_FILE}" 2>&1 &
COMFYUI_PID=$!
echo "[start.sh] ComfyUI started (PID ${COMFYUI_PID})"

# ── 3. Wait for ComfyUI to be ready ───────────────────────────────────────────
echo "[start.sh] Waiting for ComfyUI to be ready (timeout: ${COMFYUI_READY_TIMEOUT}s)..."
ELAPSED=0
INTERVAL=3
until curl -sf "http://127.0.0.1:${COMFYUI_PORT}/system_stats" > /dev/null 2>&1; do
    if (( ELAPSED >= COMFYUI_READY_TIMEOUT )); then
        echo "[start.sh] ERROR: ComfyUI did not start within ${COMFYUI_READY_TIMEOUT}s"
        echo "[start.sh] Last ComfyUI logs:"
        tail -50 "${LOG_FILE}"
        exit 1
    fi
    # Show a dot every 3 seconds so RunPod knows we're alive
    echo -n "."
    sleep "${INTERVAL}"
    (( ELAPSED += INTERVAL ))
done
echo ""
echo "[start.sh] ComfyUI ready after ${ELAPSED}s"

# ── 4. Start RunPod handler ───────────────────────────────────────────────────
echo "[start.sh] Starting RunPod Serverless handler..."
exec python -u /handler.py
