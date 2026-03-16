#!/usr/bin/env python3
"""
The Circle — 자재 텍스처 Seamless Tiling 검증 + 자동 변환 유틸리티

2×2 타일링 시 경계 부분의 색상 차이를 측정하고,
seamless하지 않은 텍스처를 가장자리 블렌딩으로 자동 변환합니다.

사용법:
  # 검증만
  python scripts/validate_seamless.py --input tile.png

  # 검증 + 자동 변환 출력
  python scripts/validate_seamless.py --input tile.png --output tile_seamless.png

  # 강제 변환 (검증 결과에 관계없이)
  python scripts/validate_seamless.py --input tile.png --output out.png --force

  # 경계 두께 지정 (기본 10%)
  python scripts/validate_seamless.py --input tile.png --output out.png --blend-width 0.15

  # 문제 영역 시각화 저장
  python scripts/validate_seamless.py --input tile.png --visualize highlight.png
"""

import argparse
import sys
from pathlib import Path

try:
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    print("[오류] Pillow, numpy가 필요합니다.")
    print("  pip install Pillow numpy")
    sys.exit(1)

# scikit-image SSIM: 선택적 임포트
try:
    from skimage.metrics import structural_similarity as _skimage_ssim
    HAS_SKIMAGE = True
except ImportError:
    HAS_SKIMAGE = False

# ANSI 색상
_G    = "\033[32m"
_Y    = "\033[33m"
_R    = "\033[31m"
_B    = "\033[34m"
_BOLD = "\033[1m"
_RST  = "\033[0m"

# ── 기본 임계값 ────────────────────────────────────────────────────────────────
DEFAULT_DIFF_THRESHOLD = 15.0   # 평균 픽셀 색상 차이 (0–255)
DEFAULT_SSIM_THRESHOLD = 0.85   # SSIM (0–1, 높을수록 유사)
DEFAULT_BLEND_WIDTH    = 0.10   # 가장자리 블렌딩 비율 (이미지 크기 대비)


# ══════════════════════════════════════════════════════════════════════════════
#  핵심 분석 함수
# ══════════════════════════════════════════════════════════════════════════════

def load_image(path: str) -> np.ndarray:
    """이미지를 RGB float32 배열 [H, W, 3] (0–255)로 로드."""
    img = Image.open(path).convert("RGB")
    return np.array(img, dtype=np.float32)


def make_2x2_tiled(img: np.ndarray) -> np.ndarray:
    """이미지를 2×2 타일링한 배열 반환."""
    return np.block([[img, img], [img, img]])


def extract_seam_strips(img: np.ndarray, border_px: int):
    """
    수평/수직 이음새(seam) 양쪽 스트립 추출.

    2×2 타일링 시 경계는 img의 오른쪽 끝 ↔ 왼쪽 끝,
    아래쪽 끝 ↔ 위쪽 끝이 맞닿음.

    Returns:
        h_top, h_bot: 수평 이음새 위 / 아래 스트립
        v_left, v_right: 수직 이음새 왼쪽 / 오른쪽 스트립
    """
    h, w = img.shape[:2]
    bp = max(1, border_px)

    h_top  = img[-bp:, :, :]   # 이미지 아래쪽 bp행
    h_bot  = img[:bp, :, :]    # 이미지 위쪽 bp행

    v_left  = img[:, -bp:, :]  # 이미지 오른쪽 bp열
    v_right = img[:, :bp, :]   # 이미지 왼쪽 bp열

    return h_top, h_bot, v_left, v_right


def mean_abs_diff(a: np.ndarray, b: np.ndarray) -> float:
    """두 배열의 절댓값 평균 차이."""
    return float(np.mean(np.abs(a.astype(np.float64) - b.astype(np.float64))))


def simple_ssim(a: np.ndarray, b: np.ndarray) -> float:
    """
    경량 SSIM 구현 (scikit-image 없을 때 사용).
    두 배열을 grayscale로 변환 후 윈도우 없이 전역 SSIM 계산.
    """
    def to_gray(arr):
        return 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]

    x = to_gray(a).astype(np.float64)
    y = to_gray(b).astype(np.float64)

    C1 = (0.01 * 255) ** 2
    C2 = (0.03 * 255) ** 2

    mu_x  = np.mean(x)
    mu_y  = np.mean(y)
    sig_x = np.std(x)
    sig_y = np.std(y)
    sig_xy = np.mean((x - mu_x) * (y - mu_y))

    numerator   = (2 * mu_x * mu_y + C1) * (2 * sig_xy + C2)
    denominator = (mu_x**2 + mu_y**2 + C1) * (sig_x**2 + sig_y**2 + C2)
    return float(numerator / (denominator + 1e-10))


