"""
image_utils.py
──────────────
이미지 전처리 유틸리티 모듈.

주요 기능:
  - 업로드된 이미지를 API 전송 가능한 크기로 안전하게 리사이즈
  - streamlit-drawable-canvas 의 RGBA 마스크 데이터를 흑백 이진 마스크로 변환
  - PIL.Image ↔ bytes 변환 (API 전송용 in-memory buffer)
  - IP-Adapter 결과 이미지와 원본을 마스크로 합성 (composite_with_mask)

확장 포인트 (360도 파노라마 페이즈):
  - 이 모듈에 큐브맵 변환 함수를 추가하면 기존 로직과 분리하여 재사용 가능.
"""

from __future__ import annotations

import io
import logging
from typing import Tuple

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

# Replicate API 가 안정적으로 처리할 수 있는 최대 해상도
# SDXL 계열은 1024×1024 권장, SD 1.5 계열은 512×512
MAX_SIDE = 1024


def resize_to_fit(image: Image.Image, max_side: int = MAX_SIDE) -> Image.Image:
    """
    이미지의 긴 쪽이 max_side 를 초과하면 비율을 유지하며 축소한다.
    이미 max_side 이하이면 그대로 반환.

    Replicate SDXL Inpainting 은 64 의 배수 해상도를 요구하므로
    최종 크기를 64 의 배수로 반올림한다.

    Parameters
    ----------
    image : PIL.Image.Image
        원본 이미지.
    max_side : int
        최대 허용 픽셀 수 (긴 쪽 기준). 기본값 1024.

    Returns
    -------
    PIL.Image.Image
        리사이즈된 이미지 (mode 는 원본과 동일).
    """
    w, h = image.size
    if max(w, h) <= max_side:
        # 64 배수 정렬만 수행
        new_w = _round64(w)
        new_h = _round64(h)
        if new_w == w and new_h == h:
            return image
        logger.debug("64 배수 정렬: %dx%d → %dx%d", w, h, new_w, new_h)
        return image.resize((new_w, new_h), Image.LANCZOS)

    scale = max_side / max(w, h)
    new_w = _round64(int(w * scale))
    new_h = _round64(int(h * scale))
    logger.info("이미지 리사이즈: %dx%d → %dx%d (scale=%.3f)", w, h, new_w, new_h, scale)
    return image.resize((new_w, new_h), Image.LANCZOS)


def _round64(n: int) -> int:
    """64의 배수로 반올림 (최소 64 보장)."""
    return max(64, round(n / 64) * 64)


def canvas_to_mask(
    canvas_data: np.ndarray,
    threshold: int = 10,
) -> Image.Image:
    """
    streamlit-drawable-canvas 가 반환하는 RGBA numpy 배열을
    흑백 이진 마스크(PIL.Image, mode='L')로 변환한다.

    마스크 규약: 흰색(255) = 인페인팅할 영역, 검정(0) = 보존할 영역.

    Parameters
    ----------
    canvas_data : np.ndarray
        shape (H, W, 4), dtype uint8. canvas.image_data 값.
    threshold : int
        RGB 채널 합산 값이 이 값 이상이면 마스크 영역으로 판정.
        배경이 검정(0,0,0)인 캔버스에서 사용자가 그린 획을 감지.

    Returns
    -------
    PIL.Image.Image
        mode='L' 흑백 마스크.
    """
    if canvas_data is None:
        raise ValueError("캔버스 데이터가 없습니다. 마스크를 먼저 그려주세요.")

    # RGBA → RGB 합산으로 사용자가 그린 픽셀 감지
    rgb_sum = canvas_data[:, :, :3].sum(axis=2).astype(np.uint32)
    mask_array = np.where(rgb_sum >= threshold, 255, 0).astype(np.uint8)

    logger.debug(
        "마스크 변환 완료: 전체 픽셀=%d, 마스크 픽셀=%d (%.1f%%)",
        mask_array.size,
        int((mask_array > 0).sum()),
        float((mask_array > 0).mean() * 100),
    )
    return Image.fromarray(mask_array, mode="L")


