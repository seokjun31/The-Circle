"""
Celery 비동기 작업 정의

현재 정의된 작업:
  - render_image: RunPod에 렌더링 요청 후 결과 폴링
"""

from app.celery_app import celery_app


@celery_app.task(bind=True, max_retries=3, default_retry_delay=10)
def render_image(self, project_id: int, payload: dict) -> dict:
    """
    RunPod Serverless 렌더링 비동기 작업.
    백엔드 routers/final_render.py 에서 호출됩니다.
    """
    try:
        import httpx
        from app.config import settings

        if not settings.RUNPOD_API_KEY or not settings.RUNPOD_ENDPOINT_ID:
            # Mock 모드: 실제 RunPod 없이 반환
            return {"status": "mock", "project_id": project_id}

        endpoint_url = f"https://api.runpod.io/v2/{settings.RUNPOD_ENDPOINT_ID}/run"
        headers = {"Authorization": f"Bearer {settings.RUNPOD_API_KEY}"}

        with httpx.Client(timeout=settings.RUNPOD_TIMEOUT_FINAL_RENDER) as client:
            response = client.post(endpoint_url, json=payload, headers=headers)
            response.raise_for_status()
            return response.json()

    except Exception as exc:
        raise self.retry(exc=exc)
