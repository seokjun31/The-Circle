"""
ui.py
─────
Streamlit UI 컴포넌트 모듈.

각 함수는 독립적인 UI 섹션을 렌더링하며, app.py 에서 조립하여 사용한다.

함수 목록:
  - render_sidebar()        → API 토큰·모델·고급설정 사이드바
  - render_upload_section() → 이미지 업로드 UI
  - render_canvas_section() → 마스킹 캔버스 UI
  - render_prompt_section() → 프롬프트·LoRA URL 입력 UI
  - render_result_section() → Before/After 결과 출력 UI

확장 포인트 (360도 파노라마 페이즈):
  - render_cubemap_section() 함수를 이 파일에 추가하면 앱 흐름에 쉽게 통합 가능.
"""

from __future__ import annotations

import io
from typing import Optional, Tuple

import streamlit as st
from PIL import Image

from api_client import MODELS, DEFAULT_MODEL_KEY, InpaintingParams


# ──────────────────────────────────────────────
# 1. 사이드바
# ──────────────────────────────────────────────

def render_sidebar() -> Tuple[str, str, InpaintingParams]:
    """
    사이드바에 API 토큰, 모델 선택, 고급 파라미터를 렌더링한다.

    Returns
    -------
    api_token : str
    model_key : str
    params : InpaintingParams  (프롬프트·LoRA 는 제외, 나머지 파라미터만 채워진 상태)
    """
    with st.sidebar:
        st.title("⚙️ 설정")

        # ── API 토큰 ───────────────────────────────────────────────
        st.subheader("🔑 Replicate API 토큰")
        api_token = st.text_input(
            "REPLICATE_API_TOKEN",
            type="password",
            placeholder="r8_xxxxxxxxxxxxxxxxxxxx",
            help=(
                "Replicate.com 에서 발급한 API 토큰을 입력하세요.\n"
                "환경변수로 미리 설정한 경우 비워두어도 됩니다."
            ),
        )

        st.divider()

        # ── 모델 선택 ──────────────────────────────────────────────
        st.subheader("🤖 AI 모델")
        model_key = st.selectbox(
            "Inpainting 모델",
            options=list(MODELS.keys()),
            index=0,
            help="SDXL 은 고품질 1024px, SD 1.5 는 빠르고 가벼운 512px 처리.",
        )

        st.divider()

        # ── 고급 파라미터 ──────────────────────────────────────────
        with st.expander("🔧 고급 파라미터", expanded=False):
            num_steps = st.slider(
                "추론 스텝 수",
                min_value=10,
                max_value=50,
                value=30,
                step=5,
                help="클수록 품질이 높지만 처리 시간이 길어집니다.",
            )
            guidance = st.slider(
                "Guidance Scale",
                min_value=1.0,
                max_value=20.0,
                value=8.0,
                step=0.5,
                help="프롬프트 충실도. 높을수록 프롬프트를 강하게 따릅니다 (7~12 권장).",
            )
            strength = st.slider(
                "Inpainting 강도",
                min_value=0.5,
                max_value=1.0,
                value=0.99,
                step=0.01,
                help="1.0 이면 마스크 영역을 완전히 재생성합니다.",
            )
            seed = st.number_input(
                "랜덤 시드",
                min_value=-1,
                max_value=2**31 - 1,
                value=42,
                help="-1 이면 매번 다른 결과가 생성됩니다.",
            )
            lora_scale = st.slider(
                "LoRA 강도",
                min_value=0.0,
                max_value=1.0,
                value=0.8,
                step=0.05,
                help="LoRA 스타일의 적용 세기 (0=적용 안 함, 1=최대 적용).",
            )

        st.divider()
        st.caption(
            "Virtual Staging MVP · Replicate API 기반\n\n"
            "다음 페이즈: 360도 파노라마 인페인팅"
        )

    params = InpaintingParams(
        prompt="",           # app.py 에서 채움
        num_inference_steps=int(num_steps),
        guidance_scale=float(guidance),
        strength=float(strength),
        seed=int(seed),
        lora_scale=float(lora_scale),
    )
    return api_token, model_key, params


