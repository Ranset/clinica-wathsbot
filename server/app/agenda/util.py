"""Utilidades puras portadas de `bot/scheduler.py` (`norm`, `iso`, `parse_dt`, `overlaps`)."""
from __future__ import annotations

import unicodedata
from datetime import datetime
from zoneinfo import ZoneInfo

from .rules import Rules

_DEFAULT_TZ = Rules().tz


def norm(s):
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


def overlaps(a_start, a_end, b_start, b_end):
    return a_start < b_end and b_start < a_end


def iso(dt: datetime, tz: ZoneInfo = _DEFAULT_TZ) -> str:
    """`2026-11-12T13:30-05:00`: hora local de la clinica con desfase, sin segundos (formato `IsoLocal` del contrato)."""
    return dt.astimezone(tz).isoformat(timespec="minutes")


def parse_dt(s: str, tz: ZoneInfo = _DEFAULT_TZ) -> datetime:
    """Cadena ISO -> instante con zona. Sin desfase se toma como hora de la clinica; con `Z`/desfase se convierte."""
    s = s.strip()
    if s[-1:] in ("Z", "z"):  # `datetime.fromisoformat` solo admite la 'Z' final desde Python 3.11 (el servidor corre en 3.10)
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    return dt.replace(tzinfo=tz) if dt.tzinfo is None else dt.astimezone(tz)
