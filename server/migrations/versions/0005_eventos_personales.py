"""eventos personales de los doctores

Agrega `doctor_personal_events`: lo que el doctor anota en su agenda (PWA). Bloquea su horario como una ausencia, pero
el titulo y las notas son privados del doctor. Es una tabla nueva: no toca datos existentes.

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-11
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0005'
down_revision: Union[str, Sequence[str], None] = '0004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Igual que en 0001: tablas siempre en utf8mb4 (la base de PythonAnywhere nace en utf8mb3).
MYSQL = dict(mysql_charset='utf8mb4', mysql_collate='utf8mb4_unicode_ci')


def upgrade() -> None:
    op.create_table('doctor_personal_events',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('doctor_id', sa.Integer(), nullable=False),
    sa.Column('title', sa.String(length=120), nullable=False),
    sa.Column('notes', sa.String(length=1000), nullable=True),
    sa.Column('start_utc', sa.DateTime(), nullable=False),
    sa.Column('end_utc', sa.DateTime(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.CheckConstraint('start_utc < end_utc', name=op.f('ck_doctor_personal_events_interval')),
    sa.ForeignKeyConstraint(['doctor_id'], ['doctors.id'], name=op.f('fk_doctor_personal_events_doctor_id_doctors'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_doctor_personal_events')),
    **MYSQL
    )
    op.create_index('ix_doctor_personal_events_doctor_id_start_utc', 'doctor_personal_events', ['doctor_id', 'start_utc'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_doctor_personal_events_doctor_id_start_utc', table_name='doctor_personal_events')
    op.drop_table('doctor_personal_events')
