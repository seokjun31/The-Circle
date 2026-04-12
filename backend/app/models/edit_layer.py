import enum
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class LayerType(str, enum.Enum):
    wall = "wall"
    floor = "floor"
    ceiling = "ceiling"
    furniture = "furniture"
    style = "style"


class EditLayer(Base):
    __tablename__ = "edit_layers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    layer_type: Mapped[LayerType] = mapped_column(
        Enum(LayerType, name="layertype", create_type=True), nullable=False
    )
    # Stores rendering parameters, mask coordinates, material IDs, etc.
    parameters: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    result_image_url: Mapped[str | None] = mapped_column(String(2048))
    is_visible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Relationships
    project: Mapped["Project"] = relationship("Project", back_populates="layers")  # noqa: F821

    def __repr__(self) -> str:
        return f"<EditLayer id={self.id} type={self.layer_type} order={self.order}>"
