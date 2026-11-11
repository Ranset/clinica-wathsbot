"""Atajo para correr las migraciones de Alembic desde codigo (pruebas, `flask upgrade-db`)."""
from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config

from .config import SERVER_DIR


def alembic_config(url: str) -> Config:
    cfg = Config(str(SERVER_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(Path(SERVER_DIR / "migrations")))
    cfg.attributes["url"] = url  # no pasa por ConfigParser: las URL con '%' o '@' no se estropean
    return cfg


def upgrade(url: str, revision: str = "head") -> None:
    command.upgrade(alembic_config(url), revision)


def downgrade(url: str, revision: str = "base") -> None:
    command.downgrade(alembic_config(url), revision)