# ──────────────────────────────────────────────
# 2. 이미지 업로드
# ──────────────────────────────────────────────

def render_upload_section() -> Optional[Image.Image]:
    """
    파일 업로더를 렌더링하고, 업로드된 이미지를 PIL.Image 로 반환한다.
    업로드가 없으면 None 을 반환.
    """
    st.subheader("📁 Step 1 · 인테리어 사진 업로드")
    uploaded_file = st.file_uploader(
        "JPG 또는 PNG 파일을 드래그하거나 클릭하여 선택하세요",
        type=["jpg", "jpeg", "png"],
        help="최대 200MB. 너무 큰 이미지는 자동으로 1024px 이하로 축소됩니다.",
    )
    if uploaded_file is None:
        return None

    from image_utils import load_uploaded_image, resize_to_fit
    image = load_uploaded_image(uploaded_file)
    image = resize_to_fit(image)

    st.success(f"업로드 완료: {image.width} × {image.height} px")
    return image


# ──────────────────────────────────────────────
# 3. 마스킹 캔버스
# ──────────────────────────────────────────────

def render_canvas_section(image: Image.Image):
    """
    streamlit-drawable-canvas 를 이용하여 마스킹 UI 를 렌더링한다.

    Parameters
    ----------
    image : PIL.Image.Image
        캔버스 배경으로 사용할 원본 이미지.

    Returns
    -------
    canvas_result : ComponentValue | None
        캔버스 컴포넌트의 결과 객체. image_data 속성에 numpy 배열이 담겨 있음.
    """
    st.subheader("🖌️ Step 2 · 변경할 영역 마스킹")
    st.info(
        "**브러쉬로 변경하고 싶은 부분을 색칠하세요.**  \n"
        "예: 벽지를 바꾸고 싶다면 벽면 전체를 덮어 칠하세요.  \n"
        "칠한 부분(흰색)만 AI 가 새롭게 생성합니다.",
        icon="ℹ️",
    )

    try:
        from streamlit_drawable_canvas import st_canvas  # type: ignore
    except ImportError:
        st.error(
            "streamlit-drawable-canvas 가 설치되지 않았습니다.  \n"
            "`pip install streamlit-drawable-canvas` 를 실행한 뒤 재시작하세요."
        )
        return None

    col_tool, col_size, col_opacity = st.columns(3)
    with col_tool:
        drawing_mode = st.selectbox(
            "도구",
            ["freedraw", "rect", "circle", "polygon"],
            index=0,
            help="freedraw=자유 브러쉬, rect/circle=도형 마스크",
        )
    with col_size:
        stroke_width = st.slider("브러쉬 크기", 5, 100, 30)
    with col_opacity:
        stroke_opacity = st.slider("불투명도", 0.1, 1.0, 0.7, step=0.05)

    # 캔버스 표시 크기: 이미지 비율 유지하며 최대 700px
    display_w = min(image.width, 700)
    display_h = int(image.height * display_w / image.width)

    canvas_result = st_canvas(
        fill_color=f"rgba(255, 255, 255, {stroke_opacity})",  # 흰색으로 마스킹
        stroke_width=stroke_width,
        stroke_color=f"rgba(255, 255, 255, {stroke_opacity})",
        background_image=image,
        update_streamlit=True,
        height=display_h,
        width=display_w,
        drawing_mode=drawing_mode,
        display_toolbar=True,
        key="masking_canvas",
    )

    return canvas_result


# ──────────────────────────────────────────────
# 4. 프롬프트 & LoRA 입력
# ──────────────────────────────────────────────

