"""
staging.py
──────────
Virtual Staging 파이프라인

• diffusers StableDiffusionInpaintPipeline (외부 API 없음, 100% 로컬)
• RTX 4060 Ti 8GB VRAM 최적화
    - torch.float16 추론
    - enable_model_cpu_offload()  → 사용하지 않는 모델 컴포넌트를 CPU로 오프로드
    - enable_xformers_memory_efficient_attention()  → 메모리 효율 Attention
    - enable_vae_slicing()  → VAE 디코딩 VRAM 절감
• LoRA 로드 (safetensors 형식, kohya/a1111 포맷 자동 감지)
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import numpy as np
import torch
from PIL import Image

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────
# 파이프라인 로딩
# ──────────────────────────────────────────────

class StagingPipeline:
    """
    StableDiffusionInpaintPipeline 래퍼.
    RTX 4060 Ti 8GB 에서 안정적으로 동작하도록 최적화되어 있다.

    Parameters
    ----------
    model_id : str
        Hugging Face 모델 ID 또는 로컬 경로.
        기본값: "runwayml/stable-diffusion-inpainting" (SD 1.5 기반)
    device : str
        "cuda" 또는 "cpu".
    use_xformers : bool
        xformers 메모리 효율 Attention 사용 여부.
        xformers 미설치 시 자동으로 비활성화.
    """

    def __init__(
        self,
        model_id: str = "runwayml/stable-diffusion-inpainting",
        device: str = "cuda",
        use_xformers: bool = True,
    ) -> None:
        self.device = device
        self._load_pipeline(model_id, use_xformers)

    # ------------------------------------------------------------------
    def _load_pipeline(self, model_id: str, use_xformers: bool) -> None:
        from diffusers import StableDiffusionInpaintPipeline

        logger.info("파이프라인 로딩 중: %s", model_id)

        self.pipe = StableDiffusionInpaintPipeline.from_pretrained(
            model_id,
            torch_dtype=torch.float16,   # fp16으로 VRAM 절반 절약
            safety_checker=None,         # 부동산 이미지는 safety checker 불필요
            requires_safety_checker=False,
        )

        # ── VRAM 최적화 1: CPU 오프로드 ──────────────────────────────
        # UNet/VAE/TextEncoder 를 필요할 때만 GPU 로 이동시킴
        # 단일 GPU 8GB 환경에서 OOM 방지에 핵심적인 설정
        try:
            self.pipe.enable_model_cpu_offload()
            logger.info("enable_model_cpu_offload() 적용됨")
        except RuntimeError as e:
            logger.warning(
                "enable_model_cpu_offload() 실패 (%s). "
                "accelerate 미설치로 인해 pipe.to(device) 로 대체합니다. "
                "pip install accelerate 로 설치하면 VRAM 을 추가 절약할 수 있습니다.",
                e,
            )
            self.pipe = self.pipe.to(self.device)

        # ── VRAM 최적화 2: VAE 슬라이싱 ──────────────────────────────
        # 고해상도 이미지 디코딩 시 VRAM 사용량 감소
        self.pipe.enable_vae_slicing()
        logger.info("enable_vae_slicing() 적용됨")

        # ── VRAM 최적화 3: xformers Attention ────────────────────────
        # Flash Attention 계열, Attention 연산 VRAM을 ~30% 감소
        if use_xformers:
            try:
                self.pipe.enable_xformers_memory_efficient_attention()
                logger.info("xformers 메모리 효율 Attention 적용됨")
            except Exception as e:
                logger.warning(
                    "xformers 를 활성화할 수 없습니다 (%s). "
                    "pip install xformers 로 설치하면 VRAM 을 추가 절약할 수 있습니다.",
                    e,
                )

        logger.info("파이프라인 로딩 완료")

    # ------------------------------------------------------------------
    def load_lora(
        self,
        lora_path: str,
        lora_scale: float = 0.8,
        adapter_name: str = "staging_lora",
    ) -> None:
        """
        LoRA 가중치를 로드한다.

        diffusers 는 kohya/a1111 형식과 diffusers 형식을 자동 감지한다.
        korean_apartment_v1.safetensors 처럼 로컬 .safetensors 파일을
        직접 지정하면 된다.

        Parameters
        ----------
        lora_path : str
            LoRA safetensors 파일 경로.
        lora_scale : float
            LoRA 적용 강도 (0.0 ~ 1.0). 높을수록 LoRA 스타일 강하게 반영.
        adapter_name : str
            내부에서 사용할 어댑터 이름.
        """
        lora_path = Path(lora_path)
        if not lora_path.exists():
            raise FileNotFoundError(f"LoRA 파일을 찾을 수 없습니다: {lora_path}")

        lora_dir = str(lora_path.parent)
        lora_file = lora_path.name

        logger.info("LoRA 로딩: %s (scale=%.2f)", lora_path, lora_scale)

        # diffusers >= 0.21: kohya / a1111 / diffusers 형식 자동 감지
        self.pipe.load_lora_weights(
            lora_dir,
            weight_name=lora_file,
            adapter_name=adapter_name,
        )

        # 어댑터 가중치 스케일 지정
        self.pipe.set_adapters([adapter_name], adapter_weights=[lora_scale])

        logger.info("LoRA 로딩 완료: adapter='%s'", adapter_name)

    # ------------------------------------------------------------------
    def stage_face(
        self,
        face_bgr: np.ndarray,
        mask_gray: np.ndarray,
        prompt: str,
        negative_prompt: str = "",
        strength: float = 0.85,
        num_inference_steps: int = 30,
        guidance_scale: float = 10.0,
        seed: int = 42,
        infer_size: int = 512,
    ) -> np.ndarray:
        """
        단일 큐브맵 면에 대해 inpainting 을 수행한다.

        Parameters
        ----------
        face_bgr : np.ndarray
            H×W×3 BGR 이미지 (원본 face 크기).
        mask_gray : np.ndarray
            H×W uint8 마스크. 흰색(255) = 인페인팅 영역, 검정(0) = 보존.
        prompt : str
            인테리어 스타일 프롬프트.
        negative_prompt : str
            부정 프롬프트.
        strength : float
            인페인팅 강도 (0.0 ~ 1.0).
        num_inference_steps : int
            디노이징 스텝 수.
        guidance_scale : float
            Classifier-free guidance 스케일.
        seed : int
            재현성을 위한 랜덤 시드.
        infer_size : int
            SD 추론 해상도 (SD 1.5 기본값 512, SD 2.0 권장 768).

        Returns
        -------
        np.ndarray
            face_bgr 와 동일 크기의 BGR 스테이징 결과 이미지.
        """
        orig_h, orig_w = face_bgr.shape[:2]

        # BGR → RGB PIL 변환 + 추론 해상도로 리사이즈
        pil_image = Image.fromarray(
            cv2.cvtColor(face_bgr, cv2.COLOR_BGR2RGB)
        ).resize((infer_size, infer_size), Image.LANCZOS)

        pil_mask = Image.fromarray(mask_gray).resize(
            (infer_size, infer_size), Image.NEAREST
        )

        generator = torch.Generator(device="cpu").manual_seed(seed)

        result = self.pipe(
            prompt=prompt,
            negative_prompt=negative_prompt,
            image=pil_image,
            mask_image=pil_mask,
            height=infer_size,
            width=infer_size,
            strength=strength,
            num_inference_steps=num_inference_steps,
            guidance_scale=guidance_scale,
            generator=generator,
        ).images[0]

        # 추론 해상도 → 원본 면 크기로 복원
        result_resized = result.resize((orig_w, orig_h), Image.LANCZOS)

        return cv2.cvtColor(np.array(result_resized), cv2.COLOR_RGB2BGR)

    # ------------------------------------------------------------------
    def stage_faces(
        self,
        faces: List[np.ndarray],
        masks: List[np.ndarray],
        prompt: str,
        negative_prompt: str = "",
        faces_to_stage: Optional[List[int]] = None,
        strength: float = 0.85,
        num_inference_steps: int = 30,
        guidance_scale: float = 10.0,
        seed: int = 42,
        infer_size: int = 512,
    ) -> List[np.ndarray]:
        """
        6장 큐브맵 면에 대해 순차적으로 inpainting 을 수행한다.

        Parameters
        ----------
        faces : List[np.ndarray]
            [front, back, right, left, top, bottom] 6장 BGR 이미지.
        masks : List[np.ndarray]
            각 면에 대응하는 마스크 6장.
        faces_to_stage : List[int] | None
            스테이징할 면 인덱스 목록.
            기본값: [0, 1, 2, 3, 5]  (front/back/right/left/bottom, 천장 제외)
        (나머지 파라미터는 stage_face 와 동일)

        Returns
        -------
        List[np.ndarray]
            스테이징된 6장 face 이미지. 스테이징하지 않은 면은 원본 유지.
        """
        if faces_to_stage is None:
            # 기본: 천장(top, idx=4) 제외하고 스테이징
            faces_to_stage = [0, 1, 2, 3, 5]

        result_faces = list(faces)  # 원본 복사

        for idx in range(6):
            face_name = ["front", "back", "right", "left", "top", "bottom"][idx]
            if idx not in faces_to_stage:
                logger.info("[%s] 스테이징 건너뜀 (faces_to_stage 에 미포함)", face_name)
                continue

            logger.info("[%s] 인페인팅 시작 ...", face_name)
            # 면마다 고유 시드 사용: seed + idx * 1000 으로 재현성 유지하면서
            # 동일 면에 대해 항상 같은 결과를 보장
            face_seed = seed + idx * 1000
            staged = self.stage_face(
                face_bgr=faces[idx],
                mask_gray=masks[idx],
                prompt=prompt,
                negative_prompt=negative_prompt,
                strength=strength,
                num_inference_steps=num_inference_steps,
                guidance_scale=guidance_scale,
                seed=face_seed,
                infer_size=infer_size,
            )
            result_faces[idx] = staged
            logger.info("[%s] 인페인팅 완료", face_name)

        return result_faces


# ──────────────────────────────────────────────
# 마스크 생성 유틸리티
# ──────────────────────────────────────────────

def generate_default_masks(
    face_size: int,
    staging_ratio: float = 0.65,
) -> List[np.ndarray]:
    """
    큐브맵 6면에 대한 기본 인페인팅 마스크를 생성한다.

    규칙
    ----
    - front / back / right / left (0~3): 하단 staging_ratio 비율 흰색 (가구 영역)
    - top   (4): 전부 검정 (천장은 스테이징 제외)
    - bottom (5): 전부 흰색 (바닥 전체 스테이징)

    마스크 형식: uint8, 흰색(255)=인페인팅, 검정(0)=보존

    Parameters
    ----------
    face_size : int
        각 면의 픽셀 크기.
    staging_ratio : float
        수평 면에서 하단 몇 비율을 스테이징할지 (0.0 ~ 1.0).

    Returns
    -------
    List[np.ndarray]
        6장의 face_size×face_size uint8 마스크.
    """
    masks: List[np.ndarray] = []
    cutoff = int(face_size * (1.0 - staging_ratio))  # 이 행 위로는 검정
    feather = max(face_size // 16, 4)

    for idx in range(6):
        mask = np.zeros((face_size, face_size), dtype=np.uint8)

        if idx == 4:
            # 천장: 전부 검정 (스테이징 안 함)
            pass
        elif idx == 5:
            # 바닥(bottom): 상단부만 약하게 스테이징 (원본 구조 최대한 보존)
            # 전체 흰색으로 하면 원본 공간과 전혀 다른 이미지가 생성되어 왜곡됨
            bottom_cutoff = int(face_size * 0.3)  # 상단 30% 만 스테이징
            mask[bottom_cutoff:, :] = 255
            for row in range(max(bottom_cutoff - feather, 0), min(bottom_cutoff + feather, face_size)):
                alpha = (row - (bottom_cutoff - feather)) / (2 * feather)
                mask[row, :] = int(np.clip(alpha, 0.0, 1.0) * 255)
        else:
            # 수평 4면: 상단은 검정(벽/천장), 하단은 흰색(가구 영역)
            mask[cutoff:, :] = 255
            # 상단~하단 경계를 부드럽게 블렌딩 (자연스러운 전환)
            for row in range(max(cutoff - feather, 0), min(cutoff + feather, face_size)):
                alpha = (row - (cutoff - feather)) / (2 * feather)
                alpha = float(np.clip(alpha, 0.0, 1.0))
                mask[row, :] = int(alpha * 255)

        masks.append(mask)

    return masks


def load_mask(mask_path: str, face_size: int) -> np.ndarray:
    """
    사용자 제공 마스크를 로드하고 face_size 로 리사이즈한다.
    그레이스케일로 변환하며, 흰색=인페인팅 / 검정=보존 규약을 따른다.
    """
    mask = cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE)
    if mask is None:
        raise FileNotFoundError(f"마스크 파일을 열 수 없습니다: {mask_path}")
    if mask.shape[0] != face_size or mask.shape[1] != face_size:
        mask = cv2.resize(mask, (face_size, face_size), interpolation=cv2.INTER_NEAREST)
    return mask
