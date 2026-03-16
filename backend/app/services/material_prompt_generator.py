"""
MaterialPromptGenerator
=======================
자재 이미지를 Claude Vision API에 전송하여 ComfyUI IP-Adapter 워크플로우에
최적화된 프롬프트 파라미터를 자동 생성합니다.

사용 예::

    generator = MaterialPromptGenerator()
    result = await generator.generate_prompts(
        image_url = "https://…/oak_floor.jpg",
        category  = "flooring",
        name      = "오크 원목 마루",
    )
    # {
    #   "positive_prompt":     "seamless oak hardwood flooring, ...",
    #   "negative_prompt":     "tile, carpet, glossy, ...",
    #   "ip_adapter_weight":   0.60,
    #   "recommended_denoise": 0.62,
    # }
"""

from __future__ import annotations

import base64
import json
import logging
import re
from typing import Optional

import httpx

logger = logging.getLogger("the_circle.material_prompt_generator")

# ── 모델 상수 ──────────────────────────────────────────────────────────────────
_MODEL = "claude-sonnet-4-20250514"   # 사용자 지정 모델

# ── 시스템 프롬프트 ────────────────────────────────────────────────────────────
_SYSTEM_PROMPT = """\
너는 인테리어 자재를 Stable Diffusion XL 프롬프트로 변환하는 전문가야.
주어진 자재 이미지를 분석하고 아래 JSON 형식으로 응답해.

- positive_prompt: 이 자재가 실제 방 바닥/벽에 시공된 모습을 묘사하는 SDXL 프롬프트.
  반드시 포함할 것: 자재의 색상, 질감, 패턴, 마감(matte/glossy), 시공 방식.
  항상 끝에 'photorealistic interior, professional photography, 8k uhd' 추가.

- negative_prompt: 이 자재와 반대되는 요소들.
  항상 포함: 'blurry, low quality, distorted, cartoon, painting, illustration'

- ip_adapter_weight: 0.3~0.9 범위. 패턴이 강할수록 높게.
  기준:
    단색/무지(페인트, 무광 타일): 0.40~0.55
    일반 패턴(나무결, 석재): 0.50~0.65
    복잡한 패턴(모자이크, 헤링본, 대리석 결): 0.60~0.75

- recommended_denoise: 0.5~0.75 범위.
  기준:
    원본과 비슷한 톤 유지: 0.50~0.58
    원본과 다른 톤/색상: 0.60~0.68
    대폭 변경(밝은 원본 → 어두운 자재 등): 0.65~0.75

JSON만 응답하고 다른 텍스트는 출력하지 마.
응답 형식:
{
  "positive_prompt": "...",
  "negative_prompt": "...",
  "ip_adapter_weight": 0.60,
  "recommended_denoise": 0.62
}\
"""