def compute_ssim(a: np.ndarray, b: np.ndarray) -> float:
    if HAS_SKIMAGE:
        ag = np.mean(a, axis=-1).astype(np.float64)
        bg = np.mean(b, axis=-1).astype(np.float64)
        return float(_skimage_ssim(ag, bg, data_range=255.0))
    return simple_ssim(a, b)


class SeamAnalysis:
    """이음새 분석 결과."""
    def __init__(self):
        self.h_diff:  float = 0.0
        self.v_diff:  float = 0.0
        self.h_ssim:  float = 1.0
        self.v_ssim:  float = 1.0
        self.h_pass:  bool  = True
        self.v_pass:  bool  = True
        self.overall: bool  = True
        self.border_px: int = 0

    @property
    def avg_diff(self):
        return (self.h_diff + self.v_diff) / 2

    @property
    def avg_ssim(self):
        return (self.h_ssim + self.v_ssim) / 2


def analyze(img: np.ndarray,
            diff_threshold: float = DEFAULT_DIFF_THRESHOLD,
            ssim_threshold: float = DEFAULT_SSIM_THRESHOLD,
            blend_width:    float = DEFAULT_BLEND_WIDTH) -> SeamAnalysis:
    """
    이미지의 수평/수직 이음새를 분석하여 SeamAnalysis 반환.
    """
    h, w = img.shape[:2]
    border_px = max(2, int(min(h, w) * blend_width))

    h_top, h_bot, v_left, v_right = extract_seam_strips(img, border_px)

    result = SeamAnalysis()
    result.border_px = border_px

    result.h_diff = mean_abs_diff(h_top, h_bot)
    result.v_diff = mean_abs_diff(v_left, v_right)

    result.h_ssim = compute_ssim(h_top, h_bot)
    result.v_ssim = compute_ssim(v_left, v_right)

    result.h_pass = result.h_diff <= diff_threshold and result.h_ssim >= ssim_threshold
    result.v_pass = result.v_diff <= diff_threshold and result.v_ssim >= ssim_threshold
    result.overall = result.h_pass and result.v_pass

    return result


# ══════════════════════════════════════════════════════════════════════════════
#  시각화: 문제 영역 하이라이트
# ══════════════════════════════════════════════════════════════════════════════

