"""cuenta de doctor sin correo ni contrasena + enlace para establecerla

Las cuentas de los doctores se crean solas al dar de alta al doctor, sin correo y sin contrasena: el doctor la establece con un
enlace que genera el personal. Por eso `users.email` y `users.password_hash` pasan a ser opcionales, y se agregan
`setup_token_hash` (SHA-256 del enlace vigente, unico) y `setup_expires_at`. No toca los datos existentes.

En SQLite, cambiar si una columna acepta NULL obliga a reescribir la tabla (modo batch; las pruebas comprueban que los CHECK de
`users` sobreviven). En MySQL es un ALTER directo.

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-12
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0008'
down_revision: Union[str, Sequence[str], None] = '0007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    with op.batch_alter_table('users') as batch:
        batch.alter_column('email', existing_type=sa.String(length=254), nullable=True)
        batch.alter_column('password_hash', existing_type=sa.String(length=255), nullable=True)
        batch.add_column(sa.Column('setup_token_hash', sa.String(length=64), nullable=True))
        batch.add_column(sa.Column('setup_expires_at', sa.DateTime(), nullable=True))
        batch.create_unique_constraint(op.f('uq_users_setup_token_hash'), ['setup_token_hash'])


def downgrade() -> None:
    # Las columnas vuelven a ser obligatorias: las cuentas sin correo o sin contrasena reciben valores que no sirven para entrar.
    bind = op.get_bind()
    bind.execute(sa.text("UPDATE users SET email = 'sin-correo-' || id || '@invalido.invalid' WHERE email IS NULL"))
    bind.execute(sa.text("UPDATE users SET password_hash = '!' WHERE password_hash IS NULL"))
    with op.batch_alter_table('users') as batch:
        batch.drop_constraint(op.f('uq_users_setup_token_hash'), type_='unique')
        batch.drop_column('setup_expires_at')
        batch.drop_column('setup_token_hash')
        batch.alter_column('password_hash', existing_type=sa.String(length=255), nullable=False)
        batch.alter_column('email', existing_type=sa.String(length=254), nullable=False)
