"""
Image processing utilities
 - Validate uploaded images (JPEG/PNG, max 20 MB)
 - Resize to max 2048 px on the longest side (aspect-ratio preserved)
 - Generate thumbnails (400 px shortest side)
"""

import io
from typing import Tuple

from PIL import Image, UnidentifiedImageError

from app.config import settings

ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


class ImageValidationError(ValueError):
    pass


def validate_image(data: bytes, content_type: str | None = None) -> None:
    """
    Raise ImageValidationError if the image fails any check:
      - Content-type not in allow-list
      - File size exceeds MAX_IMAGE_SIZE_MB
      - Cannot be decoded by Pillow (corrupt / unsupported format)
    """
    if len(data) > settings.max_image_bytes:
        raise ImageValidationError(
            f"파일 크기가 {settings.MAX_IMAGE_SIZE_MB}MB를 초과합니다."
        )

    if content_type and content_type.split(";")[0].strip() not in ALLOWED_CONTENT_TYPES:
        raise ImageValidationError(
            "지원하지 않는 파일 형식입니다. (JPEG, PNG, WEBP만 허용)"
        )

    try:
        img = Image.open(io.BytesIO(data))
        img.verify()  # checks for corruption without decoding pixels
    except (UnidentifiedImageError, Exception) as exc:
        raise ImageValidationError(f"유효하지 않은 이미지 파일입니다: {exc}") from exc


def resize_image(
    data: bytes,
    max_dimension: int | None = None,
    output_format: str = "JPEG",
    quality: int = 85,
) -> Tuple[bytes, Tuple[int, int]]:
    """
    Resize *data* so that the longest side is at most *max_dimension* pixels.
    Always converts to RGB (strips alpha for JPEG compatibility).

    Returns:
        (resized_bytes, (width, height))
    """
    max_dim = max_dimension or settings.MAX_IMAGE_DIMENSION
    img = Image.open(io.BytesIO(data)).convert("RGB")

    w, h = img.size
    if max(w, h) > max_dim:
        if w >= h:
            new_w = max_dim
            new_h = max(1, round(h * max_dim / w))
        else:
            new_h = max_dim
            new_w = max(1, round(w * max_dim / h))
        img = img.resize((new_w, new_h), Image.LANCZOS)
        w, h = img.size

    buf = io.BytesIO()
    img.save(buf, format=output_format, quality=quality, optimize=True)
    return buf.getvalue(), (w, h)


def make_thumbnail(
    data: bytes,
    size: int | None = None,
    output_format: str = "JPEG",
    quality: int = 80,
) -> bytes:
    """
    Create a square-cropped thumbnail (centre crop) of *size* px.
    """
    thumb_size = size or settings.THUMBNAIL_SIZE
    img = Image.open(io.BytesIO(data)).convert("RGB")

    # Centre-crop to square, then resize
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    img = img.crop((left, top, left + side, top + side))
    img = img.resize((thumb_size, thumb_size), Image.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format=output_format, quality=quality, optimize=True)
    return buf.getvalue()


def get_image_dimensions(data: bytes) -> Tuple[int, int]:
    """Return (width, height) without full decode."""
    with Image.open(io.BytesIO(data)) as img:
        return img.size
