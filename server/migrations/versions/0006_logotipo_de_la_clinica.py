"""logotipo de la clinica

Agrega `clinic_logo` (una sola fila): la imagen cuadrada que sube el administrador. Es una tabla nueva: no toca datos existentes.
El nombre de la clinica se guarda en `settings` (`clinic_name`), que ya existe.

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-12
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision: str = '0006'
down_revision: Union[str, Sequence[str], None] = '0005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Igual que en 0001: tablas siempre en utf8mb4 (la base de PythonAnywhere nace en utf8mb3).
MYSQL = dict(mysql_charset='utf8mb4', mysql_collate='utf8mb4_unicode_ci')


def upgrade() -> None:
    op.create_table('clinic_logo',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('content_type', sa.String(length=20), nullable=False),
    # MEDIUMBLOB (16 MB) en MySQL: el BLOB normal solo guarda 64 KB y el logotipo puede pesar hasta 1 MB
    sa.Column('data', sa.LargeBinary().with_variant(mysql.MEDIUMBLOB(), 'mysql'), nullable=False),
    sa.Column('width', sa.Integer(), nullable=False),
    sa.Column('height', sa.Integer(), nullable=False),
    sa.Column('sha256', sa.String(length=64), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.Column('updated_by_id', sa.Integer(), nullable=True),
    sa.ForeignKeyConstraint(['updated_by_id'], ['users.id'], name=op.f('fk_clinic_logo_updated_by_id_users'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_clinic_logo')),
    **MYSQL
    )


def downgrade() -> None:
    op.drop_table('clinic_logo')