def pil_to_bytes(image: Image.Image, fmt: str = "PNG") -> bytes:
    """
    PIL 이미지를 bytes 로 직렬화한다 (API 전송용 in-memory buffer).

    Parameters
    ----------
    image : PIL.Image.Image
        변환할 이미지.
    fmt : str
        저장 포맷. "PNG" 또는 "JPEG".

    Returns
    -------
    bytes
        인코딩된 이미지 바이트.
    """
    buf = io.BytesIO()
    save_kwargs: dict = {}
    if fmt.upper() == "JPEG":
        save_kwargs["quality"] = 95
        if image.mode != "RGB":
            image = image.convert("RGB")
    image.save(buf, format=fmt, **save_kwargs)
    return buf.getvalue()


def load_uploaded_image(uploaded_file) -> Image.Image:
    """
    Streamlit UploadedFile 객체를 PIL.Image 로 읽어 RGB 로 변환한다.

    Parameters
    ----------
    uploaded_file : streamlit.runtime.uploaded_file_manager.UploadedFile

    Returns
    -------
    PIL.Image.Image
        RGB 모드 이미지.
    """
    image = Image.open(uploaded_file).convert("RGB")
    logger.info(
        "이미지 로드 완료: 파일명=%s, 크기=%dx%d",
        getattr(uploaded_file, "name", "unknown"),
        image.width,
        image.height,
    )
    return image


def composite_with_mask(
    original: Image.Image,
    styled: Image.Image,
    mask: Image.Image,
    feather_radius: int = 12,
) -> Image.Image:
    """
    IP-Adapter 가 생성한 스타일 이미지를 마스크 영역에만 합성한다.

    IP-Adapter 는 mask 를 직접 지원하지 않으므로, 이 함수로 인페인팅 효과를
    소프트웨어적으로 구현한다.

    합성 규칙:
      - 흰색(255) 영역 → styled 이미지 픽셀 사용
      - 검정(0) 영역   → original 이미지 픽셀 유지
      - 경계 영역       → feather_radius 만큼 Gaussian blur 를 적용하여
                          두 이미지를 부드럽게 블렌딩 (어색한 경계선 제거)

    Parameters
    ----------
    original : PIL.Image.Image
        원본 인테리어 이미지.
    styled : PIL.Image.Image
        IP-Adapter 로 스타일이 적용된 전체 이미지.
    mask : PIL.Image.Image
        mode='L' 흑백 마스크 (흰색=교체, 검정=보존).
    feather_radius : int
        경계 블러 반경(픽셀). 클수록 부드럽지만 세부 경계가 흐려짐.
        인테리어 이미지 기준 8~16 이 적절.

    Returns
    -------
    PIL.Image.Image
        합성된 RGB 이미지.
    """
    from PIL import ImageFilter

    # 크기를 original 기준으로 통일
    target_size = original.size
    styled_fit  = styled.resize(target_size, Image.LANCZOS)
    mask_fit    = mask.resize(target_size, Image.LANCZOS).convert("L")

    # 마스크 경계를 Gaussian blur 로 페더링 → 자연스러운 블렌딩
    if feather_radius > 0:
        mask_feathered = mask_fit.filter(
            ImageFilter.GaussianBlur(radius=feather_radius)
        )
    else:
        mask_feathered = mask_fit

    # PIL.Image.composite:
    #   result[x,y] = styled[x,y]   if mask[x,y]=255 (white)
    #               = original[x,y] if mask[x,y]=0   (black)
    #   중간값이면 선형 보간 (alpha blend)
    result = Image.composite(styled_fit, original.convert("RGB"), mask_feathered)

    logger.debug(
        "마스크 합성 완료: original=%dx%d, styled=%dx%d, feather=%d",
        original.width, original.height,
        styled_fit.width, styled_fit.height,
        feather_radius,
    )
    return result.convert("RGB")


def make_before_after(
    original: Image.Image,
    result: Image.Image,
    gap: int = 20,
) -> Image.Image:
    """
    원본과 결과 이미지를 좌우로 나란히 붙인 Before/After 비교 이미지를 생성한다.

    두 이미지의 높이가 다를 경우 원본 높이로 맞춘다.

    Parameters
    ----------
    original : PIL.Image.Image
    result : PIL.Image.Image
    gap : int
        두 이미지 사이의 여백(픽셀).

    Returns
    -------
    PIL.Image.Image
        합성된 Before/After 이미지.
    """
    orig_w, orig_h = original.size
    result_resized = result.resize((orig_w, orig_h), Image.LANCZOS)

    combined_w = orig_w * 2 + gap
    combined = Image.new("RGB", (combined_w, orig_h), color=(240, 240, 240))
    combined.paste(original, (0, 0))
    combined.paste(result_resized, (orig_w + gap, 0))
    return combined