# ── 카테고리별 폴백 기본값 ─────────────────────────────────────────────────────
# Claude API 호출 실패 시 합리적인 기본값을 반환합니다.
_FALLBACK: dict[str, dict] = {
    "wallpaper": {
        "positive_prompt": (
            "seamless wallpaper pattern on wall surface, fabric-textured finish, "
            "soft matte appearance, elegant repeat pattern, professionally installed, "
            "photorealistic interior, professional photography, 8k uhd"
        ),
        "negative_prompt": (
            "floor, ceiling, tile, wood grain, stone, glossy, wet, cracked, peeling, "
            "blurry, low quality, distorted, cartoon, painting, illustration"
        ),
        "ip_adapter_weight": 0.55,
        "recommended_denoise": 0.60,
    },
    "flooring": {
        "positive_prompt": (
            "seamless flooring material covering the floor surface, "
            "clean grout lines, uniform finish, professionally installed, "
            "consistent lighting, photorealistic interior, professional photography, 8k uhd"
        ),
        "negative_prompt": (
            "wall, ceiling, wallpaper, paint, glossy reflective surface, wet, cracked, "
            "dirty, blurry, low quality, distorted, cartoon, painting, illustration"
        ),
        "ip_adapter_weight": 0.60,
        "recommended_denoise": 0.62,
    },
    "ceiling": {
        "positive_prompt": (
            "seamless ceiling material, smooth flat surface, uniform matte finish, "
            "professionally installed, architectural ceiling, "
            "photorealistic interior, professional photography, 8k uhd"
        ),
        "negative_prompt": (
            "floor, wall, tile pattern, wood grain, glossy, reflective, wet, cracked, "
            "blurry, low quality, distorted, cartoon, painting, illustration"
        ),
        "ip_adapter_weight": 0.50,
        "recommended_denoise": 0.58,
    },
    "tile": {
        "positive_prompt": (
            "seamless tile pattern on surface, clean grout lines, uniform tile layout, "
            "precise installation, consistent color and texture, "
            "photorealistic interior, professional photography, 8k uhd"
        ),
        "negative_prompt": (
            "wood grain, carpet, wallpaper, paint, cracked grout, dirty, stained, "
            "blurry, low quality, distorted, cartoon, painting, illustration"
        ),
        "ip_adapter_weight": 0.65,
        "recommended_denoise": 0.63,
    },
    "paint": {
        "positive_prompt": (
            "smooth painted wall surface, flat matte finish, uniform color coverage, "
            "professional interior painting, clean crisp edges, "
            "photorealistic interior, professional photography, 8k uhd"
        ),
        "negative_prompt": (
            "tile pattern, wood grain, wallpaper, texture, brushstroke visible, "
            "glossy, reflective, dirty, peeling, cracked, streaks, "
            "blurry, low quality, distorted, cartoon, painting, illustration"
        ),
        "ip_adapter_weight": 0.45,
        "recommended_denoise": 0.55,
    },
}

# 알 수 없는 카테고리의 범용 폴백
_FALLBACK_DEFAULT: dict = {
    "positive_prompt": (
        "seamless material texture on interior surface, professionally installed, "
        "consistent lighting, photorealistic interior, professional photography, 8k uhd"
    ),
    "negative_prompt": (
        "blurry, low quality, distorted, cartoon, painting, illustration, "
        "dirty, cracked, stained, unrealistic"
    ),
    "ip_adapter_weight": 0.60,
    "recommended_denoise": 0.62,
}

# ── 응답 파싱 헬퍼 ─────────────────────────────────────────────────────────────

def _parse_json_response(text: str) -> Optional[dict]:
    """
    Claude 응답에서 JSON 딕셔너리를 추출합니다.
    코드 블록(```json ... ```) 래핑도 처리합니다.
    """
    text = text.strip()

    # 코드 블록 제거
    code_block = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", text)
    if code_block:
        text = code_block.group(1).strip()

    try:
        data = json.loads(text)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass

    # 중괄호 단위로 재시도
    brace_match = re.search(r"\{[\s\S]+\}", text)
    if brace_match:
        try:
            data = json.loads(brace_match.group(0))
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass

    return None


def _validate_and_clamp(data: dict, category: str) -> dict:
    """
    Claude 응답 딕셔너리의 필드를 검증하고 범위를 보정합니다.
    누락된 필드는 해당 카테고리의 폴백값으로 채웁니다.
    """
    fallback = _FALLBACK.get(category, _FALLBACK_DEFAULT)
    result: dict = {}

    # positive_prompt
    pp = data.get("positive_prompt", "")
    result["positive_prompt"] = str(pp).strip() if pp else fallback["positive_prompt"]

    # negative_prompt
    np_ = data.get("negative_prompt", "")
    result["negative_prompt"] = str(np_).strip() if np_ else fallback["negative_prompt"]

    # ip_adapter_weight (0.3 ~ 0.9)
    try:
        w = float(data.get("ip_adapter_weight", fallback["ip_adapter_weight"]))
        result["ip_adapter_weight"] = round(max(0.3, min(0.9, w)), 2)
    except (TypeError, ValueError):
        result["ip_adapter_weight"] = fallback["ip_adapter_weight"]

    # recommended_denoise (0.5 ~ 0.75)
    try:
        d = float(data.get("recommended_denoise", fallback["recommended_denoise"]))
        result["recommended_denoise"] = round(max(0.5, min(0.75, d)), 2)
    except (TypeError, ValueError):
        result["recommended_denoise"] = fallback["recommended_denoise"]

    return result