def render_prompt_section() -> Tuple[str, str, str]:
    """
    프롬프트, 부정 프롬프트, LoRA URL 입력 UI 를 렌더링한다.

    Returns
    -------
    prompt : str
        사용자 입력 프롬프트 (한국어 포함 가능).
    negative_prompt : str
        부정 프롬프트.
    lora_url : str
        LoRA safetensors URL (비어 있어도 됨).
    """
    st.subheader("✍️ Step 3 · 스타일 프롬프트 입력")

    prompt = st.text_area(
        "원하는 스타일을 자유롭게 입력하세요 (한국어/영어 모두 가능)",
        placeholder=(
            "예시 (한국어): 화이트 실크 벽지, 모던 미니멀 스타일\n"
            "예시 (영어): white silk wallpaper, modern minimalist style, "
            "high quality interior photography"
        ),
        height=100,
        help="한국어로 입력하면 자동으로 영어로 번역되어 AI 에 전달됩니다.",
    )

    negative_prompt = st.text_input(
        "부정 프롬프트 (생성 시 제외할 요소)",
        value=(
            "ugly, blurry, low quality, distorted, watermark, "
            "text, bad anatomy, worst quality"
        ),
        help="AI 가 생성하지 않았으면 하는 요소를 영어로 입력하세요.",
    )

    with st.expander("🔗 LoRA 모델 URL (선택 사항)", expanded=False):
        st.markdown(
            "자신이 만든 LoRA 모델의 HuggingFace URL 또는 "
            "Replicate 모델 URL 을 입력하면 해당 스타일이 추가로 적용됩니다.  \n"
            "비워두면 기본 SDXL 베이스 모델만 사용합니다."
        )
        lora_url = st.text_input(
            "LoRA safetensors URL",
            placeholder="https://huggingface.co/your-username/your-lora/resolve/main/lora.safetensors",
            help="HuggingFace 파일 직접 다운로드 URL (resolve/main/... 형식).",
        )

    return prompt.strip(), negative_prompt.strip(), lora_url.strip()


# ──────────────────────────────────────────────
# 5. 결과 출력
# ──────────────────────────────────────────────

def render_result_section(
    original: Image.Image,
    result: Image.Image,
    translated_prompt: str,
) -> None:
    """
    Before/After 비교 이미지와 다운로드 버튼을 렌더링한다.

    Parameters
    ----------
    original : PIL.Image.Image
        원본 이미지.
    result : PIL.Image.Image
        Inpainting 결과 이미지.
    translated_prompt : str
        AI 에 실제로 전달된 영어 프롬프트 (사용자 확인용).
    """
    st.subheader("🎨 결과 · Before / After 비교")

    if translated_prompt:
        st.caption(f"🔤 AI 에 전달된 프롬프트: `{translated_prompt}`")

    col_before, col_after = st.columns(2)
    with col_before:
        st.markdown("**Before (원본)**")
        st.image(original, use_container_width=True)
    with col_after:
        st.markdown("**After (스테이징 결과)**")
        st.image(result, use_container_width=True)

    st.divider()

    # 다운로드 버튼
    col_dl1, col_dl2 = st.columns(2)
    with col_dl1:
        st.download_button(
            label="⬇️ 결과 이미지 다운로드 (PNG)",
            data=_pil_to_bytes(result, "PNG"),
            file_name="virtual_staging_result.png",
            mime="image/png",
            use_container_width=True,
        )
    with col_dl2:
        from image_utils import make_before_after

        comparison = make_before_after(original, result)
        st.download_button(
            label="⬇️ Before/After 비교 이미지 다운로드",
            data=_pil_to_bytes(comparison, "PNG"),
            file_name="virtual_staging_comparison.png",
            mime="image/png",
            use_container_width=True,
        )


# ──────────────────────────────────────────────
# 내부 헬퍼
# ──────────────────────────────────────────────

def _pil_to_bytes(image: Image.Image, fmt: str = "PNG") -> bytes:
    buf = io.BytesIO()
    image.save(buf, format=fmt)
    return buf.getvalue()
