"""
app.py
──────
Virtual Staging MVP · Streamlit 메인 엔트리포인트

실행 방법:
  cd web_app
  streamlit run app.py

전체 파이프라인 흐름:
  1. 이미지 업로드          (ui.render_upload_section)
  2. 마스킹 캔버스          (ui.render_canvas_section)
  3. 스타일 참고 사진 업로드 (ui.render_reference_section)  ← NEW
  4. 텍스트 프롬프트 입력    (ui.render_prompt_section)
  5. [변환 시작] 버튼 클릭
     a. 스타일 모드 자동 감지 (api_client.detect_style_mode)
        - TEXT_ONLY      → SDXL Inpainting (텍스트 기반 마스크 인페인팅)
        - REFERENCE_ONLY → IP-Adapter SDXL → 마스크 합성
        - COMBINED       → IP-Adapter SDXL (텍스트+이미지 동시 조건화) → 마스크 합성
     b. 한국어 프롬프트 → 영어 자동 번역 (translator.translate_to_english)
     c. 캔버스 마스크 → 흑백 이진 마스크 (image_utils.canvas_to_mask)
     d. Replicate API 호출 (api_client.run_inpainting)
  6. Before/After 결과 출력 + 다운로드 (ui.render_result_section)
"""

from __future__ import annotations

import logging
import sys
import os

import streamlit as st

# web_app 디렉터리를 모듈 탐색 경로에 추가 (상대 import 지원)
sys.path.insert(0, os.path.dirname(__file__))

# ──────────────────────────────────────────────
# 로깅 설정 (Streamlit 터미널에 출력)
# ──────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────
# 페이지 기본 설정
# ──────────────────────────────────────────────
st.set_page_config(
    page_title="Virtual Staging MVP",
    page_icon="🛋️",
    layout="wide",
    initial_sidebar_state="expanded",
)


def main() -> None:
    # ── 헤더 ────────────────────────────────────────────────────────
    st.title("🛋️ Virtual Staging MVP")
    st.markdown(
        "인테리어 사진의 원하는 영역을 브러쉬로 칠하고, "
        "텍스트·참고 사진(또는 둘 다)으로 스타일을 지정하면 AI 가 해당 부분을 새롭게 디자인합니다.  \n"
        "**한국어 프롬프트 자동 번역 · 레퍼런스 이미지 IP-Adapter 지원**"
    )
    st.divider()

    # ── 사이드바 (API 토큰 · 모델 · 고급 파라미터) ──────────────────
    from ui import (
        render_sidebar,
        render_upload_section,
        render_canvas_section,
        render_reference_section,
        render_prompt_section,
        render_result_section,
    )

    api_token, model_key, base_params = render_sidebar()

    # ── Step 1: 이미지 업로드 ────────────────────────────────────────
    image = render_upload_section()

    if image is None:
        st.info("왼쪽에서 인테리어 사진을 업로드하면 마스킹 캔버스가 나타납니다.")
        _show_guide()
        return

    # ── Step 2: 마스킹 캔버스 ────────────────────────────────────────
    canvas_result = render_canvas_section(image)

    st.divider()

    # ── Step 3: 스타일 참고 사진 (IP-Adapter) ────────────────────────
    reference_image = render_reference_section()

    st.divider()

    # ── Step 4: 텍스트 프롬프트 입력 ────────────────────────────────
    prompt_raw, negative_prompt, lora_url = render_prompt_section()

    st.divider()

    # ── Step 5: 변환 시작 버튼 ──────────────────────────────────────
    # 텍스트 또는 레퍼런스 이미지 중 하나 이상 필요
    has_input = bool(prompt_raw) or (reference_image is not None)

    col_btn, col_warn = st.columns([1, 3])
    with col_btn:
        run_clicked = st.button(
            "🚀 변환 시작",
            type="primary",
            use_container_width=True,
            disabled=(not has_input),
        )
    if not has_input:
        col_warn.warning("Step 3 에서 참고 사진을 업로드하거나, Step 4 에서 프롬프트를 입력하세요.")

    if not run_clicked:
        return

    # ── 유효성 검사 ──────────────────────────────────────────────────
    if canvas_result is None or canvas_result.image_data is None:
        st.error("캔버스 데이터를 읽을 수 없습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.")
        return

    # ── 파이프라인 실행 ──────────────────────────────────────────────
    # 스타일 모드를 먼저 예측해서 스피너 메시지를 맞춤 표시
    from api_client import detect_style_mode, InpaintingParams, StyleMode

    _preview_params = InpaintingParams(prompt=prompt_raw, reference_image=reference_image)
    preview_mode = detect_style_mode(_preview_params)
    spinner_msgs = {
        StyleMode.TEXT_ONLY:      "📝 텍스트 기반 SDXL 인페인팅 실행 중... (30초~2분 소요)",
        StyleMode.REFERENCE_ONLY: "🖼️ IP-Adapter 스타일 학습 + 마스크 합성 중... (1~3분 소요)",
        StyleMode.COMBINED:       "✨ 텍스트+레퍼런스 혼합 IP-Adapter 실행 중... (1~3분 소요)",
    }

    with st.spinner(spinner_msgs[preview_mode]):

        # 5-a. 한국어 → 영어 번역
        from translator import translate_to_english
        translated_prompt = translate_to_english(prompt_raw)
        if translated_prompt != prompt_raw:
            st.info(f"🔤 프롬프트 번역 완료: **{prompt_raw}** → `{translated_prompt}`")

        # 5-b. 캔버스 마스크 → 흑백 마스크
        from image_utils import canvas_to_mask

        try:
            mask = canvas_to_mask(canvas_result.image_data)
        except ValueError as exc:
            st.error(f"마스크 오류: {exc}")
            return

        # 5-c. 파라미터 조립 (레퍼런스 이미지 포함)
        from api_client import run_inpainting

        params = InpaintingParams(
            prompt=translated_prompt,
            negative_prompt=negative_prompt,
            num_inference_steps=base_params.num_inference_steps,
            guidance_scale=base_params.guidance_scale,
            strength=base_params.strength,
            seed=base_params.seed,
            lora_url=lora_url,
            lora_scale=base_params.lora_scale,
            reference_image=reference_image,           # None 이면 TEXT_ONLY 모드
            ip_adapter_scale=base_params.ip_adapter_scale,
        )

        # 5-d. 스마트 라우팅 API 호출
        try:
            result_image, used_mode = run_inpainting(
                image=image,
                mask=mask,
                params=params,
                model_key=model_key,
                api_token=api_token if api_token else None,
            )
        except (ValueError, RuntimeError) as exc:
            st.error(f"오류 발생: {exc}")
            logger.exception("Inpainting 실패")
            return
        except Exception as exc:
            st.error(f"예기치 못한 오류: {exc}")
            logger.exception("예기치 못한 오류")
            return

    st.success("✅ 변환 완료!")
    st.divider()

    # ── Step 6: 결과 출력 ────────────────────────────────────────────
    render_result_section(
        original=image,
        result=result_image,
        translated_prompt=translated_prompt,
        mode=used_mode,
    )


