#!/usr/bin/env bash
# ============================================================
#  The Circle — RunPod Network Volume Model Downloader
#
#  Run once to pre-populate the Network Volume at /runpod-volume/models/.
#  All subsequent container starts will skip already-downloaded files.
#
#  Usage (from RunPod terminal, after attaching Network Volume):
#    bash /download_models.sh
#
#  Required env vars (if using gated HuggingFace models):
#    HF_TOKEN — HuggingFace access token
#
#  Model layout on Network Volume:
#    /runpod-volume/models/
#      checkpoints/         SDXL base, SDXL refiner
#      controlnet/          depth-sdxl, canny-sdxl, normal-sdxl
#      clip_vision/         CLIP-ViT-H-14 (for IP-Adapter SDXL)
#      ipadapter/           ip-adapter-plus_sdxl_vit-h.bin
#      segment_anything/    sam_vit_h_4b8939.pth
#      loras/               korea-apartment-style_v1.safetensors
#      vae/                 (built into SDXL checkpoint — optional standalone)
# ============================================================
set -euo pipefail

MODEL_DIR="${MODEL_DIR:-/runpod-volume/models}"
HF_TOKEN="${HF_TOKEN:-}"
LOG_PREFIX="[download_models.sh]"

# ── Helpers ───────────────────────────────────────────────────────────────────

# Print with prefix
info()  { echo "${LOG_PREFIX} $*"; }
warn()  { echo "${LOG_PREFIX} WARN: $*" >&2; }
error() { echo "${LOG_PREFIX} ERROR: $*" >&2; }

# Download $url to $dest only if $dest does not already exist.
# Uses aria2c for parallel chunks, falls back to wget.
download_if_missing() {
    local dest="$1"
    local url="$2"
    local label="${3:-$(basename "${dest}")}"

    if [[ -f "${dest}" ]]; then
        info "SKIP  ${label} (already exists: ${dest})"
        return 0
    fi

    info "DOWN  ${label}"
    info "      → ${dest}"
    mkdir -p "$(dirname "${dest}")"

    local extra_headers=()
    if [[ -n "${HF_TOKEN}" && "${url}" == *huggingface.co* ]]; then
        extra_headers=(--header "Authorization: Bearer ${HF_TOKEN}")
    fi

    # Try aria2c first (faster multi-connection), fall back to wget
    if command -v aria2c &> /dev/null; then
        aria2c \
            --file-allocation=none \
            --continue=true \
            --max-connection-per-server=8 \
            --split=8 \
            --dir="$(dirname "${dest}")" \
            --out="$(basename "${dest}")" \
            "${extra_headers[@]}" \
            "${url}" \
        || { warn "aria2c failed — retrying with wget"; wget -q --show-progress -O "${dest}" "${url}"; }
    else
        wget -q --show-progress "${extra_headers[@]}" -O "${dest}" "${url}"
    fi

    local size
    size=$(du -sh "${dest}" | cut -f1)
    info "DONE  ${label} (${size})"
}

# ── Create directory structure ────────────────────────────────────────────────
info "Creating directory structure at ${MODEL_DIR}..."
mkdir -p \
    "${MODEL_DIR}/checkpoints" \
    "${MODEL_DIR}/vae" \
    "${MODEL_DIR}/clip_vision" \
    "${MODEL_DIR}/controlnet" \
    "${MODEL_DIR}/ipadapter" \
    "${MODEL_DIR}/segment_anything" \
    "${MODEL_DIR}/loras" \
    "${MODEL_DIR}/upscale_models"

# ═══════════════════════════════════════════════════════════════════════════════
#  1. SDXL Base 1.0
# ═══════════════════════════════════════════════════════════════════════════════
download_if_missing \
    "${MODEL_DIR}/checkpoints/sdxl_base_1.0.safetensors" \
    "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors" \
    "SDXL Base 1.0 (~6.9 GB)"

# ═══════════════════════════════════════════════════════════════════════════════
#  2. SDXL Refiner 1.0
#     Used in build_final_render_workflow for 2-stage high-quality output
# ═══════════════════════════════════════════════════════════════════════════════
download_if_missing \
    "${MODEL_DIR}/checkpoints/sdxl_refiner_1.0.safetensors" \
    "https://huggingface.co/stabilityai/stable-diffusion-xl-refiner-1.0/resolve/main/sd_xl_refiner_1.0.safetensors" \
    "SDXL Refiner 1.0 (~6.1 GB)"

