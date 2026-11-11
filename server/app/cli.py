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

    @app.cli.command("create-user")
    @click.option("--email", prompt=True, help="correo (es el usuario para entrar)")
    @click.option("--name", prompt=True, help="nombre que se muestra")
    @click.option("--role", type=click.Choice(["admin", "staff", "doctor"]), default="admin", show_default=True)
    @click.option("--doctor-id", type=int, default=None, help="obligatorio si el rol es doctor")
    @click.password_option(help="se pide oculta y con confirmacion (minimo 10 caracteres); nunca por argumento")
    def create_user_cmd(email, name, role, doctor_id, password):
        """Crea un usuario. Asi se crea el PRIMER administrador (despues, desde la web)."""
        from .agenda import AgendaError
        try:
            u = current_app.extensions["auth"].create_user(email=email, name=name, role=role, password=password,
                                                           doctor_id=doctor_id)
        except AgendaError as e:
            raise click.ClickException(e.detail or e.code)
        click.echo(f"usuario creado: id={u.id} correo={u.email} rol={u.role}")

    @app.cli.command("set-password")
    @click.option("--email", prompt=True)
    @click.password_option(help="la nueva contrasena, oculta y con confirmacion")
    def set_password_cmd(email, password):
        """Restablece la contrasena de un usuario (recuperar el acceso). Tambien lo desbloquea y cierra sus sesiones."""
        from .agenda import AgendaError
        auth = current_app.extensions["auth"]
        u = auth.find_by_email(email)
        if u is None:
            raise click.ClickException("no existe un usuario con ese correo")
        try:
            auth.update_user(u.id, {"password": password})
        except AgendaError as e:
            raise click.ClickException(e.detail or e.code)
        click.echo(f"contrasena actualizada para {u.email}")

    @app.cli.command("gen-token")
    def gen_token_cmd():
        """Imprime un token aleatorio (para BOT_TOKEN o para elegir el secreto del webhook). No se guarda en ningun lado."""
        import secrets
        click.echo(secrets.token_urlsafe(32))
