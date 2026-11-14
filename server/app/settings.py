"""Ajustes clave/valor. Hoy los interruptores del bot: UNO POR CANAL (WhatsApp, Messenger, Instagram), cada uno en modo `manual` o `schedule`.

Almacenamiento: WhatsApp conserva su clave de siempre (`bot_active`, asi un servidor ya desplegado no cambia de comportamiento
ni hay dos filas que puedan discrepar) y los otros dos canales usan `bot_active.facebook` y `bot_active.instagram`, que la migracion
0009 siembra APAGADOS. **Fallo cerrado:** un canal sin fila es `false`, nunca `true`.

**Modo por canal** (`bot_mode.<canal>`, ausente = `manual`): en `manual` manda el interruptor de arriba; en `schedule` el bot se enciende y
apaga solo segun el horario del canal (`bot_schedule.<canal>`: dias, hora de inicio y de fin, hora de la clinica; si el fin es menor que
el inicio, termina al dia siguiente). El interruptor manual se CONSERVA mientras el canal esta en `schedule`. Un canal en `schedule` sin
horario valido esta apagado. `BotSettings.channels` es el estado EFECTIVO (lo que obedece el bot); `manual`, `modes` y `schedules` dicen
como se llega a el. Sin migracion: las filas nuevas se crean al usarse y su ausencia equivale al comportamiento de siempre.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from .agenda.audit import SYSTEM, Actor, audit
from .db import utcnow
from .models import CHANNELS, Setting, User

BOT_ACTIVE = "bot_active"  # la clave de WhatsApp (la de siempre)
CHANNEL_KEYS = {"whatsapp": BOT_ACTIVE, "facebook": "bot_active.facebook", "instagram": "bot_active.instagram"}
MODE_KEYS = {c: f"bot_mode.{c}" for c in CHANNELS}
SCHEDULE_KEYS = {c: f"bot_schedule.{c}" for c in CHANNELS}
assert tuple(CHANNEL_KEYS) == CHANNELS

MODES = ("manual", "schedule")
#: dias del horario, en el orden de `datetime.weekday()` (0 = lunes), con la clave del contrato
DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_HHMM = re.compile(r"([01]\d|2[0-3]):([0-5]\d)")
CLINIC_TZ = ZoneInfo("America/Cancun")


@dataclass(frozen=True)
class ChannelUpdate:
    updated_at: datetime | None
    updated_by: str | None  # nombre del usuario que lo cambio


@dataclass(frozen=True)
class BotSchedule:
    """Los `days` en que EMPIEZA el horario, de `start` a `end` (`HH:MM`, hora de la clinica). `end` < `start`: termina al dia siguiente."""
    days: tuple[str, ...]
    start: str
    end: str

    def to_json(self) -> dict:
        return {"days": list(self.days), "start": self.start, "end": self.end}


def parse_schedule(value) -> BotSchedule | None:
    """Un horario valido, o None (cualquier otra cosa: faltan dias, hora mal formada, inicio igual al fin, dias repetidos o desconocidos)."""
    if not isinstance(value, dict) or set(value) - {"days", "start", "end"}:
        return None
    days, start, end = value.get("days"), value.get("start"), value.get("end")
    if (not isinstance(days, list) or not days or len(days) > 7 or len(set(days)) != len(days)
            or not all(isinstance(d, str) and d in DAY_KEYS for d in days)):
        return None
    if not (isinstance(start, str) and _HHMM.fullmatch(start) and isinstance(end, str) and _HHMM.fullmatch(end)) or start == end:
        return None
    return BotSchedule(tuple(sorted(days, key=DAY_KEYS.index)), start, end)


def _minutes(hhmm: str) -> int:
    return int(hhmm[:2]) * 60 + int(hhmm[3:])


def schedule_active(sch: BotSchedule | None, now: datetime) -> bool:
    """El bot contesta ahora segun este horario. `now` con zona (se pasa a la hora de la clinica). Sin horario: apagado."""
    if sch is None:
        return False
    local = now.astimezone(CLINIC_TZ)
    m, wd = local.hour * 60 + local.minute, local.weekday()
    s, e = _minutes(sch.start), _minutes(sch.end)
    today, yesterday = DAY_KEYS[wd] in sch.days, DAY_KEYS[(wd - 1) % 7] in sch.days
    if s < e:                                           # dentro del mismo dia
        return today and s <= m < e
    return (today and m >= s) or (yesterday and m < e)  # cruza la medianoche: la parte de la noche y la de la madrugada siguiente


@dataclass(frozen=True)
class BotSettings:
    """`active` es el estado de WhatsApp (compatibilidad) y `updated_at` / `updated_by` tambien: son los de ESE canal."""
    active: bool
    updated_at: datetime | None
    updated_by: str | None
    #: El estado EFECTIVO (lo que obedece el bot). Siempre trae los tres canales. Un canal sin dato es `False`.
    channels: dict[str, bool] = field(default_factory=lambda: {c: False for c in CHANNELS})
    #: Quien y cuando cambio el canal por ultima vez (interruptor, modo u horario).
    updates: dict[str, ChannelUpdate] = field(default_factory=lambda: {c: ChannelUpdate(None, None) for c in CHANNELS})
    modes: dict[str, str] = field(default_factory=lambda: {c: "manual" for c in CHANNELS})
    #: El interruptor MANUAL de cada canal (el que manda en modo `manual`).
    manual: dict[str, bool] = field(default_factory=lambda: {c: False for c in CHANNELS})
    schedules: dict[str, BotSchedule | None] = field(default_factory=lambda: {c: None for c in CHANNELS})


def get_bot_settings(s: Session, default: bool = False, now: datetime | None = None) -> BotSettings:
    """Los tres canales. `default` es solo el valor manual de WhatsApp cuando su fila no existe (los otros sin fila son `False`).
    `now` (con zona) es el instante con que se evaluan los horarios; sin el, el reloj de verdad."""
    now = now or datetime.now(CLINIC_TZ)
    keys = [*CHANNEL_KEYS.values(), *MODE_KEYS.values(), *SCHEDULE_KEYS.values()]
    rows = {r.key: r for r in s.scalars(select(Setting).where(Setting.key.in_(keys)))}
    names: dict[int, str] = {}

    def who(row) -> str | None:
        if row is None or row.updated_by_id is None:
            return None
        if row.updated_by_id not in names:
            u = s.get(User, row.updated_by_id)
            names[row.updated_by_id] = u.name if u else ""
        return names[row.updated_by_id] or None

    channels, updates, modes, manual, schedules = {}, {}, {}, {}, {}
    for canal in CHANNELS:
        row, mode_row, sch_row = rows.get(CHANNEL_KEYS[canal]), rows.get(MODE_KEYS[canal]), rows.get(SCHEDULE_KEYS[canal])
        manual[canal] = (bool(default) if canal == "whatsapp" else False) if row is None else (isinstance(row.value, (bool, int)) and bool(row.value))
        modes[canal] = "schedule" if (mode_row is not None and mode_row.value == "schedule") else "manual"  # lo raro = manual
        schedules[canal] = parse_schedule(sch_row.value) if sch_row is not None else None
        channels[canal] = schedule_active(schedules[canal], now) if modes[canal] == "schedule" else manual[canal]
        last = max((r for r in (row, mode_row, sch_row) if r is not None), key=lambda r: r.updated_at, default=None)
        updates[canal] = ChannelUpdate(last.updated_at if last else None, who(last))
    wa = updates["whatsapp"]
    return BotSettings(channels["whatsapp"], wa.updated_at, wa.updated_by, channels, updates, modes, manual, schedules)


def _put(s: Session, key: str, value, actor: Actor) -> None:
    row = s.get(Setting, key)
    if row is None:
        row = Setting(key=key, value=value)
        s.add(row)
    row.value = value
    row.updated_at = utcnow()
    row.updated_by_id = actor.user_id


def _set_one(s: Session, canal: str, active: bool, actor: Actor) -> None:
    key = CHANNEL_KEYS[canal]
    _put(s, key, bool(active), actor)
    # WhatsApp conserva el formato de siempre (`{"active": x}`, entidad `bot_active`); los otros canales llevan su canal en los datos.
    data = {"active": bool(active)} if canal == "whatsapp" else {"active": bool(active), "channel": canal}
    audit(s, actor, "bot.set_active", "setting", key, data)


def set_bot_channels(s: Session, changes: dict[str, bool], actor: Actor = SYSTEM, now: datetime | None = None) -> BotSettings:
    """Cambia SOLO los interruptores manuales de los canales que vienen en `changes` (`{"facebook": True}`), una entrada de bitacora por
    canal. Participa en la transaccion de quien llama (no hace commit). Un canal desconocido o un valor que no sea booleano es `ValueError`."""
    for canal, active in changes.items():
        if canal not in CHANNEL_KEYS:
            raise ValueError(f"canal desconocido: {canal!r}")
        if not isinstance(active, bool):
            raise ValueError(f"el valor de {canal!r} debe ser verdadero o falso")
    for canal in CHANNELS:  # en orden fijo, para que la bitacora sea predecible
        if canal in changes:
            _set_one(s, canal, changes[canal], actor)
    s.flush()
    return get_bot_settings(s, now=now)


def set_bot_active(s: Session, active: bool, actor: Actor = SYSTEM, channel: str = "whatsapp") -> BotSettings:
    """Enciende/apaga el bot de UN canal (por defecto WhatsApp, la forma de siempre). Participa en la transaccion de quien llama."""
    return set_bot_channels(s, {channel: bool(active)}, actor)


def set_bot_channel(s: Session, channel: str, *, active: bool | None = None, mode: str | None = None, schedule: dict | None = None,
                    actor: Actor = SYSTEM, now: datetime | None = None) -> BotSettings:
    """Cambia de UN canal lo que venga: el interruptor manual (`active`), el modo (`manual` | `schedule`) y/o el horario. Pasar a `schedule`
    exige un horario valido (el que viene o el ya guardado). Todo o nada: si algo es invalido no se cambia nada (`ValueError`)."""
    if channel not in CHANNELS:
        raise ValueError(f"canal desconocido: {channel!r}")
    if active is not None and not isinstance(active, bool):
        raise ValueError('"active" debe ser verdadero o falso')
    if mode is not None and mode not in MODES:
        raise ValueError('"mode" debe ser ' + " | ".join(MODES))
    sch = None
    if schedule is not None:
        sch = parse_schedule(schedule)
        if sch is None:
            raise ValueError('"schedule" necesita days (mon..sun, sin repetir), start y end (HH:MM, distintos)')
    if mode == "schedule":
        stored = s.get(Setting, SCHEDULE_KEYS[channel])
        if sch is None and (stored is None or parse_schedule(stored.value) is None):
            raise ValueError("para usar el horario primero define los dias y las horas")
    if active is not None:
        _set_one(s, channel, active, actor)
    if sch is not None:
        _put(s, SCHEDULE_KEYS[channel], sch.to_json(), actor)
        audit(s, actor, "bot.set_schedule", "setting", SCHEDULE_KEYS[channel], {"channel": channel, **sch.to_json()})
    if mode is not None:
        _put(s, MODE_KEYS[channel], mode, actor)
        audit(s, actor, "bot.set_mode", "setting", MODE_KEYS[channel], {"channel": channel, "mode": mode})
    s.flush()
    return get_bot_settings(s, now=now)
