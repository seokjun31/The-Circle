"""
RunPod Serverless Handler: Background Removal with rembg

Input:
    { "image": "<base64-encoded image>" }

Output:
    { "image": "<base64-encoded transparent PNG with background removed>" }
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
