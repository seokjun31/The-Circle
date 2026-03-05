"""
auto_test.py
─────────────
동일한 입력 이미지로 여러 파라미터 조합을 자동 테스트하는 스크립트.

사용 예시
---------
# 기본 실행 (test.jpg → results/ 폴더에 저장)
python auto_test.py -i test.jpg

# 결과 폴더 지정
python auto_test.py -i test.jpg -o my_results/

# 특정 조합만 실행 (인덱스 0, 2번째)
python auto_test.py -i test.jpg --runs 0,2
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


# ──────────────────────────────────────────────────────────
# 테스트할 파라미터 조합 정의
# 원하는 조합을 자유롭게 추가/수정하세요.
# ──────────────────────────────────────────────────────────

TEST_RUNS: List[Dict[str, Any]] = [
    # ── 기준값 ────────────────────────────────────────────
    {
        "name": "baseline",
        "desc": "기본값 (strength=0.65, steps=30, guidance=12)",
        "params": {
            "--strength": 0.65,
            "--steps": 30,
            "--guidance-scale": 12.0,
            "--seed": 42,
            "--staging-ratio": 0.45,
            "--faces": "front,back,right,left",
        },
    },
    # ── strength 변화 ──────────────────────────────────────
    {
        "name": "strength_low",
        "desc": "strength 낮음 (0.45) → 원본 보존 강함",
        "params": {
            "--strength": 0.45,
            "--steps": 30,
            "--guidance-scale": 12.0,
            "--seed": 42,
            "--staging-ratio": 0.45,
            "--faces": "front,back,right,left",
        },
    },
    {
        "name": "strength_high",
        "desc": "strength 높음 (0.85) → 스테이징 강함",
        "params": {
            "--strength": 0.85,
            "--steps": 30,
            "--guidance-scale": 12.0,
            "--seed": 42,
            "--staging-ratio": 0.45,
            "--faces": "front,back,right,left",
        },
    },
    # ── guidance scale 변화 ────────────────────────────────
    {
        "name": "guidance_low",
        "desc": "guidance 낮음 (7.5) → 자유로운 생성",
        "params": {
            "--strength": 0.65,
            "--steps": 30,
            "--guidance-scale": 7.5,
            "--seed": 42,
            "--staging-ratio": 0.45,
            "--faces": "front,back,right,left",
        },
    },
    {
        "name": "guidance_high",
        "desc": "guidance 높음 (15.0) → 프롬프트 충실도↑",
        "params": {
            "--strength": 0.65,
            "--steps": 30,
            "--guidance-scale": 15.0,
            "--seed": 42,
            "--staging-ratio": 0.45,
            "--faces": "front,back,right,left",
        },
    },
    # ── staging ratio (마스크 범위) 변화 ──────────────────
    {
        "name": "ratio_small",
        "desc": "staging_ratio 좁음 (0.25) → 하단 25%만 스테이징",
        "params": {
            "--strength": 0.65,
            "--steps": 30,
            "--guidance-scale": 12.0,
            "--seed": 42,
            "--staging-ratio": 0.25,
            "--faces": "front,back,right,left",
        },
    },
    {
        "name": "ratio_large",
        "desc": "staging_ratio 넓음 (0.70) → 하단 70%까지 스테이징",
        "params": {
            "--strength": 0.65,
            "--steps": 30,
            "--guidance-scale": 12.0,
            "--seed": 42,
            "--staging-ratio": 0.70,
            "--faces": "front,back,right,left",
        },
    },
    # ── 시드 변화 (같은 설정, 다른 랜덤) ─────────────────
    {
        "name": "seed_100",
        "desc": "seed=100 (다른 랜덤 결과)",
        "params": {
            "--strength": 0.65,
            "--steps": 30,
            "--guidance-scale": 12.0,
            "--seed": 100,
            "--staging-ratio": 0.45,
            "--faces": "front,back,right,left",
        },
    },
    # ── 고품질 (steps 높임) ────────────────────────────────
    {
        "name": "high_quality",
        "desc": "고품질 (steps=50, strength=0.70, guidance=12)",
        "params": {
            "--strength": 0.70,
            "--steps": 50,
            "--guidance-scale": 12.0,
            "--seed": 42,
            "--staging-ratio": 0.45,
            "--faces": "front,back,right,left",
        },
    },
    # ── 바닥 포함 ──────────────────────────────────────────
    {
        "name": "with_bottom",
        "desc": "바닥면 포함 스테이징",
        "params": {
            "--strength": 0.65,
            "--steps": 30,
            "--guidance-scale": 12.0,
            "--seed": 42,
            "--staging-ratio": 0.45,
            "--faces": "front,back,right,left,bottom",
        },
    },
]


# ──────────────────────────────────────────────────────────
# 실행 로직
# ──────────────────────────────────────────────────────────

def build_command(
    input_path: str,
    output_path: str,
    run_cfg: Dict[str, Any],
    save_faces_dir: Optional[str],
    no_lora: bool,
) -> List[str]:
    cmd = [sys.executable, "main.py", "-i", input_path, "-o", output_path]

    for key, val in run_cfg["params"].items():
        cmd.extend([key, str(val)])

    if save_faces_dir:
        cmd.extend(["--save-faces", save_faces_dir])

    if no_lora:
        cmd.append("--no-lora")

    return cmd


def run_test(
    run_idx: int,
    run_cfg: Dict[str, Any],
    input_path: str,
    output_dir: Path,
    save_faces: bool,
    no_lora: bool,
    log: logging.Logger,
) -> Dict[str, Any]:
    name = run_cfg["name"]
    desc = run_cfg["desc"]
    output_path = str(output_dir / f"{run_idx:02d}_{name}.jpg")
    faces_dir = str(output_dir / f"{run_idx:02d}_{name}_faces") if save_faces else None

    log.info("=" * 60)
    log.info("[%02d/%02d] %s", run_idx + 1, len(TEST_RUNS), name)
    log.info("  설명: %s", desc)
    log.info("  출력: %s", output_path)
    log.info("  파라미터: %s", run_cfg["params"])

    cmd = build_command(input_path, output_path, run_cfg, faces_dir, no_lora)
    log.info("  명령어: %s", " ".join(cmd))

    t0 = time.time()
    result = subprocess.run(cmd, capture_output=False)
    elapsed = time.time() - t0

    status = "SUCCESS" if result.returncode == 0 else f"FAILED (code={result.returncode})"
    log.info("  결과: %s  (%.1fs)", status, elapsed)

    return {
        "index": run_idx,
        "name": name,
        "desc": desc,
        "output": output_path,
        "params": run_cfg["params"],
        "status": status,
        "elapsed_s": round(elapsed, 1),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="360도 스테이징 파이프라인 자동 파라미터 테스트",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("-i", "--input", required=True, metavar="PATH",
                        help="테스트용 360도 이미지 (예: test.jpg)")
    parser.add_argument("-o", "--output-dir", default="test_results",
                        metavar="DIR", help="결과 저장 폴더 (기본값: test_results)")
    parser.add_argument("--runs", metavar="IDX",
                        help="실행할 run 인덱스 (쉼표 구분, 예: 0,2,5). 미지정 시 전체 실행")
    parser.add_argument("--save-faces", action="store_true",
                        help="각 run의 중간 큐브맵 면 이미지도 저장")
    parser.add_argument("--no-lora", action="store_true",
                        help="LoRA 없이 테스트")
    parser.add_argument("--list", action="store_true",
                        help="테스트 조합 목록만 출력하고 종료")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    log = logging.getLogger("auto_test")

    # ── 목록 출력 모드 ─────────────────────────────────────
    if args.list:
        print(f"\n총 {len(TEST_RUNS)}개 테스트 조합:\n")
        for i, run in enumerate(TEST_RUNS):
            print(f"  [{i:02d}] {run['name']}")
            print(f"       {run['desc']}")
            print(f"       params: {run['params']}\n")
        return

    # ── 실행할 run 선택 ────────────────────────────────────
    if args.runs:
        indices = [int(x.strip()) for x in args.runs.split(",")]
    else:
        indices = list(range(len(TEST_RUNS)))

    selected_runs = [TEST_RUNS[i] for i in indices]

    # ── 출력 디렉터리 생성 ─────────────────────────────────
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    log.info("결과 저장 폴더: %s", output_dir.resolve())
    log.info("테스트할 조합 수: %d", len(selected_runs))

    # ── 순차 실행 ──────────────────────────────────────────
    t_total = time.time()
    summary = []

    for local_idx, (orig_idx, run_cfg) in enumerate(zip(indices, selected_runs)):
        result = run_test(
            run_idx=local_idx,
            run_cfg=run_cfg,
            input_path=args.input,
            output_dir=output_dir,
            save_faces=args.save_faces,
            no_lora=args.no_lora,
            log=log,
        )
        summary.append(result)

    # ── 요약 저장 ──────────────────────────────────────────
    summary_path = output_dir / "summary.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    # ── 최종 보고 ──────────────────────────────────────────
    total_elapsed = time.time() - t_total
    log.info("=" * 60)
    log.info("전체 완료! 총 소요 시간: %.1fs", total_elapsed)
    log.info("")
    log.info("%-25s %-12s %s", "이름", "상태", "출력 파일")
    log.info("-" * 70)
    for r in summary:
        log.info("%-25s %-12s %s", r["name"], r["status"], r["output"])
    log.info("")
    log.info("요약 파일: %s", summary_path)


if __name__ == "__main__":
    main()
