"""
api_client.py
─────────────
Replicate API 통신 모듈.

지원 모델:
  - SDXL Inpainting (기본값, 고품질 1024px)
    모델: lucataco/sdxl-inpainting
  - SD 1.5 Inpainting (경량, 512px)
    모델: stability-ai/stable-diffusion-inpainting

LoRA 지원:
  - Replicate 에서 LoRA 를 직접 로드하려면 HuggingFace URL 또는 Replicate 모델 URL 을
    replicate_weights 파라미터에 전달한다.
  - LoRA URL 이 비어 있으면 기본 베이스 모델만 사용한다.

확장 포인트 (360도 파노라마 페이즈):
  - 이 모듈의 run_inpainting() 함수는 단일 이미지 처리용이므로,
    향후 큐브맵 6면을 순차 호출하는 루프에서 그대로 재사용할 수 있다.
"""

from __future__ import annotations

import io
import logging
import os
from dataclasses import dataclass, field
from typing import Optional
from urllib.request import urlretrieve

import replicate  # type: ignore
from PIL import Image

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────
# 사용 가능한 Replicate Inpainting 모델 목록
# ──────────────────────────────────────────────
MODELS = {
    "SDXL Inpainting (고품질, 권장)": (
        "lucataco/sdxl-inpainting:a9758cbfbd5f3c2094457d996681af52552901a2"
        "c0f9c8c99aa965814e7e33d1a3a0"
    ),
    "SD 1.5 Inpainting (빠름, 경량)": (
        "stability-ai/stable-diffusion-inpainting:"
        "95b7223104132402a9ae91cc677285bc5eb997834bd2349fa486f53910fd68b3"
    ),
}

DEFAULT_MODEL_KEY = "SDXL Inpainting (고품질, 권장)"


@dataclass
class InpaintingParams:
    """
    Replicate Inpainting API 호출 파라미터 묶음.

    Attributes
    ----------
    prompt : str
        영어 인테리어 스타일 프롬프트 (한국어 번역 후 전달).
    negative_prompt : str
        생성 시 배제할 요소 설명.
    num_inference_steps : int
        디노이징 스텝 수. 클수록 고품질이나 느려짐 (25~50 권장).
    guidance_scale : float
        프롬프트 충실도. 높을수록 프롬프트에 강하게 종속 (7~12 권장).
    strength : float
        인페인팅 강도. 1.0 이면 마스크 영역을 완전히 재생성.
    seed : int
        재현성을 위한 랜덤 시드. -1 이면 매번 다른 결과.
    lora_url : str
        HuggingFace 또는 Replicate 의 LoRA safetensors URL.
        비어 있으면 LoRA 없이 기본 모델만 사용.
    lora_scale : float
        LoRA 적용 강도 (0.0 ~ 1.0).
    """
    prompt: str
    negative_prompt: str = (
        "ugly, blurry, low quality, distorted, watermark, text, "
        "bad anatomy, worst quality, unrealistic"
    )
    num_inference_steps: int = 30
    guidance_scale: float = 8.0
    strength: float = 0.99
    seed: int = 42
    lora_url: str = ""
    lora_scale: float = 0.8


