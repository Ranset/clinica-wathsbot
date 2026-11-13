"""canales de mensajeria: Messenger e Instagram ademas de WhatsApp

La identidad de quien escribe pasa de ser un telefono de WhatsApp a la pareja (`channel`, `contact_id`). En WhatsApp sigue siendo el
telefono (`phone`); en `facebook` / `instagram` es el id de Meta (PSID / IGSID), que NO es un telefono ni un dato verificado, y `phone`
pasa a ser solo el telefono de CONTACTO que dio el paciente.

- `appointments`: `channel` (NOT NULL, por defecto `whatsapp`, CHECK en los tres canales), `contact_id` (NULL) e indice
  `(channel, contact_id, start_utc)`. Las filas existentes quedan `whatsapp` con `contact_id` NULL (su identidad sigue siendo `phone`).
- `attention_cases`: `channel` (NOT NULL, por defecto `whatsapp`) y `contact_id` (NULL).
- `settings`: se siembran los interruptores `bot_active.facebook` e `bot_active.instagram` APAGADOS. El de WhatsApp conserva su clave de
  siempre (`bot_active`) y su valor: la migracion no enciende ni apaga nada.

Al bajar: se quitan las columnas, el indice, el CHECK y los dos interruptores. Las citas de Messenger / Instagram dejarian de tener
identidad y su `phone` pasaria a leerse como si fuera un WhatsApp, asi que antes se pasa ese telefono de contacto a las notas
y se deja `phone` en NULL: ninguna persona de WhatsApp puede ver por error la cita de otro canal.

En SQLite las restricciones obligan a reescribir la tabla (modo batch); en MySQL son ALTER directos.

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-12
"""
from datetime import datetime, timezone
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0009'
down_revision: Union[str, Sequence[str], None] = '0008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CHANNEL_CHECK = "channel IN ('whatsapp', 'facebook', 'instagram')"
NEW_KEYS = ("bot_active.facebook", "bot_active.instagram")

_settings = sa.table('settings', sa.column('key', sa.String), sa.column('value', sa.JSON), sa.column('updated_at', sa.DateTime),
                     sa.column('updated_by_id', sa.Integer))
_appointments = sa.table('appointments', sa.column('id', sa.Integer), sa.column('channel', sa.String), sa.column('contact_id', sa.String),
                         sa.column('phone', sa.String), sa.column('notes', sa.String))


def upgrade() -> None:
    with op.batch_alter_table('appointments') as batch:
        batch.add_column(sa.Column('channel', sa.String(length=12), nullable=False, server_default='whatsapp'))
        batch.add_column(sa.Column('contact_id', sa.String(length=64), nullable=True))
        batch.create_check_constraint(op.f('ck_appointments_channel'), CHANNEL_CHECK)
        batch.create_index('ix_appointments_channel_contact_id_start_utc', ['channel', 'contact_id', 'start_utc'])
    with op.batch_alter_table('attention_cases') as batch:
        batch.add_column(sa.Column('channel', sa.String(length=12), nullable=False, server_default='whatsapp'))
        batch.add_column(sa.Column('contact_id', sa.String(length=64), nullable=True))

    # Interruptores nuevos: APAGADOS. El de WhatsApp (`bot_active`) no se toca.
    bind = op.get_bind()
    existing = {r[0] for r in bind.execute(sa.select(_settings.c.key).where(_settings.c.key.in_(NEW_KEYS)))}
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for key in NEW_KEYS:
        if key not in existing:
            bind.execute(sa.insert(_settings).values(key=key, value=False, updated_at=now, updated_by_id=None))


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(sa.delete(_settings).where(_settings.c.key.in_(NEW_KEYS)))
    # El telefono de contacto de una cita de Messenger / Instagram no puede quedar como si fuera la identidad de un WhatsApp.
    rows = bind.execute(sa.select(_appointments.c.id, _appointments.c.phone, _appointments.c.notes)
                        .where(_appointments.c.channel != 'whatsapp')).all()
    for id_, phone, notes in rows:
        if phone:
            nota = ((notes + " · ") if notes else "") + f"Contacto: {phone}"
            bind.execute(sa.update(_appointments).where(_appointments.c.id == id_).values(notes=nota[:500], phone=None))

    with op.batch_alter_table('attention_cases') as batch:
        batch.drop_column('contact_id')
        batch.drop_column('channel')
    with op.batch_alter_table('appointments') as batch:
        batch.drop_index('ix_appointments_channel_contact_id_start_utc')
        batch.drop_constraint(op.f('ck_appointments_channel'), type_='check')
        batch.drop_column('contact_id')
        batch.drop_column('channel')
