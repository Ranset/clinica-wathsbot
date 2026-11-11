"""Entorno de Alembic. URL: `cfg.attributes["url"]` (uso programatico) > `-x url=...` > DATABASE_URL > SQLite de desarrollo."""
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.config import resolve_database_url
from app.models import Base

config = context.config
if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _url() -> str:
    return (config.attributes.get("url") or context.get_x_argument(as_dictionary=True).get("url")
            or resolve_database_url())


def _configure(**kw):
    context.configure(
        target_metadata=target_metadata,
        compare_type=True,
        # SQLite no sabe ALTER de restricciones: Alembic reescribe la tabla en modo "batch" (en MySQL no hace falta)
        render_as_batch=True,
        **kw,
    )


def run_migrations_offline() -> None:
    _configure(url=_url(), literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    cfg = config.get_section(config.config_ini_section, {})
    cfg["sqlalchemy.url"] = _url().replace("%", "%%")
    engine = engine_from_config(cfg, prefix="sqlalchemy.", poolclass=pool.NullPool)
    with engine.connect() as connection:
        _configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
