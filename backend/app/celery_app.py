from celery import Celery

from app.config import settings

celery_app = Celery(
    "the_circle",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
    include=["app.tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="Asia/Seoul",
    enable_utc=True,
    task_track_started=True,
    # 작업 재시도 설정
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    # 결과 만료 (24시간)
    result_expires=86400,
)