def run_inpainting(
    image: Image.Image,
    mask: Image.Image,
    params: InpaintingParams,
    model_key: str = DEFAULT_MODEL_KEY,
    api_token: Optional[str] = None,
) -> Image.Image:
    """
    Replicate API 로 Inpainting 을 실행하고 결과 이미지를 반환한다.

    Parameters
    ----------
    image : PIL.Image.Image
        원본 인테리어 이미지 (RGB, 1024px 이하 권장).
    mask : PIL.Image.Image
        흑백 마스크. 흰색(255) = 인페인팅 영역, 검정(0) = 보존.
    params : InpaintingParams
        API 호출 파라미터.
    model_key : str
        MODELS 딕셔너리의 키. 기본값: SDXL Inpainting.
    api_token : str | None
        Replicate API 토큰. None 이면 환경변수 REPLICATE_API_TOKEN 을 사용.

    Returns
    -------
    PIL.Image.Image
        인페인팅 결과 이미지 (RGB).

    Raises
    ------
    ValueError
        마스크에 인페인팅 영역(흰색)이 없을 때.
    RuntimeError
        API 호출 실패 또는 결과 이미지를 받지 못했을 때.
    """
    import numpy as np

    # 0. API 토큰 설정
    if api_token:
        os.environ["REPLICATE_API_TOKEN"] = api_token

    if not os.environ.get("REPLICATE_API_TOKEN"):
        raise RuntimeError(
            "REPLICATE_API_TOKEN 이 설정되지 않았습니다. "
            "사이드바에서 API 토큰을 입력하거나 환경변수로 설정하세요."
        )

    # 1. 마스크 유효성 검사 (전부 검정이면 변환할 영역 없음)
    mask_arr = np.array(mask)
    if mask_arr.max() == 0:
        raise ValueError(
            "마스크가 비어 있습니다. "
            "캔버스에서 변경할 영역을 브러쉬로 색칠해주세요."
        )

    # 2. 이미지/마스크를 bytes 로 직렬화 (Replicate 는 file-like 객체 허용)
    image_bytes = _pil_to_bytesio(image, fmt="PNG")
    mask_bytes = _pil_to_bytesio(mask, fmt="PNG")

    # 3. 모델 선택
    model_version = MODELS.get(model_key, MODELS[DEFAULT_MODEL_KEY])
    logger.info("Replicate 모델: %s", model_version)

    # 4. 입력 파라미터 구성
    api_input: dict = {
        "prompt": params.prompt,
        "negative_prompt": params.negative_prompt,
        "image": image_bytes,
        "mask": mask_bytes,
        "num_inference_steps": params.num_inference_steps,
        "guidance_scale": params.guidance_scale,
        "strength": params.strength,
        "seed": params.seed if params.seed >= 0 else None,
    }

    # LoRA URL 이 있으면 추가 (SDXL Inpainting 모델은 replicate_weights 파라미터 지원)
    if params.lora_url.strip():
        api_input["replicate_weights"] = params.lora_url.strip()
        api_input["lora_scale"] = params.lora_scale
        logger.info("LoRA 적용: url=%s, scale=%.2f", params.lora_url.strip(), params.lora_scale)

    # 5. API 호출
    logger.info(
        "Replicate API 호출 시작: prompt=%r, steps=%d, guidance=%.1f",
        params.prompt[:80],
        params.num_inference_steps,
        params.guidance_scale,
    )

    try:
        output = replicate.run(model_version, input=api_input)
    except replicate.exceptions.ReplicateError as exc:
        raise RuntimeError(f"Replicate API 오류: {exc}") from exc
    except Exception as exc:
        raise RuntimeError(f"API 호출 실패: {exc}") from exc

    # 6. 결과 파싱 (output 은 URL 리스트 또는 단일 URL)
    result_url = _extract_output_url(output)
    if not result_url:
        raise RuntimeError("API 가 결과 이미지 URL 을 반환하지 않았습니다.")

    logger.info("결과 이미지 URL: %s", result_url)

    # 7. 결과 이미지 다운로드
    result_image = _download_image(result_url)
    logger.info("결과 이미지 수신 완료: %dx%d", result_image.width, result_image.height)
    return result_image


# ──────────────────────────────────────────────
# 내부 헬퍼
# ──────────────────────────────────────────────

def _pil_to_bytesio(image: Image.Image, fmt: str = "PNG") -> io.BytesIO:
    """PIL 이미지를 BytesIO 스트림으로 변환."""
    buf = io.BytesIO()
    if fmt.upper() == "JPEG" and image.mode != "RGB":
        image = image.convert("RGB")
    image.save(buf, format=fmt)
    buf.seek(0)
    return buf


def _extract_output_url(output) -> Optional[str]:
    """
    Replicate 출력에서 이미지 URL 을 추출한다.
    출력 형식은 모델마다 다름:
      - 단일 URL 문자열
      - URL 문자열의 리스트
      - FileOutput 객체 (replicate >= 0.25)
    """
    if output is None:
        return None
    # FileOutput (replicate SDK >= 0.25)
    if hasattr(output, "url"):
        return str(output.url)
    if isinstance(output, str):
        return output
    if isinstance(output, (list, tuple)) and len(output) > 0:
        first = output[0]
        if hasattr(first, "url"):
            return str(first.url)
        if isinstance(first, str):
            return first
    return None


def _download_image(url: str) -> Image.Image:
    """URL 에서 이미지를 다운로드하여 PIL.Image 로 반환."""
    import urllib.request

    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read()
        return Image.open(io.BytesIO(data)).convert("RGB")
    except Exception as exc:
        raise RuntimeError(f"결과 이미지 다운로드 실패 ({url}): {exc}") from exc
