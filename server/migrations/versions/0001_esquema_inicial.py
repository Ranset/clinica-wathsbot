"""esquema inicial

Usuarios, doctores, consultorios, horarios, ausencias, citas, huecos (con los UNIQUE que evitan el doble uso),
ajustes, cola de webhooks y bitacora. Generada con `alembic revision --autogenerate` contra MySQL 8 y revisada a mano.

Revision ID: 0001
Revises:
Create Date: 2026-11-10
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0001'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Tablas SIEMPRE en utf8mb4: la base que crea PythonAnywhere (pestana Databases) nace en utf8mb3 y las tablas la heredan,
# y utf8mb3 no guarda emojis (comunes en los nombres de WhatsApp): el INSERT falla con 1366. Se fija aqui y no con ALTER DATABASE
# para no depender de permisos sobre la base. Otros motores (SQLite) ignoran las opciones `mysql_*`.
MYSQL = dict(mysql_charset='utf8mb4', mysql_collate='utf8mb4_unicode_ci')


def upgrade() -> None:
    op.create_table('clinic_hours',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('weekday', sa.Integer(), nullable=False),
    sa.Column('start_time', sa.Time(), nullable=False),
    sa.Column('end_time', sa.Time(), nullable=False),
    sa.CheckConstraint('start_time < end_time', name=op.f('ck_clinic_hours_interval')),
    sa.CheckConstraint('weekday BETWEEN 0 AND 6', name=op.f('ck_clinic_hours_weekday')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_clinic_hours')),
    **MYSQL
    )
    op.create_table('doctors',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('specialty', sa.String(length=120), nullable=False),
    sa.Column('aliases', sa.JSON(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('uses_clinic_hours', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_doctors')),
    sa.UniqueConstraint('name', name=op.f('uq_doctors_name')),
    **MYSQL
    )
    op.create_table('rooms',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=60), nullable=False),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_rooms')),
    sa.UniqueConstraint('name', name=op.f('uq_rooms_name')),
    **MYSQL
    )
    op.create_table('webhook_events',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('zernio_event_id', sa.String(length=128), nullable=False),
    sa.Column('event_type', sa.String(length=64), nullable=False),
    sa.Column('payload', sa.JSON(), nullable=False),
    sa.Column('status', sa.String(length=10), nullable=False),
    sa.Column('attempts', sa.Integer(), nullable=False),
    sa.Column('claimed_until', sa.DateTime(), nullable=True),
    sa.Column('last_error', sa.String(length=500), nullable=True),
    sa.Column('outcome', sa.String(length=32), nullable=True),
    sa.Column('received_at', sa.DateTime(), nullable=False),
    sa.Column('processed_at', sa.DateTime(), nullable=True),
    sa.CheckConstraint("status IN ('pending', 'claimed', 'done', 'failed', 'skipped')", name=op.f('ck_webhook_events_status')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_webhook_events')),
    sa.UniqueConstraint('zernio_event_id', name=op.f('uq_webhook_events_zernio_event_id')),
    **MYSQL
    )
    op.create_index('ix_webhook_events_status_id', 'webhook_events', ['status', 'id'], unique=False)

    op.create_table('doctor_hours',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('doctor_id', sa.Integer(), nullable=False),
    sa.Column('weekday', sa.Integer(), nullable=False),
    sa.Column('start_time', sa.Time(), nullable=False),
    sa.Column('end_time', sa.Time(), nullable=False),
    sa.CheckConstraint('start_time < end_time', name=op.f('ck_doctor_hours_interval')),
    sa.CheckConstraint('weekday BETWEEN 0 AND 6', name=op.f('ck_doctor_hours_weekday')),
    sa.ForeignKeyConstraint(['doctor_id'], ['doctors.id'], name=op.f('fk_doctor_hours_doctor_id_doctors'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_doctor_hours')),
    **MYSQL
    )
    op.create_index('ix_doctor_hours_doctor_id', 'doctor_hours', ['doctor_id'], unique=False)

    op.create_table('users',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('email', sa.String(length=254), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('role', sa.String(length=16), nullable=False),
    sa.Column('doctor_id', sa.Integer(), nullable=True),
    sa.Column('password_hash', sa.String(length=255), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('failed_logins', sa.Integer(), nullable=False),
    sa.Column('locked_until', sa.DateTime(), nullable=True),
    sa.Column('last_login_at', sa.DateTime(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.CheckConstraint("(role = 'doctor' AND doctor_id IS NOT NULL) OR (role <> 'doctor' AND doctor_id IS NULL)", name=op.f('ck_users_doctor_role')),
    sa.CheckConstraint("role IN ('admin', 'staff', 'doctor')", name=op.f('ck_users_role')),
    sa.ForeignKeyConstraint(['doctor_id'], ['doctors.id'], name=op.f('fk_users_doctor_id_doctors')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_users')),
    sa.UniqueConstraint('email', name=op.f('uq_users_email')),
    **MYSQL
    )
    op.create_table('appointments',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=8), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('source', sa.String(length=8), nullable=False),
    sa.Column('phone', sa.String(length=20), nullable=True),
    sa.Column('patient_name', sa.String(length=120), nullable=True),
    sa.Column('doctor_id', sa.Integer(), nullable=True),
    sa.Column('room_id', sa.Integer(), nullable=False),
    sa.Column('start_utc', sa.DateTime(), nullable=False),
    sa.Column('duration_minutes', sa.Integer(), nullable=False),
    sa.Column('notes', sa.String(length=500), nullable=True),
    sa.Column('created_by_id', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.Column('cancelled_at', sa.DateTime(), nullable=True),
    sa.CheckConstraint("kind IN ('session', 'block')", name=op.f('ck_appointments_kind')),
    sa.CheckConstraint("source IN ('manual', 'ai')", name=op.f('ck_appointments_source')),
    sa.CheckConstraint("status IN ('agendada', 'realizada', 'no_show', 'cancelada')", name=op.f('ck_appointments_status')),
    sa.CheckConstraint('duration_minutes > 0 AND duration_minutes % 30 = 0', name=op.f('ck_appointments_duration')),
    sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_appointments_created_by_id_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['doctor_id'], ['doctors.id'], name=op.f('fk_appointments_doctor_id_doctors')),
    sa.ForeignKeyConstraint(['room_id'], ['rooms.id'], name=op.f('fk_appointments_room_id_rooms')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_appointments')),
    **MYSQL
    )
    op.create_index('ix_appointments_doctor_id_start_utc', 'appointments', ['doctor_id', 'start_utc'], unique=False)
    op.create_index('ix_appointments_phone_start_utc', 'appointments', ['phone', 'start_utc'], unique=False)
    op.create_index('ix_appointments_start_utc', 'appointments', ['start_utc'], unique=False)

    op.create_table('audit_log',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('actor_kind', sa.String(length=8), nullable=False),
    sa.Column('actor_user_id', sa.Integer(), nullable=True),
    sa.Column('action', sa.String(length=48), nullable=False),
    sa.Column('entity_type', sa.String(length=32), nullable=False),
    sa.Column('entity_id', sa.String(length=32), nullable=True),
    sa.Column('data', sa.JSON(), nullable=True),
    sa.ForeignKeyConstraint(['actor_user_id'], ['users.id'], name=op.f('fk_audit_log_actor_user_id_users'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_audit_log')),
    **MYSQL
    )
    op.create_index('ix_audit_log_created_at', 'audit_log', ['created_at'], unique=False)
    op.create_index('ix_audit_log_entity_type_entity_id', 'audit_log', ['entity_type', 'entity_id'], unique=False)

    op.create_table('doctor_absences',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('doctor_id', sa.Integer(), nullable=False),
    sa.Column('start_utc', sa.DateTime(), nullable=False),
    sa.Column('end_utc', sa.DateTime(), nullable=False),
    sa.Column('reason', sa.String(length=200), nullable=True),
    sa.Column('created_by_id', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.CheckConstraint('start_utc < end_utc', name=op.f('ck_doctor_absences_interval')),
    sa.ForeignKeyConstraint(['created_by_id'], ['users.id'], name=op.f('fk_doctor_absences_created_by_id_users'), ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['doctor_id'], ['doctors.id'], name=op.f('fk_doctor_absences_doctor_id_doctors'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_doctor_absences')),
    **MYSQL
    )
    op.create_index('ix_doctor_absences_doctor_id_start_utc', 'doctor_absences', ['doctor_id', 'start_utc'], unique=False)

    op.create_table('settings',
    sa.Column('key', sa.String(length=64), nullable=False),
    sa.Column('value', sa.JSON(), nullable=True),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.Column('updated_by_id', sa.Integer(), nullable=True),
    sa.ForeignKeyConstraint(['updated_by_id'], ['users.id'], name=op.f('fk_settings_updated_by_id_users'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('key', name=op.f('pk_settings')),
    **MYSQL
    )
    op.create_table('appointment_blocks',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('appointment_id', sa.Integer(), nullable=False),
    sa.Column('doctor_id', sa.Integer(), nullable=True),
    sa.Column('room_id', sa.Integer(), nullable=False),
    sa.Column('slot_start', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['appointment_id'], ['appointments.id'], name=op.f('fk_appointment_blocks_appointment_id_appointments'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['doctor_id'], ['doctors.id'], name=op.f('fk_appointment_blocks_doctor_id_doctors')),
    sa.ForeignKeyConstraint(['room_id'], ['rooms.id'], name=op.f('fk_appointment_blocks_room_id_rooms')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_appointment_blocks')),
    sa.UniqueConstraint('doctor_id', 'slot_start', name='uq_block_doctor_slot'),
    sa.UniqueConstraint('room_id', 'slot_start', name='uq_block_room_slot'),
    **MYSQL
    )
    op.create_index('ix_appointment_blocks_appointment_id', 'appointment_blocks', ['appointment_id'], unique=False)
    op.create_index('ix_appointment_blocks_slot_start', 'appointment_blocks', ['slot_start'], unique=False)



def downgrade() -> None:
    # las tablas se llevan sus indices; se borran de hijas a padres
    op.drop_table('appointment_blocks')
    op.drop_table('settings')
    op.drop_table('doctor_absences')
    op.drop_table('audit_log')
    op.drop_table('appointments')
    op.drop_table('users')
    op.drop_table('doctor_hours')
    op.drop_table('webhook_events')
    op.drop_table('rooms')
    op.drop_table('doctors')
    op.drop_table('clinic_hours')
