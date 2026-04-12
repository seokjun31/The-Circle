"""
Storage service — S3 or local filesystem fallback.

• USE_S3=true  : files go to s3://{S3_BUCKET_NAME}/...
• USE_S3=false : files go to LOCAL_UPLOAD_DIR (for local dev)

S3 path convention:
  users/{user_id}/projects/{project_id}/original.jpg
  users/{user_id}/projects/{project_id}/resized.jpg
  users/{user_id}/projects/{project_id}/thumbnail.jpg
  materials/{material_id}/tile.png
"""
import logging
import time
from pathlib import Path
from typing import Optional

import boto3
from botocore.exceptions import ClientError

from app.config import settings

logger = logging.getLogger("the_circle.storage")

_S3_UPLOAD_MAX_RETRIES = 3


class StorageService:
    def __init__(self) -> None:
        self.use_s3 = settings.USE_S3 and bool(settings.AWS_ACCESS_KEY_ID)
        if self.use_s3:
            self._s3 = boto3.client(
                "s3",
                region_name=settings.AWS_REGION,
                aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
                aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
            )
            self._bucket = settings.S3_BUCKET_NAME
        else:
            # Local file storage
            self._local_dir = Path(settings.LOCAL_UPLOAD_DIR)
            self._local_dir.mkdir(parents=True, exist_ok=True)

    # ── Upload ────────────────────────────────────────────────────────────────

    def upload(
        self,
        data: bytes,
        key: str,
        content_type: str = "image/jpeg",
        public: bool = True,
    ) -> str:
        """
        Upload *data* and return the public URL.

        Args:
            key: storage path, e.g. "users/1/projects/2/original.jpg"
        """
        if self.use_s3:
            return self._upload_s3(data, key, content_type, public)
        return self._upload_local(data, key)

    def _upload_s3(self, data: bytes, key: str, content_type: str, public: bool) -> str:
        extra_args: dict = {"ContentType": content_type}
        if public:
            extra_args["ACL"] = "public-read"

        last_exc: Optional[Exception] = None
        backoff = 2
        for attempt in range(1, _S3_UPLOAD_MAX_RETRIES + 1):
            try:
                self._s3.put_object(
                    Bucket=self._bucket,
                    Key=key,
                    Body=data,
                    **extra_args,
                )
                return f"https://{self._bucket}.s3.{settings.AWS_REGION}.amazonaws.com/{key}"
            except ClientError as exc:
                last_exc = exc
                if attempt < _S3_UPLOAD_MAX_RETRIES:
                    logger.warning(
                        "S3 upload failed (attempt %d/%d): %s — retrying in %ds",
                        attempt, _S3_UPLOAD_MAX_RETRIES, exc, backoff,
                    )
                    time.sleep(backoff)
                    backoff *= 2

        raise RuntimeError(
            f"S3 upload failed after {_S3_UPLOAD_MAX_RETRIES} attempts"
        ) from last_exc

    def _upload_local(self, data: bytes, key: str) -> str:
        dest = self._local_dir / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        # Return a URL path that FastAPI will serve via StaticFiles
        return f"/uploads/{key}"

    # ── Presigned URL (S3 only) ───────────────────────────────────────────────

    def generate_presigned_put_url(
        self,
        key: str,
        content_type: str = "image/jpeg",
        expires_in: int = 3600,
    ) -> Optional[str]:
        """
        Generate a presigned S3 PUT URL for direct browser uploads.
        Returns None when running in local-storage mode.
        """
        if not self.use_s3:
            return None
        try:
            url = self._s3.generate_presigned_url(
                "put_object",
                Params={
                    "Bucket": self._bucket,
                    "Key": key,
                    "ContentType": content_type,
                },
                ExpiresIn=expires_in,
            )
            return url
        except ClientError:
            return None

    # ── Delete ────────────────────────────────────────────────────────────────

    def delete(self, key: str) -> None:
        if self.use_s3:
            try:
                self._s3.delete_object(Bucket=self._bucket, Key=key)
            except ClientError:
                pass
        else:
            path = self._local_dir / key
            if path.exists():
                path.unlink()

    # ── Key builders ──────────────────────────────────────────────────────────

    @staticmethod
    def project_key(user_id: int, project_id: int, filename: str) -> str:
        return f"users/{user_id}/projects/{project_id}/{filename}"

    @staticmethod
    def material_key(material_id: int, filename: str) -> str:
        return f"materials/{material_id}/{filename}"

    @staticmethod
    def furniture_key(furniture_id: int, filename: str) -> str:
        return f"furniture/{furniture_id}/{filename}"


# Singleton instance
storage = StorageService()
