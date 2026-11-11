"""Comandos de Flask: `flask --app wsgi seed`, `flask --app wsgi upgrade-db`."""
from __future__ import annotations

import click
from flask import Flask, current_app


def register_cli(app: Flask) -> None:
    @app.cli.command("seed")
    @click.option("--config", "config_path", type=click.Path(exists=True, dir_okay=False),
                  help="agenda_config.json (por defecto bot/agenda_config.json)")
    @click.option("--bot-active/--bot-inactive", default=False, help="estado inicial del interruptor del bot")
    def seed_cmd(config_path, bot_active):
        """Carga doctores, consultorios y horario de la clinica (idempotente)."""
        from .seed import load_agenda_config, seed
        sf = current_app.extensions["db"].session_factory
        with sf() as s, s.begin():
            made = seed(s, load_agenda_config(config_path), bot_active=bot_active)
        click.echo("seed: " + ", ".join(f"{k}={v}" for k, v in made.items()))

    @app.cli.command("upgrade-db")
    def upgrade_db_cmd():
        """Aplica las migraciones de Alembic (equivale a `alembic upgrade head`)."""
        from .migrate import upgrade
        upgrade(current_app.config["DATABASE_URL"])
        click.echo("migraciones al dia")
