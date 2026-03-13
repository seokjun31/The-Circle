"""
POST   /api/v1/projects              — 이미지 업로드 → S3 저장 + 썸네일 생성 → Project 생성
POST   /api/v1/projects/presign      — presigned S3 URL 발급 (직접 업로드 지원)
PUT    /api/v1/projects/{id}/confirm — presigned 업로드 완료 후 썸네일/DB 업데이트
GET    /api/v1/projects              — 내 프로젝트 목록 (페이지네이션)
GET    /api/v1/projects/{id}         — 프로젝트 상세 (레이어 포함)
DELETE /api/v1/projects/{id}         — 프로젝트 삭제
"""
import math
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.dependencies import get_current_user, get_db
from app.models.project import ImageType, Project, ProjectStatus
from app.models.user import User
from app.schemas.project import (
    PresignResponse,
    ProjectCreateRequest,
    ProjectDetailResponse,
    ProjectListResponse,
    ProjectResponse,
)
from app.services.image_processor import (
    ImageValidationError,
    make_thumbnail,
    resize_image,
    validate_image,
)
from app.services.s3 import storage

router = APIRouter(prefix="/projects", tags=["Projects"])

_PAGE_SIZE_DEFAULT = 12
_PAGE_SIZE_MAX = 50


# ── POST /projects — direct multipart upload ──────────────────────────────────
@router.post(
    "",
    response_model=ProjectResponse,
    status_code=status.HTTP_201_CREATED,
    summary="프로젝트 생성 (이미지 직접 업로드)",
)
def create_project(
    title: str = Form(..., min_length=1, max_length=200),
    image_type: ImageType = Form(ImageType.single),
    file: UploadFile = File(..., description="JPEG / PNG / WEBP, max 20 MB"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Multipart upload pipeline:
      1. Validate image (type, size)
      2. Resize to max 2048 px
      3. Generate 400 px square thumbnail
      4. Upload original + thumbnail to S3 (or local fallback)
      5. Create Project record (status=draft)
    """
    raw = file.file.read()
    content_type = file.content_type or ""

    # 1. Validate
    try:
        validate_image(raw, content_type)
    except ImageValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail={"message": str(exc), "code": "INVALID_IMAGE"})

    # Create project first to get an ID for the S3 path
    project = Project(
        user_id=current_user.id,
        title=title,
        image_type=image_type,
        status=ProjectStatus.draft,
    )
    db.add(project)
    db.flush()  # get project.id

    # 2. Resize
    resized, _ = resize_image(raw)

    # 3. Thumbnail
    thumbnail = make_thumbnail(raw)

    # 4. Upload
    orig_key  = storage.project_key(current_user.id, project.id, "original.jpg")
    thumb_key = storage.project_key(current_user.id, project.id, "thumbnail.jpg")

    original_url  = storage.upload(resized,   orig_key,  "image/jpeg")
    thumbnail_url = storage.upload(thumbnail, thumb_key, "image/jpeg")

    # 5. Update record
    project.original_image_url = original_url
    project.thumbnail_url      = thumbnail_url

    db.commit()
    db.refresh(project)
    return project


# ── POST /projects/presign — issue presigned PUT URL ─────────────────────────
@router.post(
    "/presign",
    response_model=PresignResponse,
    status_code=status.HTTP_201_CREATED,
    summary="presigned URL 발급 (프론트 직접 업로드)",
)
def presign_upload(
    body: ProjectCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Issues a presigned S3 PUT URL for direct browser uploads.
    1. Creates a Project record (status=draft, no image yet)
    2. Returns { project_id, upload_url, s3_key }
    3. Client uploads directly to S3 using upload_url
    4. Client calls PUT /projects/{id}/confirm to finalize
    """
    project = Project(
        user_id=current_user.id,
        title=body.title,
        image_type=body.image_type,
        status=ProjectStatus.draft,
    )
    db.add(project)
    db.flush()

    key      = storage.project_key(current_user.id, project.id, "original.jpg")
    presigned = storage.generate_presigned_put_url(key)

    if presigned is None:
        # Local mode: fall back to regular upload endpoint
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "message": "로컬 개발 환경에서는 presigned URL을 사용할 수 없습니다. "
                           "POST /projects 를 사용하세요.",
                "code": "PRESIGN_UNAVAILABLE",
            },
        )

    db.commit()
    db.refresh(project)

    return PresignResponse(
        project_id=project.id,
        upload_url=presigned,
        s3_key=key,
        expires_in=3600,
    )


# ── PUT /projects/{id}/confirm — finalize presigned upload ───────────────────
@router.put(
    "/{project_id}/confirm",
    response_model=ProjectResponse,
    summary="presigned 업로드 완료 확인 + 썸네일 생성",
)
def confirm_upload(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Called after the client has uploaded the image to S3 via presigned URL.
    Downloads the uploaded image, generates a thumbnail, and stores it.
    """
    project = _get_owned_project(project_id, current_user, db)

    if not project.original_image_url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"message": "업로드된 이미지가 없습니다.", "code": "NO_IMAGE"},
        )

    # Download the uploaded image to create a thumbnail
    import httpx

    try:
        response = httpx.get(project.original_image_url, timeout=30)
        response.raise_for_status()
        raw = response.content
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"message": f"이미지 다운로드 실패: {exc}", "code": "DOWNLOAD_FAILED"},
        )

    thumb_key     = storage.project_key(current_user.id, project.id, "thumbnail.jpg")
    thumbnail     = make_thumbnail(raw)
    thumbnail_url = storage.upload(thumbnail, thumb_key, "image/jpeg")

    project.thumbnail_url = thumbnail_url
    db.commit()
    db.refresh(project)
    return project


# ── GET /projects — paginated list ────────────────────────────────────────────
@router.get(
    "",
    response_model=ProjectListResponse,
    summary="내 프로젝트 목록",
)
def list_projects(
    page: int = 1,
    page_size: int = _PAGE_SIZE_DEFAULT,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    page_size = min(page_size, _PAGE_SIZE_MAX)
    offset    = (page - 1) * page_size

    q     = db.query(Project).filter(Project.user_id == current_user.id)
    total = q.count()
    items = (
        q.order_by(Project.created_at.desc())
        .offset(offset)
        .limit(page_size)
        .all()
    )

    return ProjectListResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=math.ceil(total / page_size) if total else 1,
    )


# ── GET /projects/{id} — detail with layers ───────────────────────────────────
@router.get(
    "/{project_id}",
    response_model=ProjectDetailResponse,
    summary="프로젝트 상세 (레이어 포함)",
)
def get_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return _get_owned_project(project_id, current_user, db)


# ── DELETE /projects/{id} ─────────────────────────────────────────────────────
@router.delete(
    "/{project_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="프로젝트 삭제",
)
def delete_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project = _get_owned_project(project_id, current_user, db)
    db.delete(project)
    db.commit()


# ── Helper ────────────────────────────────────────────────────────────────────
def _get_owned_project(project_id: int, user: User, db: Session) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"message": "프로젝트를 찾을 수 없습니다.", "code": "NOT_FOUND"},
        )
    if project.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"message": "접근 권한이 없습니다.", "code": "FORBIDDEN"},
        )
    return project
