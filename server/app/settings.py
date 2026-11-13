"""Ajustes clave/valor. Hoy solo los interruptores del bot: UNO POR CANAL (WhatsApp, Messenger, Instagram).

Almacenamiento: WhatsApp conserva su clave de siempre (`bot_active`, asi un servidor ya desplegado no cambia de comportamiento
ni hay dos filas que puedan discrepar) y los otros dos canales usan `bot_active.facebook` y `bot_active.instagram`, que la migracion
0009 siembra APAGADOS. **Fallo cerrado:** un canal sin fila es `false`, nunca `true`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .agenda.audit import SYSTEM, Actor, audit
from .db import utcnow
from .models import CHANNELS, Setting, User

BOT_ACTIVE = "bot_active"  # la clave de WhatsApp (la de siempre)
CHANNEL_KEYS = {"whatsapp": BOT_ACTIVE, "facebook": "bot_active.facebook", "instagram": "bot_active.instagram"}
assert tuple(CHANNEL_KEYS) == CHANNELS


@dataclass(frozen=True)
class ChannelUpdate:
    updated_at: datetime | None
    updated_by: str | None  # nombre del usuario que lo cambio


@dataclass(frozen=True)
class BotSettings:
    """`active` es el interruptor de WhatsApp (compatibilidad) y `updated_at` / `updated_by` tambien: son los de ESE canal."""
    active: bool
    updated_at: datetime | None
    updated_by: str | None
    #: Siempre trae los tres canales. Un canal sin dato es `False`.
    channels: dict[str, bool] = field(default_factory=lambda: {c: False for c in CHANNELS})
    updates: dict[str, ChannelUpdate] = field(default_factory=lambda: {c: ChannelUpdate(None, None) for c in CHANNELS})


def get_bot_settings(s: Session, default: bool = False) -> BotSettings:
    """Los tres interruptores. `default` es solo el valor de WhatsApp cuando su fila no existe (los otros canales sin fila son `False`)."""
    rows = {r.key: r for r in s.scalars(select(Setting).where(Setting.key.in_(CHANNEL_KEYS.values())))}
    channels, updates = {}, {}
    for canal, key in CHANNEL_KEYS.items():
        row = rows.get(key)
        if row is None:
            channels[canal] = bool(default) if canal == "whatsapp" else False
            updates[canal] = ChannelUpdate(None, None)
            continue
        by = s.get(User, row.updated_by_id).name if row.updated_by_id else None
        channels[canal] = isinstance(row.value, (bool, int)) and bool(row.value)  # solo un true / 1 enciende: texto o NULL = apagado
        updates[canal] = ChannelUpdate(row.updated_at, by)
    wa = updates["whatsapp"]
    return BotSettings(channels["whatsapp"], wa.updated_at, wa.updated_by, channels, updates)


def _set_one(s: Session, canal: str, active: bool, actor: Actor) -> None:
    key = CHANNEL_KEYS[canal]
    row = s.get(Setting, key)
    if row is None:
        row = Setting(key=key, value=bool(active))
        s.add(row)
    row.value = bool(active)
    row.updated_at = utcnow()
    row.updated_by_id = actor.user_id
    # WhatsApp conserva el formato de siempre (`{"active": x}`, entidad `bot_active`); los otros canales llevan su canal en los datos.
    data = {"active": bool(active)} if canal == "whatsapp" else {"active": bool(active), "channel": canal}
    audit(s, actor, "bot.set_active", "setting", key, data)


def set_bot_channels(s: Session, changes: dict[str, bool], actor: Actor = SYSTEM) -> BotSettings:
    """Cambia SOLO los canales que vienen en `changes` (`{"facebook": True}`), una entrada de bitacora por canal. Participa en la
    transaccion de quien llama (no hace commit). Un canal desconocido o un valor que no sea booleano es `ValueError`."""
    for canal, active in changes.items():
        if canal not in CHANNEL_KEYS:
            raise ValueError(f"canal desconocido: {canal!r}")
        if not isinstance(active, bool):
            raise ValueError(f"el valor de {canal!r} debe ser verdadero o falso")
    for canal in CHANNELS:  # en orden fijo, para que la bitacora sea predecible
        if canal in changes:
            _set_one(s, canal, changes[canal], actor)
    s.flush()
    return get_bot_settings(s)


def set_bot_active(s: Session, active: bool, actor: Actor = SYSTEM, channel: str = "whatsapp") -> BotSettings:
    """Enciende/apaga el bot de UN canal (por defecto WhatsApp, la forma de siempre). Participa en la transaccion de quien llama."""
    return set_bot_channels(s, {channel: bool(active)}, actor)