# ══════════════════════════════════════════════════════════════════════════════
#  MaterialPromptGenerator
# ══════════════════════════════════════════════════════════════════════════════

class MaterialPromptGenerator:
    """
    Claude Vision API를 활용하여 자재 이미지를 분석하고
    ComfyUI 워크플로우에 최적화된 프롬프트 파라미터를 자동 생성합니다.

    API 키가 설정되지 않았거나 요청이 실패하면
    카테고리별 기본값(폴백)을 반환합니다.
    """

    def __init__(self, api_key: Optional[str] = None) -> None:
        self._api_key = api_key
        self._client  = None          # 지연 초기화 — import 시 키 없어도 로드 가능

    def _get_client(self):
        """AsyncAnthropic 클라이언트 지연 초기화."""
        if self._client is None:
            try:
                import anthropic
                key = self._api_key or _get_api_key()
                self._client = anthropic.AsyncAnthropic(api_key=key)
            except ImportError as exc:
                raise RuntimeError(
                    "anthropic 패키지가 설치되지 않았습니다. "
                    "'pip install anthropic>=0.49.0' 를 실행하세요."
                ) from exc
        return self._client

    # ── 퍼블릭 API ────────────────────────────────────────────────────────────

    async def generate_prompts(
        self,
        image_url: str,
        category: str,
        name: str,
    ) -> dict:
        """
        자재 이미지를 분석하여 ComfyUI 프롬프트 파라미터를 반환합니다.

        Args:
            image_url: 자재 타일 이미지 URL (HTTP/S 또는 data-URL).
            category:  자재 카테고리 (wallpaper/flooring/ceiling/tile/paint).
            name:      자재명 (한국어/영어 모두 가능).

        Returns:
            dict with keys:
                positive_prompt     (str)
                negative_prompt     (str)
                ip_adapter_weight   (float, 0.3–0.9)
                recommended_denoise (float, 0.5–0.75)

        Notes:
            - ANTHROPIC_API_KEY가 설정되지 않았으면 폴백을 즉시 반환합니다.
            - Claude API 오류 시에도 폴백을 반환합니다 (서비스 중단 없음).
        """
        # API 키 없음 → 즉시 폴백
        api_key = self._api_key or _get_api_key()
        if not api_key:
            logger.warning(
                "ANTHROPIC_API_KEY가 설정되지 않았습니다. "
                "카테고리 기본 프롬프트를 반환합니다. (material=%r, category=%r)",
                name, category,
            )
            return _FALLBACK.get(category, _FALLBACK_DEFAULT).copy()

        try:
            return await self._call_claude(image_url, category, name)
        except Exception as exc:
            logger.warning(
                "Claude API 호출 실패 — 폴백 반환 (material=%r, category=%r): %s",
                name, category, exc,
            )
            return _FALLBACK.get(category, _FALLBACK_DEFAULT).copy()

    # ── 내부 구현 ─────────────────────────────────────────────────────────────

    async def _call_claude(
        self,
        image_url: str,
        category: str,
        name: str,
    ) -> dict:
        """
        Claude Vision API 호출 → JSON 파싱 → 검증된 파라미터 반환.

        Raises:
            Exception: 네트워크 오류, API 오류, JSON 파싱 실패 시.
                       호출자(generate_prompts)가 캐치하여 폴백으로 대체합니다.
        """
        # ── 1. 이미지를 base64로 인코딩 ────────────────────────────────────────
        img_b64, media_type = await self._fetch_image_as_base64(image_url)

        # ── 2. Claude API 호출 ──────────────────────────────────────────────────
        client = self._get_client()
        response = await client.messages.create(
            model      = _MODEL,
            max_tokens = 1024,
            system     = _SYSTEM_PROMPT,
            messages   = [
                {
                    "role":    "user",
                    "content": [
                        {
                            "type":   "image",
                            "source": {
                                "type":       "base64",
                                "media_type": media_type,
                                "data":       img_b64,
                            },
                        },
                        {
                            "type": "text",
                            "text": (
                                f"카테고리: {category}, 자재명: {name}\n"
                                "이 자재 이미지를 분석해서 프롬프트를 생성해줘."
                            ),
                        },
                    ],
                }
            ],
        )

        # ── 3. 응답 텍스트 추출 ──────────────────────────────────────────────────
        raw_text = next(
            (block.text for block in response.content if block.type == "text"),
            "",
        )
        logger.debug("Claude 응답 (material=%r): %s", name, raw_text[:200])

        # ── 4. JSON 파싱 ─────────────────────────────────────────────────────────
        parsed = _parse_json_response(raw_text)
        if parsed is None:
            raise ValueError(f"Claude 응답을 JSON으로 파싱할 수 없습니다: {raw_text[:200]!r}")

        # ── 5. 필드 검증 + 범위 보정 ────────────────────────────────────────────
        result = _validate_and_clamp(parsed, category)
        logger.info(
            "프롬프트 생성 완료 (material=%r, category=%r) "
            "ipadapter=%.2f denoise=%.2f",
            name, category,
            result["ip_adapter_weight"],
            result["recommended_denoise"],
        )
        return result

    async def _fetch_image_as_base64(
        self,
        image_url: str,
        timeout: int = 20,
    ) -> tuple[str, str]:
        """
        이미지 URL을 다운로드하여 (base64_string, media_type) 튜플 반환.

        data-URL("data:image/png;base64,...")도 지원합니다.

        Returns:
            (base64_string, media_type) — e.g. ("iVBOR...", "image/png")

        Raises:
            ValueError: 다운로드 실패 또는 지원하지 않는 형식.
        """
        # data-URL 처리
        if image_url.startswith("data:"):
            header, b64 = image_url.split(",", 1)
            media_type  = header.split(";")[0].split(":")[1]
            return b64, media_type

        # HTTP/S URL 다운로드
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.get(image_url, follow_redirects=True)
                resp.raise_for_status()
                raw_bytes  = resp.content
                media_type = resp.headers.get("content-type", "image/jpeg").split(";")[0]
        except httpx.HTTPError as exc:
            raise ValueError(f"이미지 다운로드 실패 ({image_url!r}): {exc}") from exc

        # 지원하는 미디어 타입만 허용
        allowed = {"image/jpeg", "image/png", "image/gif", "image/webp"}
        if media_type not in allowed:
            # content-type 헤더가 없거나 잘못된 경우 URL 확장자로 추측
            if image_url.lower().endswith(".png"):
                media_type = "image/png"
            elif image_url.lower().endswith((".jpg", ".jpeg")):
                media_type = "image/jpeg"
            elif image_url.lower().endswith(".webp"):
                media_type = "image/webp"
            else:
                media_type = "image/jpeg"   # 기본값

        return base64.standard_b64encode(raw_bytes).decode("utf-8"), media_type


# ── 헬퍼 ──────────────────────────────────────────────────────────────────────

def _get_api_key() -> str:
    """settings에서 ANTHROPIC_API_KEY를 읽습니다. 없으면 빈 문자열 반환."""
    try:
        from app.config import settings
        return settings.ANTHROPIC_API_KEY
    except Exception:
        return ""


# ── 모듈 레벨 싱글턴 ──────────────────────────────────────────────────────────
material_prompt_generator = MaterialPromptGenerator()
