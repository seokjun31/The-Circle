"""
main.py
───────
360도 가상 인테리어 스테이징 파이프라인 진입점

전체 흐름
---------
1. 원본 360도 이미지(등장방형도법) 로드
2. 큐브맵 6면으로 분할  [cubemap.equirect_to_cubemap]
3. StableDiffusion Inpainting + LoRA 로 각 면 스테이징  [staging.StagingPipeline]
4. 6면을 다시 360도로 병합  [cubemap.cubemap_to_equirect]
5. 결과 저장

사용 예시
---------
# 기본 실행 (마스크 자동 생성)
python main.py -i tour.jpg -o output_staged.jpg --lora korean_apartment_v1.safetensors

# 상세 옵션 지정
python main.py \\
    -i tour.jpg \\
    -o output_staged.jpg \\
    --lora korean_apartment_v1.safetensors \\
    --lora-scale 0.9 \\
    --prompt "modern korean apartment, living room with white sofa, plants, warm lighting" \\
    --face-size 1024 \\
    --strength 0.80 \\
    --steps 30 \\
    --seed 42 \\
    --faces front,back,left,right,bottom \\
    --save-faces ./debug_faces
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path
from typing import List, Optional

import cv2
import numpy as np

# 로컬 모듈
from cubemap import (
    FACE_NAMES,
    cubemap_to_equirect,
    equirect_to_cubemap,
    load_equirect,
    load_faces,
    save_equirect,
    save_faces,
)
from staging import StagingPipeline, generate_default_masks, load_mask

# ──────────────────────────────────────────────
# 기본 프롬프트
# ──────────────────────────────────────────────

DEFAULT_PROMPT = (
    "modern korean apartment interior, empty living room staged with "
    "white fabric sofa, wooden coffee table, indoor plants, sheer curtains, "
    "warm natural lighting, photorealistic, 8K, ultra detailed"
)

DEFAULT_NEGATIVE_PROMPT = (
    "blurry, distorted, warped, fisheye distortion, bad anatomy, "
    "bad quality, low resolution, disfigured, deformed, cartoon, anime, "
    "illustration, painting, watermark, text, signature, "
    "duplicate furniture, multiple sofas, inconsistent style, "
    "upside down, floating objects, unrealistic perspective"
)


# ──────────────────────────────────────────────
# CLI 인자 파싱
# ──────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="360도 가상 인테리어 스테이징 파이프라인",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    # ── 입출력 ──────────────────────────────────
    io_grp = parser.add_argument_group("입출력")
    io_grp.add_argument(
        "-i", "--input",
        required=True,
        metavar="PATH",
        help="원본 360도 등장방형도법 이미지 (예: tour.jpg)",
    )
    io_grp.add_argument(
        "-o", "--output",
        default="output_staged.jpg",
        metavar="PATH",
        help="스테이징 결과 이미지 저장 경로 (기본값: output_staged.jpg)",
    )
    io_grp.add_argument(
        "--save-faces",
        metavar="DIR",
        help="중간 큐브맵 면 이미지를 저장할 디렉터리 (디버깅용, 선택)",
    )
    io_grp.add_argument(
        "--load-faces",
        metavar="DIR",
        help="사전에 저장된 큐브맵 면 디렉터리 로드 (분할 단계 건너뜀, 선택)",
    )

    # ── 모델 ────────────────────────────────────
    model_grp = parser.add_argument_group("모델")
    model_grp.add_argument(
        "--model",
        default="runwayml/stable-diffusion-inpainting",
        metavar="MODEL_ID",
        help=(
            "Hugging Face 모델 ID 또는 로컬 경로 "
            "(기본값: runwayml/stable-diffusion-inpainting)"
        ),
    )
    model_grp.add_argument(
        "--lora",
        default="korean_apartment_v1.safetensors",
        metavar="PATH",
        help="LoRA safetensors 파일 경로 (기본값: korean_apartment_v1.safetensors)",
    )
    model_grp.add_argument(
        "--lora-scale",
        type=float,
        default=0.8,
        metavar="FLOAT",
        help="LoRA 적용 강도 (0.0~1.0, 기본값: 0.8)",
    )
    model_grp.add_argument(
        "--no-lora",
        action="store_true",
        help="LoRA 를 사용하지 않음 (기본 SD 모델만 사용)",
    )
    model_grp.add_argument(
        "--no-xformers",
        action="store_true",
        help="xformers 비활성화 (VRAM 부족 시에만 권장)",
    )

    # ── 프롬프트 ────────────────────────────────
    prompt_grp = parser.add_argument_group("프롬프트")
    prompt_grp.add_argument(
        "-p", "--prompt",
        default=DEFAULT_PROMPT,
        metavar="TEXT",
        help="인테리어 스타일 프롬프트",
    )
    prompt_grp.add_argument(
        "-n", "--negative-prompt",
        default=DEFAULT_NEGATIVE_PROMPT,
        metavar="TEXT",
        help="부정 프롬프트",
    )

    # ── 인페인팅 파라미터 ────────────────────────
    inpaint_grp = parser.add_argument_group("인페인팅 파라미터")
    inpaint_grp.add_argument(
        "--strength",
        type=float,
        default=0.65,
        metavar="FLOAT",
        help="인페인팅 강도 0.0~1.0 (기본값: 0.65, 높을수록 원본 무시)",
    )
    inpaint_grp.add_argument(
        "--steps",
        type=int,
        default=30,
        metavar="INT",
        help="디노이징 스텝 수 (기본값: 30, 높을수록 품질↑ 속도↓)",
    )
    inpaint_grp.add_argument(
        "--guidance-scale",
        type=float,
        default=12.0,
        metavar="FLOAT",
        help="Guidance scale (기본값: 12.0, 높을수록 프롬프트 충실도↑)",
    )
    inpaint_grp.add_argument(
        "--seed",
        type=int,
        default=42,
        metavar="INT",
        help="랜덤 시드 (재현성, 기본값: 42)",
    )
    inpaint_grp.add_argument(
        "--infer-size",
        type=int,
        default=512,
        metavar="INT",
        choices=[512, 768],
        help="SD 추론 해상도 (기본값: 512, SD 2.0 모델은 768 권장)",
    )

    # ── 큐브맵 / 면 선택 ────────────────────────
    cube_grp = parser.add_argument_group("큐브맵 설정")
    cube_grp.add_argument(
        "--face-size",
        type=int,
        default=0,
        metavar="INT",
        help=(
            "큐브맵 면 크기 px (기본값 0 = 입력 너비 / 4 자동 계산). "
            "높을수록 결과 선명도↑ 처리 시간↑"
        ),
    )
    cube_grp.add_argument(
        "--faces",
        default="front,back,right,left",
        metavar="NAMES",
        help=(
            "스테이징할 면 이름 (쉼표 구분). "
            "선택 가능: front,back,right,left,top,bottom "
            "(기본값: front,back,right,left — top/bottom 제외)"
        ),
    )
    cube_grp.add_argument(
        "--output-size",
        metavar="WxH",
        help="출력 등장방형도법 해상도 (예: 4096x2048). 미지정 시 입력과 동일",
    )

    # ── 마스크 ──────────────────────────────────
    mask_grp = parser.add_argument_group("마스크")
    mask_grp.add_argument(
        "--mask",
        metavar="PATH",
        help=(
            "사용자 정의 마스크 이미지 경로 (흰색=인페인팅, 검정=보존). "
            "미지정 시 자동 마스크 생성."
        ),
    )
    mask_grp.add_argument(
        "--staging-ratio",
        type=float,
        default=0.45,
        metavar="FLOAT",
        help="자동 마스크에서 수평 면 하단 인페인팅 비율 (기본값: 0.45)",
    )

    return parser.parse_args()


# ──────────────────────────────────────────────
# 헬퍼 함수
# ──────────────────────────────────────────────

def resolve_faces_to_stage(faces_str: str) -> List[int]:
    """'front,back,right' 형식 문자열 → 면 인덱스 목록"""
    name_to_idx = {name: idx for idx, name in enumerate(FACE_NAMES)}
    indices: List[int] = []
    for token in faces_str.split(","):
        token = token.strip().lower()
        if token not in name_to_idx:
            raise ValueError(
                f"알 수 없는 면 이름: '{token}'. "
                f"선택 가능: {list(name_to_idx.keys())}"
            )
        indices.append(name_to_idx[token])
    return indices


def parse_output_size(size_str: Optional[str]) -> Optional[tuple[int, int]]:
    """'4096x2048' → (2048, 4096) (H, W) 형식으로 변환"""
    if size_str is None:
        return None
    try:
        w, h = map(int, size_str.lower().split("x"))
        return (h, w)
    except ValueError:
        raise ValueError(f"output-size 형식이 잘못됐습니다: '{size_str}'. 예: 4096x2048")


def setup_logging(verbose: bool = True) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
        datefmt="%H:%M:%S",
    )


# ──────────────────────────────────────────────
# 메인 파이프라인
# ──────────────────────────────────────────────

def main() -> None:
    args = parse_args()
    setup_logging()
    log = logging.getLogger("main")

    t_start = time.time()

    # ── 1. 면 인덱스 파싱 ───────────────────────
    try:
        faces_to_stage = resolve_faces_to_stage(args.faces)
    except ValueError as e:
        log.error(str(e))
        sys.exit(1)

    log.info("스테이징 대상 면: %s", [FACE_NAMES[i] for i in faces_to_stage])

    # ── 2. 입력 이미지 / 큐브맵 준비 ──────────────
    if args.load_faces:
        # 사전 저장된 면 로드 (분할 단계 건너뜀)
        log.info("저장된 큐브맵 면 로드: %s", args.load_faces)
        faces = load_faces(args.load_faces)
        face_size = faces[0].shape[0]
        orig_h = face_size * 2
        orig_w = face_size * 4
    else:
        # 원본 등장방형도법 로드
        log.info("원본 이미지 로드: %s", args.input)
        equirect = load_equirect(args.input)
        orig_h, orig_w = equirect.shape[:2]
        log.info("원본 해상도: %d × %d", orig_w, orig_h)

        # 면 크기 결정 (지정 없으면 너비/4)
        face_size = args.face_size if args.face_size > 0 else orig_w // 4
        face_size = max(face_size, args.infer_size)  # 추론 해상도보다 작으면 안 됨
        log.info("큐브맵 면 크기: %d × %d", face_size, face_size)

        # 큐브맵 분할
        log.info("등장방형도법 → 큐브맵 6면 분할 중 ...")
        t0 = time.time()
        faces = equirect_to_cubemap(equirect, face_size=face_size)
        log.info("분할 완료 (%.1fs)", time.time() - t0)

        if args.save_faces:
            log.info("큐브맵 면 저장: %s", args.save_faces)
            save_faces(faces, args.save_faces, prefix="orig")

    # ── 3. 마스크 준비 ──────────────────────────
    if args.mask:
        log.info("사용자 마스크 로드: %s", args.mask)
        single_mask = load_mask(args.mask, face_size)
        masks = [single_mask.copy() for _ in range(6)]
    else:
        log.info("자동 마스크 생성 (staging_ratio=%.2f)", args.staging_ratio)
        masks = generate_default_masks(face_size, staging_ratio=args.staging_ratio)

    if args.save_faces:
        import os
        mask_dir = Path(args.save_faces)
        mask_dir.mkdir(parents=True, exist_ok=True)
        for idx, (mask, name) in enumerate(zip(masks, FACE_NAMES)):
            cv2.imwrite(str(mask_dir / f"mask_{name}.png"), mask)
        log.info("마스크 저장 완료: %s", args.save_faces)

    # ── 4. 파이프라인 로드 ──────────────────────
    log.info("SD 파이프라인 초기화 중 ...")
    log.info("  모델: %s", args.model)
    t0 = time.time()

    pipeline = StagingPipeline(
        model_id=args.model,
        device="cuda",
        use_xformers=not args.no_xformers,
    )
    log.info("파이프라인 로드 완료 (%.1fs)", time.time() - t0)

    # ── 5. LoRA 로드 ────────────────────────────
    if not args.no_lora:
        lora_path = Path(args.lora)
        if lora_path.exists():
            pipeline.load_lora(
                str(lora_path),
                lora_scale=args.lora_scale,
            )
        else:
            log.warning(
                "LoRA 파일을 찾을 수 없습니다: %s → LoRA 없이 진행합니다.",
                lora_path,
            )
    else:
        log.info("--no-lora 플래그: LoRA 사용하지 않음")

    # ── 6. 각 면 스테이징 ──────────────────────
    log.info("인페인팅 시작 (대상: %d 면) ...", len(faces_to_stage))
    log.info("  프롬프트: %s", args.prompt[:80] + ("..." if len(args.prompt) > 80 else ""))
    log.info("  strength=%.2f  steps=%d  guidance=%.1f  seed=%d",
             args.strength, args.steps, args.guidance_scale, args.seed)

    t0 = time.time()
    staged_faces = pipeline.stage_faces(
        faces=faces,
        masks=masks,
        prompt=args.prompt,
        negative_prompt=args.negative_prompt,
        faces_to_stage=faces_to_stage,
        strength=args.strength,
        num_inference_steps=args.steps,
        guidance_scale=args.guidance_scale,
        seed=args.seed,
        infer_size=args.infer_size,
    )
    log.info("인페인팅 완료 (%.1fs)", time.time() - t0)

    if args.save_faces:
        save_faces(staged_faces, args.save_faces, prefix="staged")
        log.info("스테이징된 면 저장 완료: %s", args.save_faces)

    # ── 7. 등장방형도법으로 병합 ────────────────
    output_size = parse_output_size(args.output_size)
    if output_size is None:
        output_size = (orig_h, orig_w)

    log.info("큐브맵 → 등장방형도법 병합 중 (출력: %dx%d) ...",
             output_size[1], output_size[0])
    t0 = time.time()
    result_equirect = cubemap_to_equirect(staged_faces, output_size=output_size)
    log.info("병합 완료 (%.1fs)", time.time() - t0)

    # ── 8. 저장 ────────────────────────────────
    save_equirect(result_equirect, args.output)
    log.info("결과 저장: %s", args.output)

    elapsed = time.time() - t_start
    log.info("=" * 50)
    log.info("전체 완료! 총 소요 시간: %.1f 초", elapsed)
    log.info("출력 파일: %s", Path(args.output).resolve())


if __name__ == "__main__":
    main()
