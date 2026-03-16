#!/usr/bin/env bash
# ============================================================
#  The Circle — SAM ONNX Model Downloader
#
#  Downloads the MobileSAM ONNX encoder + decoder and places them in:
#    client/public/models/   — served as static files by CRA (browser use)
#    /models/sam/            — for the server-side fallback encoder
#
#  MobileSAM is ~40× smaller than SAM ViT-H while retaining most accuracy.
#  The decoder is the standard SAM decoder and is shared across all variants.
#
#  Usage:
#    bash scripts/download_sam_onnx.sh            # full download
#    bash scripts/download_sam_onnx.sh --frontend-only
#    bash scripts/download_sam_onnx.sh --backend-only
#
#  Environment:
#    HF_TOKEN   — HuggingFace access token (optional; needed only for gated repos)
#    MODELS_DIR — override server model directory (default: /models/sam)
# ============================================================
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_MODELS="${REPO_ROOT}/client/public/models"
BACKEND_MODELS="${MODELS_DIR:-/models/sam}"
HF_TOKEN="${HF_TOKEN:-}"

FRONTEND_ONLY=false
BACKEND_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --frontend-only) FRONTEND_ONLY=true ;;
    --backend-only)  BACKEND_ONLY=true  ;;
  esac
done

# ── Colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[SAM]${NC} $*"; }
warn()  { echo -e "${YELLOW}[SAM] WARN:${NC} $*" >&2; }
error() { echo -e "${RED}[SAM] ERROR:${NC} $*" >&2; }

# ── Downloader ────────────────────────────────────────────────────────────────

download_if_missing() {
  local dest="$1"
  local url="$2"
  local label="${3:-$(basename "${dest}")}"

  if [[ -f "${dest}" ]]; then
    info "SKIP  ${label} (already exists)"
    return 0
  fi

  info "DOWN  ${label}"
  info "      → ${dest}"
  mkdir -p "$(dirname "${dest}")"

  local hf_header=()
  if [[ -n "${HF_TOKEN}" && "${url}" == *huggingface.co* ]]; then
    hf_header=(--header "Authorization: Bearer ${HF_TOKEN}")
  fi

  if command -v aria2c &>/dev/null; then
    aria2c \
      --file-allocation=none \
      --continue=true \
      --max-connection-per-server=8 \
      --split=8 \
      --dir="$(dirname "${dest}")" \
      --out="$(basename "${dest}")" \
      "${hf_header[@]}" \
      "${url}" \
    || { warn "aria2c failed — retrying with wget"; wget -q --show-progress -O "${dest}" "${url}"; }
  else
    wget -q --show-progress "${hf_header[@]}" -O "${dest}" "${url}"
  fi

  local size
  size=$(du -sh "${dest}" | cut -f1)
  info "DONE  ${label} (${size})"
}

# ─────────────────────────────────────────────────────────────────────────────
#  Model URLs
#
#  Encoder: MobileSAM ViT-T encoder, ONNX export.
#    Source: Ultralytics / dhkim2810 HuggingFace hub.
#    Quantised INT8 version (~9 MB) preferred for browser; full FP32 (~40 MB)
#    is kept as fallback for server use.
#
#  Decoder: Standard SAM ViT-H decoder ONNX export.
#    Compatible with MobileSAM encoder outputs (same embedding dimension).
#    Input names match the SAM demo repo convention.
# ─────────────────────────────────────────────────────────────────────────────

# Quantised MobileSAM encoder — optimised for browser (WASM / WebGL)
ENCODER_QUANT_URL="https://huggingface.co/dhkim2810/MobileSAM/resolve/main/mobile_sam_encoder.onnx"
ENCODER_QUANT_FILE="sam_encoder.onnx"

# Full FP32 encoder — used by the server-side fallback (more accurate)
ENCODER_FP32_URL="${ENCODER_QUANT_URL}"  # same file; swap if a FP32 export is available
ENCODER_FP32_FILE="sam_encoder.onnx"

# SAM decoder (shared across all encoder variants)
DECODER_URL="https://huggingface.co/dhkim2810/MobileSAM/resolve/main/mobile_sam_decoder.onnx"
DECODER_FILE="sam_decoder.onnx"

# ── Frontend models (public/models/) ─────────────────────────────────────────

if [[ "${BACKEND_ONLY}" == "false" ]]; then
  info "=== Frontend models → ${FRONTEND_MODELS} ==="
  mkdir -p "${FRONTEND_MODELS}"

  download_if_missing \
    "${FRONTEND_MODELS}/${ENCODER_QUANT_FILE}" \
    "${ENCODER_QUANT_URL}" \
    "MobileSAM encoder ONNX (browser)"

  download_if_missing \
    "${FRONTEND_MODELS}/${DECODER_FILE}" \
    "${DECODER_URL}" \
    "SAM decoder ONNX (browser)"

  info "Frontend models ready.  Served by CRA at /models/"
fi

# ── Backend models (/models/sam/) ─────────────────────────────────────────────

if [[ "${FRONTEND_ONLY}" == "false" ]]; then
  info "=== Backend models → ${BACKEND_MODELS} ==="
  mkdir -p "${BACKEND_MODELS}"

  download_if_missing \
    "${BACKEND_MODELS}/${ENCODER_FP32_FILE}" \
    "${ENCODER_FP32_URL}" \
    "MobileSAM encoder ONNX (server fallback)"

  # Verify ONNX runtime can load the model
  if command -v python3 &>/dev/null; then
    info "Verifying encoder ONNX model..."
    python3 - <<'PY'
import sys
try:
    import onnxruntime as ort
    sess = ort.InferenceSession(
        sys.argv[1] if len(sys.argv) > 1 else "/models/sam/sam_encoder.onnx",
        providers=["CPUExecutionProvider"],
    )
    inp = sess.get_inputs()
    out = sess.get_outputs()
    print(f"  Inputs : {[i.name for i in inp]}")
    print(f"  Outputs: {[o.name for o in out]}")
    print("  Encoder model OK")
except ImportError:
    print("  onnxruntime not installed — skipping verification")
except Exception as e:
    print(f"  WARNING: {e}")
PY
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────────────
info "=========================================="
info "SAM ONNX model setup complete."
info ""
info "Frontend: ${FRONTEND_MODELS}/"
[[ "${BACKEND_ONLY}" == "false" ]] && ls -lh "${FRONTEND_MODELS}/"*.onnx 2>/dev/null || true
info ""
info "Backend:  ${BACKEND_MODELS}/"
[[ "${FRONTEND_ONLY}" == "false" ]] && ls -lh "${BACKEND_MODELS}/"*.onnx 2>/dev/null || true
info ""
info "Next steps:"
info "  1. Start the dev server: cd client && npm start"
info "  2. The encoder (~40 MB) is loaded on first page visit."
info "  3. Set SAM_ENCODER_MODEL_PATH=/models/sam/sam_encoder.onnx in .env"
info "=========================================="
