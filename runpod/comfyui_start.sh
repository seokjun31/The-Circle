#!/bin/bash
set -e

echo "▶ Starting ComfyUI server..."
cd /ComfyUI
python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch &
COMFY_PID=$!

echo "▶ Waiting for ComfyUI to be ready..."
for i in $(seq 1 120); do
  if curl -s http://127.0.0.1:8188/system_stats > /dev/null 2>&1; then
    echo "✅ ComfyUI is ready (${i}s)"
    break
  fi
  sleep 1
done

echo "▶ Starting RunPod handler..."
cd /app
exec python -u handler.py