def _show_guide() -> None:
    """첫 방문자를 위한 사용 가이드를 표시한다."""
    with st.expander("📖 사용 방법 (처음이시라면 펼쳐보세요)", expanded=True):
        st.markdown(
            """
            ### 사용 방법

            | 단계 | 설명 |
            |------|------|
            | **Step 1** | 좌측 업로더에서 인테리어 사진(JPG/PNG)을 업로드합니다. |
            | **Step 2** | 캔버스에서 변경하고 싶은 영역(벽, 바닥, 가구 등)을 브러쉬로 색칠합니다. |
            | **Step 3** | *(선택)* 원하는 스타일의 참고 사진을 업로드합니다. |
            | **Step 4** | *(선택)* 원하는 스타일을 한국어 또는 영어로 입력합니다. |
            | **Step 5** | [🚀 변환 시작] 버튼을 누르고 결과를 기다립니다. |
            | **Step 6** | Before/After 비교 이미지를 확인하고 다운로드합니다. |

            ### 프롬프트 예시
            - `화이트 실크 벽지, 모던 미니멀 스타일, 고급 인테리어`
            - `원목 마루 바닥, 북유럽 스타일`
            - `dark walnut hardwood floor, luxury interior photography`

            ### 스타일 모드 설명

            | 모드 | 조건 | 특징 |
            |------|------|------|
            | 📝 텍스트 전용 | Step 4 만 입력 | SDXL 인페인팅. 가장 빠름 |
            | 🖼️ 레퍼런스 전용 | Step 3 만 업로드 | IP-Adapter로 사진 색감·재질 자동 적용 |
            | ✨ 텍스트+레퍼런스 | 둘 다 입력 | IP-Adapter + 텍스트 동시 조건화. 가장 정밀 |

            ### 주의 사항
            - 처음 실행 시 Replicate API 가 모델을 로드하느라 **1~3분** 소요될 수 있습니다.
            - 사이드바에서 **Replicate API 토큰**을 반드시 입력하거나,
              `REPLICATE_API_TOKEN` 환경변수를 설정해야 합니다.
            - [Replicate.com](https://replicate.com) 에서 무료 토큰을 발급받을 수 있습니다.
            """
        )


if __name__ == "__main__":
    main()
