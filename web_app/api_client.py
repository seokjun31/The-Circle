"""
api_client.py
─────────────
Replicate API 통신 모듈.

스타일 모드 (StyleMode) 자동 감지 → 3가지 처리 경로:
┌─────────────────────┬──────────────────────────────────────────────────────┐
│ 모드                │ 처리 경로                                            │
├─────────────────────┼──────────────────────────────────────────────────────┤
│ TEXT_ONLY           │ SDXL Inpainting (텍스트 기반 마스크 인페인팅)         │
│ REFERENCE_ONLY      │ IP-Adapter SDXL → 마스크 합성                        │
│ COMBINED            │ IP-Adapter SDXL (텍스트 + 이미지 동시 조건화)         │
│                     │ → 마스크 합성                                         │
└─────────────────────┴──────────────────────────────────────────────────────┘

IP-Adapter 방식 설명:
  1. 레퍼런스 이미지를 IP-Adapter 모델에 넣으면 그 이미지의 색감/재질/톤을
     학습해 전체 이미지를 재스타일링한다.
  2. 원본 인테리어 사진 위에 마스크 합성(composite_with_mask)으로
     마스킹된 영역에만 스타일을 씌운다 → 인페인팅 효과 구현.

확장 포인트 (360도 파노라마 페이즈):
  run_inpainting() 은 단일 이미지 처리용이므로 큐브맵 6면 순차 호출 루프에서
  그대로 재사용할 수 있다.
"""

from __future__ import annotations

import io
import logging
import os
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Optional

import replicate  # type: ignore
from PIL import Image

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────
# 모델 목록
# ──────────────────────────────────────────────

# ControlNet + LoRA 스타일 변환 모델
# 출처: https://replicate.com/pnyompen/sdxl-controlnet-lora-small
# ※ 마스크를 직접 지원하지 않으므로 결과 이미지를 마스크로 합성(composite)하여 인페인팅 효과 구현
CONTROLNET_LORA_MODEL = (
    "pnyompen/sdxl-controlnet-lora-small:"
    "d4cdee63b0fd50ec2fbff69e7b20bfca8dc556ee737a957ad8c0166f34359727"
)

# IP-Adapter 기반 스타일 참조 모델 (레퍼런스 이미지 조건화)
# 출처: https://replicate.com/lucataco/ip-adapter-sdxl
# ※ 최신 버전 해시는 replicate.com 에서 직접 확인하세요.
IP_ADAPTER_MODEL = (
    "lucataco/ip-adapter-sdxl:"
    "c1dcd7ea3f8aa9db5a924f4490736f59b31cd57a8ec51f7f0a1dbe8c8e1c9e5f"
)

# UI 노출용 통합 목록 (사이드바 selectbox)
MODELS = {
    "SDXL ControlNet + LoRA (권장)": CONTROLNET_LORA_MODEL,
}

DEFAULT_MODEL_KEY = "SDXL ControlNet + LoRA (권장)"


# ──────────────────────────────────────────────
# 스타일 모드 열거형
# ──────────────────────────────────────────────

class StyleMode(Enum):
    """사용자가 제공한 입력 조합에 따른 처리 경로."""
    TEXT_ONLY       = auto()  # 텍스트 프롬프트만
    REFERENCE_ONLY  = auto()  # 레퍼런스 이미지만
    COMBINED        = auto()  # 텍스트 + 레퍼런스 이미지 동시


# ──────────────────────────────────────────────
# 파라미터 데이터클래스
# ──────────────────────────────────────────────

@dataclass
class InpaintingParams:
    """
    Replicate API 호출 파라미터 묶음.

    Attributes
    ----------
    prompt : str
        영어 인테리어 스타일 프롬프트 (한국어 번역 후 전달).
    negative_prompt : str
        생성 시 배제할 요소.
    num_inference_steps : int
        디노이징 스텝 수 (25~50 권장).
    guidance_scale : float
        프롬프트 충실도 (7~12 권장).
    strength : float
        인페인팅 강도. 1.0 이면 마스크 영역 완전 재생성.
    seed : int
        랜덤 시드. -1 이면 매번 다른 결과.
    lora_url : str
        LoRA safetensors HuggingFace/Replicate URL (옵션).
    lora_scale : float
        LoRA 적용 강도.
    reference_image : PIL.Image.Image | None
        스타일 참고 이미지. IP-Adapter 모드 활성화 여부를 결정.
    ip_adapter_scale : float
        IP-Adapter 이미지 조건화 강도 (0=텍스트 완전 무시, 1=이미지 완전 추종).
        0.4~0.7 이 인테리어에서 균형 잡힌 결과를 줌.
    """
    prompt: str
    negative_prompt: str = (
        "ugly, blurry, low quality, distorted, watermark, text, "
        "bad anatomy, worst quality, unrealistic"
    )
    num_inference_steps: int = 40
    guidance_scale: float = 8.0
    strength: float = 0.99
    seed: int = 42
    lora_url: str = ""
    lora_scale: float = 0.8
    condition_scale: float = 0.5
    reference_image: Optional[Image.Image] = None
    ip_adapter_scale: float = 0.6


