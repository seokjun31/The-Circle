import os
import sys
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

# ── Path setup ────────────────────────────────────────────────────────────────
# Allow imports from the project root (backend/)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ── Load all models so Base.metadata is fully populated ──────────────────────
from app.database import Base  # noqa: E402 — must come after sys.path setup
import app.models  # noqa: F401 — registers all ORM classes with Base.metadata

# ── Alembic config object ─────────────────────────────────────────────────────
config = context.config

# Override sqlalchemy.url from .env / environment variable if present
from app.config import settings  # noqa: E402
config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)

# Logging from alembic.ini
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


# ── Run migrations ────────────────────────────────────────────────────────────
def run_migrations_offline() -> None:
    """Emit SQL to stdout without connecting."""
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Apply migrations to the live database."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
