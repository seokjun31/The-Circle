"""Add OAuth fields to users table

Revision ID: 0002
Revises: 0001
Create Date: 2024-01-02 00:00:00.000000

Changes:
  - users.hashed_password: NOT NULL → nullable (OAuth-only accounts)
  - users.oauth_provider: new VARCHAR(50) nullable column
  - users.oauth_id: new VARCHAR(255) nullable column + index
  - unique constraint: (oauth_provider, oauth_id)
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Make hashed_password nullable for OAuth-only users
    op.alter_column("users", "hashed_password", nullable=True)

    # Add OAuth provider/id columns
    op.add_column("users", sa.Column("oauth_provider", sa.String(50), nullable=True))
    op.add_column("users", sa.Column("oauth_id", sa.String(255), nullable=True))

    # Index on oauth_id for fast lookup during callback
    op.create_index("ix_users_oauth_id", "users", ["oauth_id"])

    # Unique constraint to prevent duplicate OAuth accounts
    op.create_unique_constraint(
        "uq_users_oauth", "users", ["oauth_provider", "oauth_id"]
    )


def downgrade() -> None:
    op.drop_constraint("uq_users_oauth", "users", type_="unique")
    op.drop_index("ix_users_oauth_id", table_name="users")
    op.drop_column("users", "oauth_id")
    op.drop_column("users", "oauth_provider")
    # Revert hashed_password to NOT NULL (only safe if no OAuth-only rows exist)
    op.alter_column("users", "hashed_password", nullable=False)
