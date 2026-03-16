"""Add AI generation params to materials table

Revision ID: 0003
Revises: 0002
Create Date: 2024-01-03 00:00:00.000000

Changes:
  materials.positive_prompt  — TEXT NOT NULL DEFAULT ''
      Optimised positive prompt for IP-Adapter / ComfyUI inference.
  materials.negative_prompt  — TEXT NOT NULL DEFAULT ''
      Optimised negative prompt to suppress conflicting attributes.
  materials.ip_adapter_weight — FLOAT NOT NULL DEFAULT 0.6
      Per-material IP-Adapter weight (range 0.3–0.9).
  materials.recommended_denoise — FLOAT NOT NULL DEFAULT 0.62
      Per-material KSampler denoise strength (range 0.5–0.75).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # positive_prompt — NOT NULL, existing rows get empty string
    op.add_column(
        "materials",
        sa.Column(
            "positive_prompt",
            sa.Text(),
            nullable=False,
            server_default="",
        ),
    )

    # negative_prompt — NOT NULL, existing rows get empty string
    op.add_column(
        "materials",
        sa.Column(
            "negative_prompt",
            sa.Text(),
            nullable=False,
            server_default="",
        ),
    )

    # ip_adapter_weight — NOT NULL, existing rows get 0.6
    op.add_column(
        "materials",
        sa.Column(
            "ip_adapter_weight",
            sa.Float(),
            nullable=False,
            server_default=sa.text("0.6"),
        ),
    )

    # recommended_denoise — NOT NULL, existing rows get 0.62
    op.add_column(
        "materials",
        sa.Column(
            "recommended_denoise",
            sa.Float(),
            nullable=False,
            server_default=sa.text("0.62"),
        ),
    )

    # Drop server_default after backfill so future inserts must be explicit
    # (application layer always provides values; DB default stays as safety net)
    # Note: we intentionally KEEP the server_default so that
    # any ad-hoc SQL inserts still work without supplying these columns.


def downgrade() -> None:
    op.drop_column("materials", "recommended_denoise")
    op.drop_column("materials", "ip_adapter_weight")
    op.drop_column("materials", "negative_prompt")
    op.drop_column("materials", "positive_prompt")
