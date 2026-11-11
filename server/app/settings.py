"""Ajustes clave/valor. Hoy solo el interruptor del bot (`bot_active`)."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session

from .agenda.audit import SYSTEM, Actor, audit
from .db import utcnow
from .models import Setting, User

BOT_ACTIVE = "bot_active"


@dataclass(frozen=True)
class BotSettings:
    active: bool
    updated_at: datetime | None
    updated_by: str | None  # nombre del usuario que lo cambio


def get_bot_settings(s: Session, default: bool = False) -> BotSettings:
    row = s.get(Setting, BOT_ACTIVE)
    if row is None:
        return BotSettings(default, None, None)
    by = s.get(User, row.updated_by_id).name if row.updated_by_id else None
    return BotSettings(bool(row.value), row.updated_at, by)


def set_bot_active(s: Session, active: bool, actor: Actor = SYSTEM) -> BotSettings:
    """Enciende/apaga el bot. Participa en la transaccion de quien llama (no hace commit)."""
    row = s.get(Setting, BOT_ACTIVE)
    if row is None:
        row = Setting(key=BOT_ACTIVE, value=bool(active))
        s.add(row)
    row.value = bool(active)
    row.updated_at = utcnow()
    row.updated_by_id = actor.user_id
    audit(s, actor, "bot.set_active", "setting", BOT_ACTIVE, {"active": bool(active)})
    s.flush()
    return get_bot_settings(s)
