"""Initial schema — all Phase 1 tables

Revision ID: 0001
Revises: —
Create Date: 2024-01-01 00:00:00.000000

Tables created:
  users, projects, edit_layers, materials, furniture, credit_transactions

PostgreSQL ENUM types created:
  imagetype, projectstatus, layertype,
  materialcategory, furniturecategory, credittype
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── ENUM types ────────────────────────────────────────────────────────────
    image_type_enum = postgresql.ENUM(
        "single", "panorama_equirectangular", "panorama_cubemap",
        name="imagetype",
    )
    project_status_enum = postgresql.ENUM(
        "draft", "processing", "completed",
        name="projectstatus",
    )
    layer_type_enum = postgresql.ENUM(
        "wall", "floor", "ceiling", "furniture", "style",
        name="layertype",
    )
    material_category_enum = postgresql.ENUM(
        "wallpaper", "flooring", "ceiling", "tile", "paint",
        name="materialcategory",
    )
    furniture_category_enum = postgresql.ENUM(
        "sofa", "table", "chair", "bed", "shelf", "desk", "lighting", "etc",
        name="furniturecategory",
    )
    credit_type_enum = postgresql.ENUM(
        "purchase", "usage", "bonus", "refund",
        name="credittype",
    )

    for enum in [
        image_type_enum, project_status_enum, layer_type_enum,
        material_category_enum, furniture_category_enum, credit_type_enum,
    ]:
        enum.create(op.get_bind(), checkfirst=True)

    # ── users ─────────────────────────────────────────────────────────────────
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("credit_balance", sa.Integer(), nullable=False, server_default="10"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("is_admin", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)
    op.create_index("ix_users_id", "users", ["id"])

    # ── projects ──────────────────────────────────────────────────────────────
    op.create_table(
        "projects",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("original_image_url", sa.String(2048)),
        sa.Column("thumbnail_url", sa.String(2048)),
        # ★ 360도 파노라마 확장 대비 필드
        sa.Column("image_type", image_type_enum, nullable=False, server_default="single"),
        sa.Column("status", project_status_enum, nullable=False, server_default="draft"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
    )
    op.create_index("ix_projects_id", "projects", ["id"])
    op.create_index("ix_projects_user_id", "projects", ["user_id"])

    # ── edit_layers ───────────────────────────────────────────────────────────
    op.create_table(
        "edit_layers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("layer_type", layer_type_enum, nullable=False),
        sa.Column("parameters", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("result_image_url", sa.String(2048)),
        sa.Column("is_visible", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
    )
    op.create_index("ix_edit_layers_id", "edit_layers", ["id"])
    op.create_index("ix_edit_layers_project_id", "edit_layers", ["project_id"])

    # ── materials ─────────────────────────────────────────────────────────────
    op.create_table(
        "materials",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("category", material_category_enum, nullable=False),
        sa.Column("tile_image_url", sa.String(2048), nullable=False),
        sa.Column("normal_map_url", sa.String(2048)),
        sa.Column("tile_width_cm", sa.Float()),
        sa.Column("tile_height_cm", sa.Float()),
        sa.Column("brand", sa.String(100)),
        sa.Column("product_code", sa.String(100)),
        sa.Column("price_range", sa.String(100)),
        sa.Column("tags", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("style", sa.String(100)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
    )
    op.create_index("ix_materials_id", "materials", ["id"])
    op.create_index("ix_materials_category", "materials", ["category"])
    op.create_index("ix_materials_style", "materials", ["style"])

    # ── furniture ─────────────────────────────────────────────────────────────
    op.create_table(
        "furniture",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("category", furniture_category_enum, nullable=False),
        sa.Column("brand", sa.String(100)),
        sa.Column("product_name", sa.String(200)),
        sa.Column("product_url", sa.String(2048)),
        sa.Column("width_cm", sa.Float()),
        sa.Column("height_cm", sa.Float()),
        sa.Column("depth_cm", sa.Float()),
        sa.Column("image_url", sa.String(2048)),
        sa.Column("thumbnail_url", sa.String(2048)),
        sa.Column("tags", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("style", sa.String(100)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
    )
    op.create_index("ix_furniture_id", "furniture", ["id"])
    op.create_index("ix_furniture_category", "furniture", ["category"])
    op.create_index("ix_furniture_style", "furniture", ["style"])

    # ── credit_transactions ───────────────────────────────────────────────────
    op.create_table(
        "credit_transactions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("type", credit_type_enum, nullable=False),
        sa.Column("description", sa.String(500), nullable=False),
        sa.Column("feature_used", sa.String(100)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
    )
    op.create_index("ix_credit_transactions_id", "credit_transactions", ["id"])
    op.create_index("ix_credit_transactions_user_id", "credit_transactions", ["user_id"])


def downgrade() -> None:
    # Drop tables in reverse dependency order
    op.drop_table("credit_transactions")
    op.drop_table("furniture")
    op.drop_table("materials")
    op.drop_table("edit_layers")
    op.drop_table("projects")
    op.drop_table("users")

    # Drop ENUM types
    for name in [
        "credittype", "furniturecategory", "materialcategory",
        "layertype", "projectstatus", "imagetype",
    ]:
        op.execute(f"DROP TYPE IF EXISTS {name}")
