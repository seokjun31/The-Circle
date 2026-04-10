from functools import lru_cache
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # ── Database ──────────────────────────────────────────────────────────────
    DATABASE_URL: str = "postgresql+psycopg2://user:password@localhost:5432/the_circle"

    # ── JWT ───────────────────────────────────────────────────────────────────
    SECRET_KEY: str = "change-me-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 10080  # 7 days

    # ── AWS S3 ────────────────────────────────────────────────────────────────
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_REGION: str = "ap-northeast-2"
    S3_BUCKET_NAME: str = "the-circle-uploads"
    USE_S3: bool = False
    LOCAL_UPLOAD_DIR: str = "./uploads"

    # ── Image processing ──────────────────────────────────────────────────────
    DEFAULT_CREDIT_BALANCE: int = 10
    MAX_IMAGE_SIZE_MB: int = 20
    MAX_IMAGE_DIMENSION: int = 2048
    THUMBNAIL_SIZE: int = 400

    # ── ComfyUI Provider ──────────────────────────────────────────────────────
    # "runpod" (default) → RunPod Serverless
    # "local"            → self-hosted ComfyUI (same machine or LAN/other PC)
    COMFYUI_PROVIDER: str = "runpod"

    # ── RunPod Serverless ─────────────────────────────────────────────────────
    RUNPOD_API_KEY: str = ""
    RUNPOD_ENDPOINT_ID: str = ""
    USE_MOCK_AI: bool = False
    # MVP: 0 (Scale to Zero — $0 when idle, ~30-60s cold start)
    # Production: 1 (1 warm worker — instant response, ~$0.50/hr)
    RUNPOD_MIN_WORKERS: int = 0
    RUNPOD_TIMEOUT_DEFAULT: int = 120        # seconds for standard workflows
    RUNPOD_TIMEOUT_FINAL_RENDER: int = 300   # seconds for 2-stage SDXL render

    # ── Local / Self-hosted ComfyUI ───────────────────────────────────────────
    # URL of the ComfyUI instance (any machine reachable over HTTP)
    # Examples:
    #   http://localhost:8188           (same machine)
    #   http://192.168.1.100:8188       (LAN)
    #   http://your-tunnel.trycloudflare.com  (tunnelled)
    COMFYUI_LOCAL_URL: str = "http://localhost:8188"
    # Optional Bearer token (leave empty for unauthenticated ComfyUI)
    COMFYUI_LOCAL_API_KEY: str = ""

    # ── OAuth ─────────────────────────────────────────────────────────────────
    # Google OAuth 2.0
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""
    # Kakao OAuth 2.0
    KAKAO_CLIENT_ID: str = ""
    KAKAO_CLIENT_SECRET: str = ""
    # Where the frontend lives — used for OAuth redirect after login
    FRONTEND_URL: str = "http://localhost:3000"

    # ── Redis / Celery ────────────────────────────────────────────────────────
    REDIS_URL: str = "redis://localhost:6379/0"

    # ── Server ────────────────────────────────────────────────────────────────
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    DEBUG: bool = True
    ALLOWED_ORIGINS: str = "http://localhost:3000,http://localhost:5173"

    @property
    def allowed_origins_list(self) -> List[str]:
        return [o.strip() for o in self.ALLOWED_ORIGINS.split(",")]

    @property
    def max_image_bytes(self) -> int:
        return self.MAX_IMAGE_SIZE_MB * 1024 * 1024

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
