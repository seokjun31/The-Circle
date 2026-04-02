# ============================================================
#  The Circle — ComfyUI RunPod Serverless Image
#  Base: CUDA 12.1 + cuDNN 8 (Ubuntu 22.04)
#
#  Build:  docker build -t the-circle-comfyui .
#  Push:   docker tag the-circle-comfyui <registry>/the-circle-comfyui:latest
#          docker push <registry>/the-circle-comfyui:latest
# ============================================================
FROM nvidia/cuda:12.1.0-cudnn8-runtime-ubuntu22.04

LABEL maintainer="The Circle Team"
LABEL description="ComfyUI RunPod Serverless — Interior AI Rendering"

# ── System environment ─────────────────────────────────────────────────────────
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    COMFYUI_DIR=/ComfyUI \
    MODEL_DIR=/runpod-volume/models \
    CUSTOM_NODES_DIR=/ComfyUI/custom_nodes \
    PORT=8188

# ── System packages ────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 \
    python3.11-dev \
    python3-pip \
    git \
    wget \
    curl \
    aria2 \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python

# ── PyTorch (CUDA 12.1) ────────────────────────────────────────────────────────
RUN pip install --upgrade pip && \
    pip install \
    torch==2.4.1 \
    torchvision==0.19.1 \
    torchaudio==2.4.1 \
    --index-url https://download.pytorch.org/whl/cu121

# ── ComfyUI ───────────────────────────────────────────────────────────────────
RUN git clone --depth 1 https://github.com/comfyanonymous/ComfyUI ${COMFYUI_DIR}
RUN pip install -r ${COMFYUI_DIR}/requirements.txt

# ── xformers (memory-efficient attention) ─────────────────────────────────────
RUN pip install xformers==0.0.28.post3 --index-url https://download.pytorch.org/whl/cu121

# ── Custom nodes ──────────────────────────────────────────────────────────────
# 1. ComfyUI-Manager (node management, must be first)
RUN git clone --depth 1 \
    https://github.com/ltdrdata/ComfyUI-Manager \
    ${CUSTOM_NODES_DIR}/ComfyUI-Manager && \
    pip install -r ${CUSTOM_NODES_DIR}/ComfyUI-Manager/requirements.txt || true

# 2. Segment Anything (SAM — server-side fallback for precise masking)
RUN git clone --depth 1 \
    https://github.com/storyicon/comfyui_segment_anything \
    ${CUSTOM_NODES_DIR}/comfyui_segment_anything && \
    pip install -r ${CUSTOM_NODES_DIR}/comfyui_segment_anything/requirements.txt || true

# 3. IPAdapter Plus (style transfer + material texture application)
RUN git clone --depth 1 \
    https://github.com/cubiq/ComfyUI_IPAdapter_plus \
    ${CUSTOM_NODES_DIR}/ComfyUI_IPAdapter_plus

# 4. ComfyUI Essentials (ETN_LoadImageBase64, ETN_LoadMaskBase64, image compositing)
RUN git clone --depth 1 \
    https://github.com/cubiq/ComfyUI_Essentials \
    ${CUSTOM_NODES_DIR}/ComfyUI_Essentials && \
    pip install -r ${CUSTOM_NODES_DIR}/ComfyUI_Essentials/requirements.txt || true

# 5. KJNodes (advanced image/mask manipulation)
RUN git clone --depth 1 \
    https://github.com/kijai/ComfyUI-KJNodes \
    ${CUSTOM_NODES_DIR}/ComfyUI-KJNodes && \
    pip install -r ${CUSTOM_NODES_DIR}/ComfyUI-KJNodes/requirements.txt || true

# ── Handler dependencies ───────────────────────────────────────────────────────
COPY requirements.txt /requirements-handler.txt
RUN pip install -r /requirements-handler.txt

# ── Pin critical versions to prevent conflicts ────────────────────────────────
RUN pip install --force-reinstall --no-deps \
    yarl==1.9.4 \
    aiohttp==3.9.5 \
    numpy==1.26.4 \
    scipy==1.11.4

# ── ComfyUI model path config (reads from Network Volume) ─────────────────────
COPY extra_model_paths.yaml ${COMFYUI_DIR}/extra_model_paths.yaml

# ── Application files ──────────────────────────────────────────────────────────
COPY handler.py       /handler.py
COPY start.sh         /start.sh
COPY download_models.sh /download_models.sh
# Fix CRLF line endings (Windows build환경 대응)
RUN sed -i 's/\r$//' /start.sh /download_models.sh \
    && chmod +x /start.sh /download_models.sh

# ── Create local model dir fallback (used when Network Volume is unavailable) ──
RUN mkdir -p \
    ${COMFYUI_DIR}/models/checkpoints \
    ${COMFYUI_DIR}/models/vae \
    ${COMFYUI_DIR}/models/clip_vision \
    ${COMFYUI_DIR}/models/controlnet \
    ${COMFYUI_DIR}/models/ipadapter \
    ${COMFYUI_DIR}/models/loras \
    ${COMFYUI_DIR}/models/upscale_models \
    ${COMFYUI_DIR}/models/segment_anything

WORKDIR /ComfyUI

# RunPod Serverless — handler is the entrypoint
CMD ["/start.sh"]
