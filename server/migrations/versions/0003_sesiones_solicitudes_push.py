"""sesiones, solicitudes de cambio de horario y suscripciones push

F4: `sessions` (login por cookie; guarda el hash del token), `schedule_change_requests` (el doctor pide, el personal
decide) y `push_subscriptions` (Web Push del doctor).

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-10
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0003'
down_revision: Union[str, Sequence[str], None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Igual que en 0001: tablas siempre en utf8mb4 (la base de PythonAnywhere nace en utf8mb3).
MYSQL = dict(mysql_charset='utf8mb4', mysql_collate='utf8mb4_unicode_ci')


def upgrade() -> None:
    op.create_table('sessions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('csrf_token', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('last_seen_at', sa.DateTime(), nullable=False),
    sa.Column('expires_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_sessions_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_sessions')),
    sa.UniqueConstraint('token_hash', name=op.f('uq_sessions_token_hash')),
    **MYSQL
    )
    op.create_index('ix_sessions_expires_at', 'sessions', ['expires_at'], unique=False)
    op.create_index('ix_sessions_user_id', 'sessions', ['user_id'], unique=False)
    op.create_table('schedule_change_requests',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('doctor_id', sa.Integer(), nullable=False),
    sa.Column('weekly_hours', sa.JSON(), nullable=False),
    sa.Column('effective_from', sa.Date(), nullable=False),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.Column('status', sa.String(length=10), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('decided_by_id', sa.Integer(), nullable=True),
    sa.Column('decided_at', sa.DateTime(), nullable=True),
    sa.CheckConstraint("status IN ('pending', 'approved', 'rejected')", name=op.f('ck_schedule_change_requests_status')),
    sa.ForeignKeyConstraint(['decided_by_id'], ['users.id'], name=op.f('fk_schedule_change_requests_decided_by_id_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['doctor_id'], ['doctors.id'], name=op.f('fk_schedule_change_requests_doctor_id_doctors'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_schedule_change_requests')),
    **MYSQL
    )
    op.create_index('ix_schedule_change_requests_doctor_id', 'schedule_change_requests', ['doctor_id'], unique=False)
    op.create_index('ix_schedule_change_requests_status_id', 'schedule_change_requests', ['status', 'id'], unique=False)
    op.create_table('push_subscriptions',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('endpoint', sa.String(length=512), nullable=False),
    sa.Column('p256dh', sa.String(length=255), nullable=False),
    sa.Column('auth', sa.String(length=255), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_push_subscriptions_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_push_subscriptions')),
    sa.UniqueConstraint('endpoint', name=op.f('uq_push_subscriptions_endpoint')),
    **MYSQL
    )
    op.create_index('ix_push_subscriptions_user_id', 'push_subscriptions', ['user_id'], unique=False)


def downgrade() -> None:
    op.drop_table('push_subscriptions')
    op.drop_table('schedule_change_requests')
    op.drop_table('sessions')
