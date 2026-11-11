"""Reglas fijas de la agenda (las que estaban en `agenda_config.json`: zona, cita de 30 min, antelacion, horizonte).
Los doctores, consultorios y horarios ya NO viven aqui: estan en la BD."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class Rules:
    tz: ZoneInfo = ZoneInfo("America/Cancun")
    slot_minutes: int = 30
    min_notice_minutes: int = 60
    horizon_days: int = 60
    max_duration_minutes: int = 24 * 60

    @property
    def slot(self) -> timedelta:
        return timedelta(minutes=self.slot_minutes)

    @classmethod
    def from_config(cls, cfg) -> "Rules":
        return cls(tz=ZoneInfo(cfg["TIMEZONE"]), slot_minutes=int(cfg["SLOT_MINUTES"]),
                   min_notice_minutes=int(cfg["MIN_NOTICE_MINUTES"]), horizon_days=int(cfg["HORIZON_DAYS"]),
                   max_duration_minutes=int(cfg["MAX_DURATION_MINUTES"]))