def visualize_seams(img_arr: np.ndarray,
                    analysis: SeamAnalysis,
                    out_path: str):
    """
    2×2 타일링 이미지 위에 이음새 경계를 시각적으로 표시.

    - 빨간색: 차이가 큰 (문제) 이음새
    - 초록색: 차이가 작은 (양호) 이음새
    """
    h, w = img_arr.shape[:2]
    tiled = make_2x2_tiled(img_arr)
    vis   = Image.fromarray(np.clip(tiled, 0, 255).astype(np.uint8))
    draw  = ImageDraw.Draw(vis, "RGBA")

    # 수직 이음새 (2배 너비 기준 가운데 세로선)
    v_color = (255, 60, 60, 160) if not analysis.v_pass else (60, 220, 60, 160)
    bx = analysis.border_px
    # 이음새 영역 하이라이트 (반투명 직사각형)
    draw.rectangle([w - bx, 0, w + bx, h * 2], fill=v_color)

    # 수평 이음새
    h_color = (255, 60, 60, 160) if not analysis.h_pass else (60, 220, 60, 160)
    draw.rectangle([0, h - bx, w * 2, h + bx], fill=h_color)

    # 라벨
    def label(x, y, text, color):
        # 그림자
        draw.text((x + 1, y + 1), text, fill=(0, 0, 0, 200))
        draw.text((x, y), text, fill=color)

    v_label = f"수직 이음새 diff={analysis.v_diff:.1f} SSIM={analysis.v_ssim:.3f}"
    h_label = f"수평 이음새 diff={analysis.h_diff:.1f} SSIM={analysis.h_ssim:.3f}"
    v_lc = (255, 100, 100, 255) if not analysis.v_pass else (100, 255, 100, 255)
    h_lc = (255, 100, 100, 255) if not analysis.h_pass else (100, 255, 100, 255)

    label(w + bx + 4, h // 2, v_label, v_lc)
    label(4, h + bx + 4, h_label, h_lc)

    vis.save(out_path)
    print(f"{_G}[시각화]{_RST} {out_path}")


# ══════════════════════════════════════════════════════════════════════════════
#  자동 Seamless 변환 (가장자리 블렌딩)
# ══════════════════════════════════════════════════════════════════════════════

def make_seamless(img_arr: np.ndarray, blend_width: float = DEFAULT_BLEND_WIDTH) -> np.ndarray:
    """
    가장자리 블렌딩(offset + cross-fade)으로 seamless 타일 생성.

    알고리즘:
      1. 이미지를 H/2, W/2 만큼 오프셋 이동 (np.roll)
      2. 원본과 오프셋 이미지를 가장자리에서 부드럽게 blending
      3. 결과 = 중앙 부분은 원본 유지, 가장자리 전환

    이 방법은 Photoshop의 "Offset + Stamp" 기법과 동일합니다.
    """
    h, w = img_arr.shape[:2]
    border_px = max(2, int(min(h, w) * blend_width))

    # Step 1: 이미지를 절반씩 오프셋 (roll)
    rolled = np.roll(np.roll(img_arr, h // 2, axis=0), w // 2, axis=1)

    # Step 2: 블렌딩 마스크 생성 (가장자리에서 0→1→0 그라디언트)
    # 수평 마스크 [W]
    mask_h = np.ones(w, dtype=np.float32)
    for i in range(border_px):
        t = i / border_px
        mask_h[i]       = t
        mask_h[w - 1 - i] = t

    # 수직 마스크 [H]
    mask_v = np.ones(h, dtype=np.float32)
    for i in range(border_px):
        t = i / border_px
        mask_v[i]       = t
        mask_v[h - 1 - i] = t

    # 2D 마스크 [H, W] — 가장자리일수록 0 (rolled 이미지 비율 높음)
    mask_2d = np.outer(mask_v, mask_h).astype(np.float32)  # [H, W]
    mask_3d = mask_2d[:, :, np.newaxis]                     # [H, W, 1] broadcast

    # 원본 비율 높은 곳 = 마스크 1, 가장자리(rolled 비율 높음) = 마스크 0
    # blended = original * mask + rolled * (1 - mask)
    blended = img_arr * mask_3d + rolled * (1.0 - mask_3d)

    return np.clip(blended, 0, 255).astype(np.uint8)


# ══════════════════════════════════════════════════════════════════════════════
#  보고서 출력
# ══════════════════════════════════════════════════════════════════════════════

def print_report(analysis: SeamAnalysis,
                 input_path: str,
                 diff_threshold: float,
                 ssim_threshold: float):
    img = Image.open(input_path)
    w, h = img.size

    print(f"\n{_BOLD}{'═'*58}{_RST}")
    print(f"{_BOLD} Seamless Tiling 분석 결과{_RST}")
    print(f"{'─'*58}")
    print(f"  파일     : {input_path}")
    print(f"  크기     : {w}×{h} px")
    print(f"  경계 두께: {analysis.border_px}px")
    print(f"  알고리즘 : {'scikit-image SSIM' if HAS_SKIMAGE else '내장 SSIM (경량)'}")
    print(f"{'─'*58}")
    print(f"  {'항목':<20} {'수평 이음새':>14} {'수직 이음새':>14}")
    print(f"  {'─'*48}")

    def icon(ok): return f"{_G}✓{_RST}" if ok else f"{_R}✗{_RST}"
    def color_val(val, threshold, lower_better=True):
        ok = val <= threshold if lower_better else val >= threshold
        c  = _G if ok else _R
        return f"{c}{val:.2f}{_RST}"

    print(f"  {'평균 색상 차이 (0-255)':<20} "
          f"{color_val(analysis.h_diff, diff_threshold):>24} "
          f"{color_val(analysis.v_diff, diff_threshold):>24}")
    print(f"  {'SSIM 유사도 (0-1)':<20} "
          f"{color_val(analysis.h_ssim, ssim_threshold, lower_better=False):>24} "
          f"{color_val(analysis.v_ssim, ssim_threshold, lower_better=False):>24}")
    print(f"  {'판정':<20} "
          f"{'     ' + icon(analysis.h_pass):>20} "
          f"{'     ' + icon(analysis.v_pass):>20}")
    print(f"{'─'*58}")
    print(f"  임계값: 색상 차이 ≤ {diff_threshold}, SSIM ≥ {ssim_threshold}")
    print(f"{'═'*58}")

    if analysis.overall:
        print(f"\n  {_G}{_BOLD}✅ Seamless 타일링 가능합니다.{_RST}")
        print(f"  평균 색상 차이: {analysis.avg_diff:.2f} / SSIM: {analysis.avg_ssim:.4f}")
    else:
        problems = []
        if not analysis.h_pass:
            problems.append(f"수평 이음새 (차이={analysis.h_diff:.1f}, SSIM={analysis.h_ssim:.3f})")
        if not analysis.v_pass:
            problems.append(f"수직 이음새 (차이={analysis.v_diff:.1f}, SSIM={analysis.v_ssim:.3f})")
        print(f"\n  {_R}{_BOLD}⚠️  Seamless 문제 발견:{_RST}")
        for p in problems:
            print(f"    - {p}")
        print(f"  → --output 옵션으로 자동 변환이 가능합니다.")

    print()


# ══════════════════════════════════════════════════════════════════════════════
#  CLI 진입점
# ══════════════════════════════════════════════════════════════════════════════

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="자재 텍스처 Seamless Tiling 검증 + 자동 변환",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--input",  "-i", required=True, help="입력 텍스처 이미지 경로")
    p.add_argument("--output", "-o", default=None,  help="seamless 변환 결과 저장 경로")
    p.add_argument("--visualize", "-v", default=None,
                   help="2×2 타일링 + 문제 영역 하이라이트 저장 경로")
    p.add_argument("--blend-width", type=float, default=DEFAULT_BLEND_WIDTH,
                   help=f"가장자리 블렌딩 비율 (0.05–0.25, 기본: {DEFAULT_BLEND_WIDTH})")
    p.add_argument("--diff-threshold", type=float, default=DEFAULT_DIFF_THRESHOLD,
                   help=f"색상 차이 임계값 (기본: {DEFAULT_DIFF_THRESHOLD})")
    p.add_argument("--ssim-threshold", type=float, default=DEFAULT_SSIM_THRESHOLD,
                   help=f"SSIM 임계값 (기본: {DEFAULT_SSIM_THRESHOLD})")
    p.add_argument("--force", action="store_true",
                   help="이미 seamless라도 강제 변환")
    p.add_argument("--iterations", "-n", type=int, default=1,
                   help="변환 반복 횟수 (1–3, 기본: 1). 높을수록 더 부드러움")
    p.add_argument("--quality", "-q", type=int, default=95,
                   help="JPEG 출력 품질 (기본: 95)")
    return p.parse_args()


def main():
    args = parse_args()

    # 입력 파일 확인
    if not Path(args.input).exists():
        print(f"{_R}[오류]{_RST} 파일을 찾을 수 없습니다: {args.input}")
        sys.exit(1)

    print(f"\n{_B}[로드]{_RST} {args.input}")
    img_arr = load_image(args.input)
    print(f"  크기: {img_arr.shape[1]}×{img_arr.shape[0]}px, 채널: {img_arr.shape[2]}")

    # 분석
    print(f"{_B}[분석]{_RST} 이음새 검사 중...")
    analysis = analyze(
        img_arr,
        diff_threshold=args.diff_threshold,
        ssim_threshold=args.ssim_threshold,
        blend_width=args.blend_width,
    )

    # 보고서 출력
    print_report(analysis, args.input, args.diff_threshold, args.ssim_threshold)

    # 시각화
    if args.visualize:
        visualize_seams(img_arr, analysis, args.visualize)

    # Seamless 변환
    if args.output:
        should_convert = not analysis.overall or args.force

        if not should_convert:
            print(f"{_G}[건너뜀]{_RST} 이미 seamless입니다. (--force 옵션으로 강제 변환 가능)")
        else:
            if args.force and analysis.overall:
                print(f"{_Y}[강제 변환]{_RST} --force 옵션 적용")

            print(f"{_B}[변환]{_RST} Seamless 변환 시작 (반복 {args.iterations}회)...")
            result_arr = img_arr.astype(np.uint8)

            for i in range(args.iterations):
                result_arr = make_seamless(result_arr.astype(np.float32), args.blend_width)
                print(f"  반복 {i + 1}/{args.iterations} 완료")

            # 변환 후 재검증
            after = analyze(
                result_arr.astype(np.float32),
                diff_threshold=args.diff_threshold,
                ssim_threshold=args.ssim_threshold,
                blend_width=args.blend_width,
            )
            print(f"\n  변환 후 결과:")
            print(f"    수평 이음새: 차이 {after.h_diff:.2f} (전: {analysis.h_diff:.2f})")
            print(f"    수직 이음새: 차이 {after.v_diff:.2f} (전: {analysis.v_diff:.2f})")
            print(f"    평균 SSIM:   {after.avg_ssim:.4f} (전: {analysis.avg_ssim:.4f})")

            # 저장
            out_path = Path(args.output)
            ext = out_path.suffix.lower()
            result_img = Image.fromarray(result_arr)

            if ext in (".jpg", ".jpeg"):
                result_img.save(out_path, format="JPEG", quality=args.quality)
            elif ext == ".webp":
                result_img.save(out_path, format="WEBP", quality=args.quality)
            else:
                result_img.save(out_path, format="PNG")

            size_kb = out_path.stat().st_size // 1024
            print(f"\n{_G}[저장]{_RST} {out_path} ({size_kb}KB)")

            if after.overall:
                print(f"{_G}{_BOLD}✅ 변환 성공 — Seamless 타일링 가능{_RST}")
            else:
                print(f"{_Y}⚠️  개선됐지만 완전하지 않습니다.")
                print(f"   --iterations 2 또는 --blend-width 0.15 로 재시도해보세요.{_RST}")

    elif not analysis.overall:
        print(f"{_Y}힌트:{_RST} --output 파일명.png 옵션으로 자동 변환할 수 있습니다.")


if __name__ == "__main__":
    main()
