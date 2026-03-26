"""Add room_type column to projects table

Revision ID: 0004
Revises: 0003
Create Date: 2024-01-04 00:00:00.000000

Changes:
  projects.room_type — VARCHAR(50) NULLABLE
      AI-detected room type (living room, master bedroom, etc.).
      NULL until analyzed; set by POST /api/v1/projects/{id}/analyze-room.
  projects.room_type_confidence — FLOAT NULLABLE
      Confidence score from the AI detection (0.0–1.0).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("room_type", sa.String(50), nullable=True),
    )
    op.add_column(
        "projects",
        sa.Column("room_type_confidence", sa.Float(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("projects", "room_type_confidence")
    op.drop_column("projects", "room_type")
