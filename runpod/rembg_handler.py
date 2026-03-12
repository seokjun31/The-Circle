"""
[DEPRECATED] RunPod Serverless Handler: Background Removal with rembg

이 핸들러는 더 이상 사용되지 않습니다.
배경 제거 및 마스킹 단계는 ComfyUI 내 SAM2(Sam2Segmentation 노드)로 대체되었습니다.

파이프라인 변경 내역:
  - Before: 사용자 캔버스 → /api/remove-bg → rembg RunPod → 마스크 반환 → 렌더링
  - After:  사용자 캔버스에 러프 스트로크 → /api/render → ComfyUI SAM2 노드가
            정밀 마스크 추출 → 바로 Inpainting 진행

이 파일은 참고용으로 보존됩니다. 실제 RunPod 엔드포인트는 비활성화하세요.
"""

import base64
import io
import runpod
from rembg import remove
from PIL import Image


def handler(job: dict) -> dict:
    """
    Main RunPod job handler for background removal.
    """
    job_input = job.get("input", {})
    image_b64 = job_input.get("image")

    if not image_b64:
        return {"error": "입력 필드 'image'(base64)가 필요합니다."}

    # Decode input image
    try:
        image_bytes = base64.b64decode(image_b64)
        input_image = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    except Exception as e:
        return {"error": f"이미지 디코딩 오류: {str(e)}"}

    # Remove background
    try:
        output_image = remove(input_image)
    except Exception as e:
        return {"error": f"배경 제거 처리 오류: {str(e)}"}

    # Encode output as base64 PNG
    try:
        output_buffer = io.BytesIO()
        output_image.save(output_buffer, format="PNG")
        output_b64 = base64.b64encode(output_buffer.getvalue()).decode("utf-8")
    except Exception as e:
        return {"error": f"이미지 인코딩 오류: {str(e)}"}

    return {"image": output_b64}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