# ═══════════════════════════════════════════════════════════════════════════════
#  3. CLIP Vision — ViT-H (required by IP-Adapter SDXL)
#     NOT the same as the text CLIP inside the checkpoint!
# ═══════════════════════════════════════════════════════════════════════════════
download_if_missing \
    "${MODEL_DIR}/clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors" \
    "https://huggingface.co/h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors" \
    "CLIP-ViT-H-14 (IP-Adapter image encoder, ~2.4 GB)"

# ═══════════════════════════════════════════════════════════════════════════════
#  4. IP-Adapter SDXL ViT-H Plus
#     Style transfer + material texture application
# ═══════════════════════════════════════════════════════════════════════════════
download_if_missing \
    "${MODEL_DIR}/ipadapter/ip-adapter-plus_sdxl_vit-h.bin" \
    "https://huggingface.co/h94/IP-Adapter/resolve/main/sdxl_models/ip-adapter-plus_sdxl_vit-h.bin" \
    "IP-Adapter SDXL Plus ViT-H (~858 MB)"

# ═══════════════════════════════════════════════════════════════════════════════
#  5. ControlNet models for SDXL
# ═══════════════════════════════════════════════════════════════════════════════

# Depth (structure preservation — primary for material apply workflow)
download_if_missing \
    "${MODEL_DIR}/controlnet/controlnet-depth-sdxl-1.0.safetensors" \
    "https://huggingface.co/diffusers/controlnet-depth-sdxl-1.0/resolve/main/diffusion_pytorch_model.fp16.safetensors" \
    "ControlNet Depth SDXL (~2.5 GB)"

# Canny (edge guidance — used for floor/wall boundary preservation)
download_if_missing \
    "${MODEL_DIR}/controlnet/controlnet-canny-sdxl-1.0.safetensors" \
    "https://huggingface.co/diffusers/controlnet-canny-sdxl-1.0/resolve/main/diffusion_pytorch_model.fp16.safetensors" \
    "ControlNet Canny SDXL (~2.5 GB)"

# Normal map (surface material rendering quality)
download_if_missing \
    "${MODEL_DIR}/controlnet/controlnet-normal-sdxl-1.0.safetensors" \
    "https://huggingface.co/xinsir/controlnet-union-sdxl-1.0/resolve/main/diffusion_pytorch_model_promax.safetensors" \
    "ControlNet Normal/Union SDXL (~2.5 GB)"

# ═══════════════════════════════════════════════════════════════════════════════
#  6. SAM ViT-H (Segment Anything — server-side fallback for precise masking)
# ═══════════════════════════════════════════════════════════════════════════════
download_if_missing \
    "${MODEL_DIR}/segment_anything/sam_vit_h_4b8939.pth" \
    "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_h_4b8939.pth" \
    "SAM ViT-H (~2.4 GB)"

# ═══════════════════════════════════════════════════════════════════════════════
#  7. SDXL VAE (improved colour fidelity — optional but recommended)
# ═══════════════════════════════════════════════════════════════════════════════
download_if_missing \
    "${MODEL_DIR}/vae/sdxl_vae.safetensors" \
    "https://huggingface.co/stabilityai/sdxl-vae/resolve/main/sdxl_vae.safetensors" \
    "SDXL VAE (~335 MB)"

# ═══════════════════════════════════════════════════════════════════════════════
#  8. Real-ESRGAN Upscaler (2×, used in final render for high-res output)
# ═══════════════════════════════════════════════════════════════════════════════
download_if_missing \
    "${MODEL_DIR}/upscale_models/RealESRGAN_x2plus.pth" \
    "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth" \
    "Real-ESRGAN 2x (~63 MB)"

# ═══════════════════════════════════════════════════════════════════════════════
#  9. Korea apartment style LoRA (custom — upload manually to network volume)
# ═══════════════════════════════════════════════════════════════════════════════
if [[ ! -f "${MODEL_DIR}/loras/korea-apartment-style_v1.safetensors" ]]; then
    warn "korea-apartment-style_v1.safetensors not found."
    warn "Upload it manually to ${MODEL_DIR}/loras/ for best results."
fi

# ── Summary ───────────────────────────────────────────────────────────────────
info "=================================================="
info "Model download complete.  Directory listing:"
du -sh "${MODEL_DIR}"/*/
info "=================================================="
