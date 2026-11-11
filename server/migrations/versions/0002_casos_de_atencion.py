"""casos de atencion

Tabla `attention_cases`: lo que una persona debe atender (el bot paso la conversacion, un mensaje no se pudo
contestar tras varios intentos, o una ausencia afecta citas). La llena F3 (`/api/bot/handoffs` y la cola de
eventos) y la lista F4 (`/api/attention`).

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-10
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0002'
down_revision: Union[str, Sequence[str], None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Igual que en 0001: tablas siempre en utf8mb4 (la base de PythonAnywhere nace en utf8mb3).
MYSQL = dict(mysql_charset='utf8mb4', mysql_collate='utf8mb4_unicode_ci')


def upgrade() -> None:
    op.create_table('attention_cases',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=32), nullable=False),
    sa.Column('status', sa.String(length=10), nullable=False),
    sa.Column('conversation_id', sa.String(length=64), nullable=True),
    sa.Column('phone', sa.String(length=20), nullable=True),
    sa.Column('reason', sa.String(length=64), nullable=False),
    sa.Column('detail', sa.String(length=500), nullable=True),
    sa.Column('event_id', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('resolved_at', sa.DateTime(), nullable=True),
    sa.Column('resolved_by_id', sa.Integer(), nullable=True),
    sa.CheckConstraint("kind IN ('handoff', 'event_failed', 'absence_affects_appointments')", name=op.f('ck_attention_cases_kind')),
    sa.CheckConstraint("status IN ('open', 'resolved')", name=op.f('ck_attention_cases_status')),
    sa.ForeignKeyConstraint(['event_id'], ['webhook_events.id'], name=op.f('fk_attention_cases_event_id_webhook_events'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['resolved_by_id'], ['users.id'], name=op.f('fk_attention_cases_resolved_by_id_users'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_attention_cases')),
    **MYSQL
    )
    op.create_index('ix_attention_cases_conversation_id', 'attention_cases', ['conversation_id'], unique=False)
    op.create_index('ix_attention_cases_status_id', 'attention_cases', ['status', 'id'], unique=False)


def downgrade() -> None:
    op.drop_table('attention_cases')
