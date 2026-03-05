"""
check_image.py
──────────────
스테이징 결과 이미지를 자동으로 품질 검사하는 스크립트.

검사 방법
---------
1. 통계 검사 (빠름, API 불필요)
   - 이미지 로드 성공 여부
   - 전체 흑백 여부 (파이프라인 오류 감지)
   - 평균 밝기, 색상 분산 (너무 어둡거나 단색 이미지 감지)
   - 원본 대비 변화량 (스테이징이 실제로 적용됐는지 확인)

2. Claude Vision 검사 (정확함, ANTHROPIC_API_KEY 필요)
   - 스테이징 품질 평가 (가구 배치, 자연스러움)
   - 360도 왜곡/이음새 여부
   - 구체적인 문제점 및 개선 제안

사용 예시
---------
# 단일 이미지 검사
python check_image.py -i output.jpg

# 원본과 비교하며 검사
python check_image.py -i output.jpg --original test.jpg

# test_results/ 폴더 일괄 검사
python check_image.py --batch test_results/

# 통계 검사만 (API 없이)
python check_image.py --batch test_results/ --no-vision

# auto_test.py 와 연계: 테스트 후 일괄 검사
python auto_test.py -i test.jpg && python check_image.py --batch test_results/
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

# ──────────────────────────────────────────────────────────
# 상수
# ──────────────────────────────────────────────────────────

# 통계 검사 임계값
BRIGHTNESS_MIN = 30      # 평균 밝기 하한 (너무 어두움)
BRIGHTNESS_MAX = 230     # 평균 밝기 상한 (너무 밝음/날아감)
VARIANCE_MIN = 200       # 색상 분산 하한 (너무 단색)
DIFF_MIN_RATIO = 0.02    # 원본 대비 최소 변화 비율 (스테이징이 적용됐는지)
DIFF_MAX_RATIO = 0.60    # 원본 대비 최대 변화 비율 (너무 많이 변하면 이상)

# Claude 평가 프롬프트
VISION_SYSTEM_PROMPT = """당신은 360도 가상 인테리어 스테이징 품질 검사 전문가입니다.
이미지를 분석하고 아래 항목을 JSON 형식으로 평가하세요.
반드시 JSON만 출력하고 다른 텍스트는 포함하지 마세요."""

VISION_USER_PROMPT = """이 이미지는 AI가 스테이징한 360도 실내 사진입니다.
다음 항목을 분석하고 JSON으로 응답하세요:

