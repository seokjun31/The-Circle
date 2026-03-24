import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ImageType(str, enum.Enum):
    """
    ★ 360도 파노라마 확장 대비 필드
    - single                  : 일반 단일 시점 사진
    - panorama_equirectangular: Insta360 등 전방위 카메라의 equirectangular 출력
    - panorama_cubemap        : 큐브맵 6-면 분리 형식
    """
    single = "single"
    panorama_equirectangular = "panorama_equirectangular"
    panorama_cubemap = "panorama_cubemap"


class ProjectStatus(str, enum.Enum):
    draft = "draft"
    processing = "processing"
    completed = "completed"
    error = "error"


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    original_image_url: Mapped[str | None] = mapped_column(String(2048))
    thumbnail_url: Mapped[str | None] = mapped_column(String(2048))

    # ★ 360도 파노라마 확장 대비 필드
    image_type: Mapped[ImageType] = mapped_column(
        Enum(ImageType, name="imagetype", create_type=True),
        nullable=False,
        default=ImageType.single,
    )
    status: Mapped[ProjectStatus] = mapped_column(
        Enum(ProjectStatus, name="projectstatus", create_type=True),
        nullable=False,
        default=ProjectStatus.draft,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    # Relationships
    user: Mapped["User"] = relationship("User", back_populates="projects")  # noqa: F821
    layers: Mapped[list["EditLayer"]] = relationship(  # noqa: F821
        "EditLayer",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="EditLayer.order",
    )

    def __repr__(self) -> str:
        return f"<Project id={self.id} title={self.title!r} type={self.image_type}>"