# ──────────────────────────────────────────────
# 스타일 모드 감지
# ──────────────────────────────────────────────

def detect_style_mode(params: InpaintingParams) -> StyleMode:
    """
    params 의 prompt 와 reference_image 유무를 보고 StyleMode 를 반환한다.

    Examples
    --------
    >>> detect_style_mode(InpaintingParams(prompt="white wall"))
    StyleMode.TEXT_ONLY
    >>> detect_style_mode(InpaintingParams(prompt="", reference_image=img))
    StyleMode.REFERENCE_ONLY
    >>> detect_style_mode(InpaintingParams(prompt="white wall", reference_image=img))
    StyleMode.COMBINED
    """
    has_text = bool(params.prompt.strip())
    has_ref  = params.reference_image is not None

    if has_text and has_ref:
        return StyleMode.COMBINED
    if has_ref:
        return StyleMode.REFERENCE_ONLY
    return StyleMode.TEXT_ONLY


# ──────────────────────────────────────────────
# 메인 퍼블릭 API
# ──────────────────────────────────────────────

def run_inpainting(
    image: Image.Image,
    mask: Image.Image,
    params: InpaintingParams,
    model_key: str = DEFAULT_MODEL_KEY,
    api_token: Optional[str] = None,
) -> tuple[Image.Image, StyleMode]:
    """
    스타일 모드를 자동 감지하여 적절한 Replicate API 경로로 라우팅한다.

    Parameters
    ----------
    image : PIL.Image.Image
        원본 인테리어 이미지 (RGB, 1024px 이하 권장).
    mask : PIL.Image.Image
        흑백 마스크. 흰색(255) = 인페인팅 영역.
    params : InpaintingParams
    model_key : str
        INPAINTING_MODELS 딕셔너리 키 (TEXT_ONLY 모드에만 사용됨).
    api_token : str | None

    Returns
    -------
    result_image : PIL.Image.Image
    mode : StyleMode
        실제 사용된 처리 모드 (UI 표시용).

    Raises
    ------
    ValueError  마스크 또는 입력이 유효하지 않을 때.
    RuntimeError  API 호출 실패 시.
    """
    import numpy as np

    # 0. API 토큰 설정
    if api_token:
        os.environ["REPLICATE_API_TOKEN"] = api_token
    if not os.environ.get("REPLICATE_API_TOKEN"):
        raise RuntimeError(
            "REPLICATE_API_TOKEN 이 설정되지 않았습니다. "
            "사이드바에서 토큰을 입력하거나 환경변수로 설정하세요."
        )

    # 1. 마스크 유효성 검사
    mask_arr = np.array(mask)
    if mask_arr.max() == 0:
        raise ValueError(
            "마스크가 비어 있습니다. "
            "캔버스에서 변경할 영역을 브러쉬로 색칠해주세요."
        )

    # 2. 스타일 모드 결정 → 경로 분기
    mode = detect_style_mode(params)
    logger.info("스타일 모드 결정: %s", mode.name)

    if mode == StyleMode.TEXT_ONLY:
        result = _run_text_inpainting(image, mask, params, model_key)
    else:
        # REFERENCE_ONLY or COMBINED → IP-Adapter 경로
        result = _run_ip_adapter_inpainting(image, mask, params)

    return result, mode


# ──────────────────────────────────────────────
# 내부: 텍스트 전용 인페인팅 (기존 로직)
# ──────────────────────────────────────────────

def _run_text_inpainting(
    image: Image.Image,
    mask: Image.Image,
    params: InpaintingParams,
    model_key: str,
) -> Image.Image:
    """
    SDXL ControlNet + LoRA 모델로 스타일 이미지 생성 후 마스크로 합성.

    처리 흐름:
      1. ControlNet + LoRA 모델 → 프롬프트/LoRA 기반 전체 이미지 생성
      2. composite_with_mask() → 마스킹 영역에만 생성 결과를 합성
    """
    from image_utils import composite_with_mask

    logger.info("[TEXT_ONLY] 모델: %s", CONTROLNET_LORA_MODEL)

    api_input: dict = {
        "image":                _pil_to_bytesio(image),
        "prompt":               params.prompt,
        "condition_scale":      params.condition_scale,
        "num_inference_steps":  params.num_inference_steps,
    }

    if params.lora_url.strip():
        api_input["lora_weights"] = params.lora_url.strip()
        logger.info("LoRA 적용: url=%s", params.lora_url)

    logger.info(
        "[TEXT_ONLY] API 호출: prompt=%r, condition_scale=%.2f, steps=%d",
        params.prompt[:80], params.condition_scale, params.num_inference_steps,
    )

    styled_full = _call_replicate_and_download(CONTROLNET_LORA_MODEL, api_input)
    logger.info("[TEXT_ONLY] 스타일 이미지 생성 완료: %dx%d", styled_full.width, styled_full.height)

    result = composite_with_mask(
        original=image,
        styled=styled_full,
        mask=mask,
        feather_radius=12,
    )
    logger.info("[TEXT_ONLY] 마스크 합성 완료")
    return result