{
  "overall_score": 1~10 (종합 점수, 10이 최고),
  "verdict": "PASS" 또는 "FAIL",
  "staging_quality": {
    "has_furniture": true/false,
    "furniture_looks_natural": true/false,
    "style_consistent": true/false
  },
  "technical_quality": {
    "no_visible_seams": true/false,
    "no_distortion": true/false,
    "lighting_consistent": true/false,
    "no_artifacts": true/false
  },
  "issues": ["발견된 문제점 목록 (없으면 빈 배열)"],
  "suggestions": ["개선 제안 목록 (없으면 빈 배열)"],
  "summary": "한 줄 요약"
}"""


# ──────────────────────────────────────────────────────────
# 통계 검사
# ──────────────────────────────────────────────────────────

def stat_check(
    image_path: str,
    original_path: Optional[str] = None,
) -> Dict:
    """
    이미지 통계 검사를 수행한다.

    Returns
    -------
    dict  with keys: passed, score, issues, stats
    """
    result = {
        "passed": True,
        "score": 10,
        "issues": [],
        "stats": {},
    }

    # ── 로드 ──────────────────────────────────────────────
    img = cv2.imread(image_path)
    if img is None:
        result["passed"] = False
        result["score"] = 0
        result["issues"].append("이미지 로드 실패 (파일 손상 또는 미존재)")
        return result

    h, w = img.shape[:2]
    result["stats"]["resolution"] = f"{w}x{h}"

    # ── 밝기 검사 ─────────────────────────────────────────
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    brightness = float(np.mean(gray))
    result["stats"]["brightness"] = round(brightness, 1)

    if brightness < BRIGHTNESS_MIN:
        result["issues"].append(f"이미지가 너무 어둡습니다 (밝기={brightness:.0f}, 최소={BRIGHTNESS_MIN})")
        result["score"] -= 3
    elif brightness > BRIGHTNESS_MAX:
        result["issues"].append(f"이미지가 너무 밝습니다/날아갔습니다 (밝기={brightness:.0f}, 최대={BRIGHTNESS_MAX})")
        result["score"] -= 3

    # ── 색상 분산 검사 ────────────────────────────────────
    variance = float(np.var(img))
    result["stats"]["color_variance"] = round(variance, 1)

    if variance < VARIANCE_MIN:
        result["issues"].append(
            f"색상 다양성이 너무 낮습니다 (분산={variance:.0f}, 최소={VARIANCE_MIN}) "
            "→ 단색/회색 이미지일 가능성"
        )
        result["score"] -= 3

    # ── 전체 흑/백 검사 ───────────────────────────────────
    black_ratio = float(np.mean(gray < 5))
    white_ratio = float(np.mean(gray > 250))
    result["stats"]["black_ratio"] = round(black_ratio, 3)
    result["stats"]["white_ratio"] = round(white_ratio, 3)

    if black_ratio > 0.90:
        result["issues"].append(f"이미지 {black_ratio:.0%}가 검정입니다 → 파이프라인 오류 의심")
        result["score"] -= 5
    if white_ratio > 0.90:
        result["issues"].append(f"이미지 {white_ratio:.0%}가 흰색입니다 → 오버익스포저 의심")
        result["score"] -= 5

    # ── 원본 대비 변화량 ──────────────────────────────────
    if original_path:
        orig = cv2.imread(original_path)
        if orig is not None:
            # 크기 맞추기
            if orig.shape[:2] != img.shape[:2]:
                orig = cv2.resize(orig, (w, h))

            diff = cv2.absdiff(img, orig).astype(np.float32)
            diff_ratio = float(np.mean(diff) / 255.0)
            result["stats"]["diff_from_original"] = round(diff_ratio, 4)

            if diff_ratio < DIFF_MIN_RATIO:
                result["issues"].append(
                    f"원본 대비 변화가 너무 적습니다 ({diff_ratio:.1%}) "
                    "→ 스테이징이 적용되지 않았을 수 있음"
                )
                result["score"] -= 2
            elif diff_ratio > DIFF_MAX_RATIO:
                result["issues"].append(
                    f"원본 대비 변화가 너무 큽니다 ({diff_ratio:.1%}) "
                    "→ 이미지 전체가 변형됐을 수 있음"
                )
                result["score"] -= 2

    result["score"] = max(0, result["score"])
    result["passed"] = len(result["issues"]) == 0

    return result


# ──────────────────────────────────────────────────────────
# Claude Vision 검사
# ──────────────────────────────────────────────────────────

def vision_check(image_path: str) -> Dict:
    """
    Claude Vision API 로 이미지 품질을 평가한다.

    ANTHROPIC_API_KEY 환경변수가 설정돼 있어야 한다.

    Returns
    -------
    dict  with keys: passed, score, verdict, staging_quality,
                     technical_quality, issues, suggestions, summary, error
    """
    try:
        import anthropic
    except ImportError:
        return {
            "error": "anthropic 패키지가 설치되지 않았습니다. pip install anthropic",
            "passed": None,
        }

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return {
            "error": "ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.",
            "passed": None,
        }

    # 이미지를 base64로 인코딩
    with open(image_path, "rb") as f:
        image_data = base64.standard_b64encode(f.read()).decode("utf-8")

    # 이미지 MIME 타입 결정
    ext = Path(image_path).suffix.lower()
    media_type_map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }
    media_type = media_type_map.get(ext, "image/jpeg")

    client = anthropic.Anthropic(api_key=api_key)

    try:
        response = client.messages.create(
            model="claude-opus-4-6",
            max_tokens=1024,
            system=VISION_SYSTEM_PROMPT,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_data,
                        },
                    },
                    {
                        "type": "text",
                        "text": VISION_USER_PROMPT,
                    },
                ],
            }],
        )

        raw = response.content[0].text.strip()

        # JSON 블록 추출 (```json ... ``` 형태도 처리)
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        parsed = json.loads(raw)
        parsed["passed"] = parsed.get("verdict") == "PASS"
        return parsed

    except json.JSONDecodeError as e:
        return {
            "error": f"Claude 응답 JSON 파싱 실패: {e}\n원문: {raw[:200]}",
            "passed": None,
        }
    except Exception as e:
        return {
            "error": f"Claude API 호출 실패: {e}",
            "passed": None,
        }


# ──────────────────────────────────────────────────────────
# 단일 이미지 검사
# ──────────────────────────────────────────────────────────

def check_single(
    image_path: str,
    original_path: Optional[str] = None,
    use_vision: bool = True,
    log: Optional[logging.Logger] = None,
) -> Dict:
    """단일 이미지에 대해 전체 검사를 수행한다."""
    if log is None:
        log = logging.getLogger("check_image")

    log.info("검사 중: %s", image_path)

    result = {
        "image": image_path,
        "stat": None,
        "vision": None,
        "final_verdict": "UNKNOWN",
    }

    # ── 통계 검사 ─────────────────────────────────────────
    stat = stat_check(image_path, original_path)
    result["stat"] = stat

    stat_verdict = "PASS" if stat["passed"] else "FAIL"
    log.info(
        "  [통계] %s  score=%d  brightness=%.0f  variance=%.0f%s",
        stat_verdict,
        stat["score"],
        stat["stats"].get("brightness", 0),
        stat["stats"].get("color_variance", 0),
        f"  diff={stat['stats'].get('diff_from_original', 'N/A')}" if original_path else "",
    )
    for issue in stat["issues"]:
        log.warning("    ⚠  %s", issue)

    # ── Vision 검사 ───────────────────────────────────────
    if use_vision:
        vision = vision_check(image_path)
        result["vision"] = vision

        if vision.get("error"):
            log.warning("  [Vision] 오류: %s", vision["error"])
        elif vision.get("passed") is not None:
            v_verdict = "PASS" if vision["passed"] else "FAIL"
            log.info(
                "  [Vision] %s  score=%s  '%s'",
                v_verdict,
                vision.get("overall_score", "?"),
                vision.get("summary", ""),
            )
            for issue in vision.get("issues", []):
                log.warning("    ⚠  %s", issue)
            for sug in vision.get("suggestions", []):
                log.info("    💡 %s", sug)

    # ── 최종 판정 ─────────────────────────────────────────
    stat_ok = stat["passed"]
    vision_result = result.get("vision")

    if vision_result and vision_result.get("passed") is not None:
        # 통계 + Vision 둘 다 통과해야 PASS
        result["final_verdict"] = "PASS" if (stat_ok and vision_result["passed"]) else "FAIL"
    else:
        # Vision 불가 시 통계만으로 판정
        result["final_verdict"] = "PASS" if stat_ok else "FAIL"

    log.info("  → 최종: %s", result["final_verdict"])
    return result


# ──────────────────────────────────────────────────────────
# 배치 검사 (폴더 내 .jpg/.png 전체)
# ──────────────────────────────────────────────────────────

def check_batch(
    folder: str,
    original_path: Optional[str] = None,
    use_vision: bool = True,
    log: Optional[logging.Logger] = None,
) -> List[Dict]:
    """폴더 내 모든 이미지를 검사한다."""
    if log is None:
        log = logging.getLogger("check_image")

    folder_path = Path(folder)
    images = sorted(
        list(folder_path.glob("*.jpg"))
        + list(folder_path.glob("*.jpeg"))
        + list(folder_path.glob("*.png"))
    )

    # summary.json 같은 메타데이터 파일 내의 이미지도 정렬 기준으로 활용
    if not images:
        log.warning("폴더에서 이미지를 찾을 수 없습니다: %s", folder)
        return []

    log.info("배치 검사 시작: %d개 이미지 in %s", len(images), folder)

    results = []
    for img_path in images:
        r = check_single(str(img_path), original_path, use_vision, log)
        results.append(r)

    return results


# ──────────────────────────────────────────────────────────
# 결과 요약 출력
# ──────────────────────────────────────────────────────────

def print_summary(results: List[Dict], log: logging.Logger) -> None:
    """검사 결과를 테이블 형태로 요약 출력한다."""
    pass_count = sum(1 for r in results if r["final_verdict"] == "PASS")
    fail_count = len(results) - pass_count

    log.info("")
    log.info("=" * 70)
    log.info("검사 결과 요약  (PASS: %d / FAIL: %d / 전체: %d)", pass_count, fail_count, len(results))
    log.info("=" * 70)
    log.info("%-35s %-8s %-6s %-6s %s",
             "이미지", "판정", "통계", "Vision", "비고")
    log.info("-" * 70)

    for r in results:
        name = Path(r["image"]).name[:34]
        verdict = r["final_verdict"]
        stat_s = f"{r['stat']['score']}/10" if r["stat"] else "N/A"
        vision_s = str(r["vision"].get("overall_score", "N/A")) + "/10" if r.get("vision") and not r["vision"].get("error") else "N/A"
        summary = r["vision"].get("summary", "") if r.get("vision") and not r["vision"].get("error") else ""
        log.info("%-35s %-8s %-6s %-6s %s", name, verdict, stat_s, vision_s, summary[:30])

    log.info("=" * 70)


# ──────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="스테이징 결과 이미지 자동 품질 검사",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "-i", "--input",
        metavar="PATH",
        help="단일 검사 이미지 경로",
    )
    parser.add_argument(
        "--batch",
        metavar="DIR",
        help="폴더 내 모든 이미지 일괄 검사 (auto_test 결과 폴더 사용)",
    )
    parser.add_argument(
        "--original",
        metavar="PATH",
        help="원본 이미지 경로 (변화량 비교용, 선택)",
    )
    parser.add_argument(
        "--no-vision",
        action="store_true",
        help="Claude Vision API 검사 건너뜀 (통계 검사만 실행)",
    )
    parser.add_argument(
        "--output-json",
        metavar="PATH",
        help="결과를 JSON 파일로 저장",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    log = logging.getLogger("check_image")

    use_vision = not args.no_vision

    # ── 단일 or 배치 ──────────────────────────────────────
    if args.input:
        results = [check_single(args.input, args.original, use_vision, log)]
    elif args.batch:
        results = check_batch(args.batch, args.original, use_vision, log)
    else:
        print("--input 또는 --batch 옵션을 지정하세요.", file=sys.stderr)
        sys.exit(1)

    # ── 요약 ──────────────────────────────────────────────
    if results:
        print_summary(results, log)

    # ── JSON 저장 ─────────────────────────────────────────
    if args.output_json and results:
        with open(args.output_json, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        log.info("결과 저장: %s", args.output_json)

    # ── 종료 코드: FAIL 이 있으면 1 ──────────────────────
    has_fail = any(r["final_verdict"] == "FAIL" for r in results)
    sys.exit(1 if has_fail else 0)


if __name__ == "__main__":
    main()
