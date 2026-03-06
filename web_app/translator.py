"""
translator.py
─────────────
한국어(또는 기타 언어) → 영어 자동 번역 모듈.

사용 라이브러리: deep-translator (무료, PyPI)
  pip install deep-translator

동작 방식:
  1. 입력 텍스트가 ASCII 문자만 포함하면 이미 영어로 판단하여 그대로 반환.
  2. 그 외 문자(한글 등)가 포함되면 Google Translate 를 통해 영어로 변환.
  3. 번역 실패 시(네트워크 오류 등) 원문을 그대로 반환하고 경고를 로그에 남긴다.

확장 포인트 (다음 페이즈):
  - 다른 번역 엔진(DeepL, LibreTranslate)으로 교체 시 이 모듈만 수정하면 됨.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def _is_english_only(text: str) -> bool:
    """ASCII 문자(영문자·숫자·기호)만으로 이루어진 문자열인지 확인."""
    try:
        text.encode("ascii")
        return True
    except UnicodeEncodeError:
        return False


def translate_to_english(text: str) -> str:
    """
    입력 텍스트를 영어로 번역하여 반환한다.

    Parameters
    ----------
    text : str
        번역할 원본 텍스트 (한국어 등).

    Returns
    -------
    str
        영어로 번역된 텍스트.
        번역 실패 시 원문 반환.

    Examples
    --------
    >>> translate_to_english("화이트 실크 벽지, 모던 스타일")
    'White silk wallpaper, modern style'
    >>> translate_to_english("white marble floor")
    'white marble floor'  # 이미 영어 → 번역 없이 그대로 반환
    """
    text = text.strip()
    if not text:
        return text

    # 이미 영어(ASCII)인 경우 번역 불필요
    if _is_english_only(text):
        logger.debug("번역 생략 (이미 영어): %r", text)
        return text

    try:
        from deep_translator import GoogleTranslator  # type: ignore

        translated: str = GoogleTranslator(source="auto", target="en").translate(text)
        logger.info("번역 완료: %r → %r", text, translated)
        return translated

    except ImportError:
        logger.warning(
            "deep-translator 가 설치되지 않았습니다. "
            "pip install deep-translator 를 실행한 뒤 재시작하세요. "
            "원문을 그대로 사용합니다."
        )
        return text

    except Exception as exc:
        logger.warning("번역 오류 (%s). 원문을 그대로 사용합니다.", exc)
        return text