# ──────────────────────────────────────────────
# 내부: IP-Adapter 인페인팅 (레퍼런스 이미지 경로)
# ──────────────────────────────────────────────

def _run_ip_adapter_inpainting(
    image: Image.Image,
    mask: Image.Image,
    params: InpaintingParams,
) -> Image.Image:
    """
    IP-Adapter SDXL 로 레퍼런스 이미지 스타일을 학습한 뒤,
    PIL 마스크 합성으로 해당 스타일을 마스킹 영역에만 적용한다.

    처리 흐름:
      1. IP-Adapter SDXL API → 레퍼런스 스타일이 반영된 전체 이미지 생성
      2. composite_with_mask() → 원본 위에 생성된 이미지를 마스크로 합성
         (경계는 Gaussian blur 로 부드럽게 블렌딩)
    """
    from image_utils import composite_with_mask

    assert params.reference_image is not None, "reference_image 가 None 입니다."

    # ── Step 1: IP-Adapter로 스타일 이미지 생성 ─────────────────────
    # REFERENCE_ONLY 모드: 프롬프트를 인테리어 기본값으로 대체
    effective_prompt = params.prompt.strip() or (
        "interior design, high quality photography, realistic lighting"
    )

    api_input: dict = {
        "image":                _pil_to_bytesio(params.reference_image),
        "prompt":               effective_prompt,
        "negative_prompt":      params.negative_prompt,
        "num_inference_steps":  params.num_inference_steps,
        "guidance_scale":       params.guidance_scale,
        "ip_adapter_scale":     params.ip_adapter_scale,
        "width":                image.width,
        "height":               image.height,
        "seed":                 params.seed if params.seed >= 0 else None,
    }

    logger.info(
        "[IP-ADAPTER] API 호출: prompt=%r, ip_scale=%.2f, ref_size=%dx%d",
        effective_prompt[:80],
        params.ip_adapter_scale,
        params.reference_image.width,
        params.reference_image.height,
    )

    styled_full = _call_replicate_and_download(IP_ADAPTER_MODEL, api_input)
    logger.info(
        "[IP-ADAPTER] 스타일 이미지 생성 완료: %dx%d",
        styled_full.width, styled_full.height,
    )

    # ── Step 2: 마스크 합성 → 인페인팅 효과 ────────────────────────
    result = composite_with_mask(
        original=image,
        styled=styled_full,
        mask=mask,
        feather_radius=12,
    )
    logger.info("[IP-ADAPTER] 마스크 합성 완료")
    return result


# ──────────────────────────────────────────────
# 내부 헬퍼
# ──────────────────────────────────────────────

def _call_replicate_and_download(model_version: str, api_input: dict) -> Image.Image:
    """Replicate API 호출 → URL 파싱 → 이미지 다운로드."""
    try:
        output = replicate.run(model_version, input=api_input)
    except replicate.exceptions.ReplicateError as exc:
        raise RuntimeError(f"Replicate API 오류: {exc}") from exc
    except Exception as exc:
        raise RuntimeError(f"API 호출 실패: {exc}") from exc

    result_url = _extract_output_url(output)
    if not result_url:
        raise RuntimeError("API 가 결과 이미지 URL 을 반환하지 않았습니다.")

    logger.info("결과 URL: %s", result_url)
    return _download_image(result_url)


def _pil_to_bytesio(image: Image.Image, fmt: str = "PNG") -> io.BytesIO:
    """PIL 이미지를 seek(0) 된 BytesIO 스트림으로 변환."""
    buf = io.BytesIO()
    if fmt.upper() == "JPEG" and image.mode != "RGB":
        image = image.convert("RGB")
    image.save(buf, format=fmt)
    buf.seek(0)
    return buf


def _extract_output_url(output) -> Optional[str]:
    """
    Replicate 출력 형식(단일 URL / URL 리스트 / FileOutput 객체)을
    통일하여 URL 문자열을 반환한다.
    """
    if output is None:
        return None
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
    """URL 에서 이미지를 다운로드하여 PIL.Image (RGB)로 반환."""
    import urllib.request

    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read()
        return Image.open(io.BytesIO(data)).convert("RGB")
    except Exception as exc:
        raise RuntimeError(f"결과 이미지 다운로드 실패 ({url}): {exc}") from exc
