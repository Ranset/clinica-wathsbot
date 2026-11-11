"""Horarios semanales: porta `work_hours` / `all_slots` de `bot/scheduler.py`.

Un `Schedule` es el horario de pared por dia de la semana (0=lunes .. 6=domingo). A diferencia de
`agenda_config.json` admite varios intervalos por dia (p. ej. con pausa de comida), como `WeeklyHours` del contrato.
"""
from __future__ import annotations

from datetime import date, datetime, time
from typing import Iterable

from .rules import Rules

DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def parse_hhmm(s: str) -> time:
    return time.fromisoformat(s)


def fmt_hhmm(t: time) -> str:
    return t.strftime("%H:%M")


class Schedule:
    """Horario semanal resuelto: `{weekday: [(inicio, fin), ...]}`."""

    def __init__(self, rules: Rules, by_weekday: dict[int, list[tuple[time, time]]] | None = None):
        self.rules = rules
        self.by_weekday = {wd: sorted(ivs) for wd, ivs in (by_weekday or {}).items() if ivs}
        self._slots: dict[date, list[datetime]] = {}

    @classmethod
    def from_rows(cls, rules: Rules, rows: Iterable) -> "Schedule":
        by: dict[int, list[tuple[time, time]]] = {}
        for r in rows:
            by.setdefault(r.weekday, []).append((r.start_time, r.end_time))
        return cls(rules, by)

    @classmethod
    def from_weekly(cls, rules: Rules, weekly: dict) -> "Schedule":
        """Desde el formato del contrato: `{"mon": [{"start": "09:00", "end": "18:00"}], ...}`."""
        by = {DAY_KEYS.index(k): [(parse_hhmm(i["start"]), parse_hhmm(i["end"])) for i in ivs]
              for k, ivs in (weekly or {}).items()}
        return cls(rules, by)

    def to_weekly(self) -> dict:
        return {DAY_KEYS[wd]: [{"start": fmt_hhmm(a), "end": fmt_hhmm(b)} for a, b in ivs]
                for wd, ivs in sorted(self.by_weekday.items())}

    def rows(self):
        """(weekday, inicio, fin) para guardar en BD."""
        return [(wd, a, b) for wd, ivs in sorted(self.by_weekday.items()) for a, b in ivs]

    # ---- consulta (port de scheduler.py) ----
    def intervals(self, day: date) -> list[tuple[time, time]]:
        return self.by_weekday.get(day.weekday(), [])

    def work_hours(self, day: date):
        """(apertura, cierre) como time, o None si no se atiende ese dia (envolvente de los intervalos)."""
        ivs = self.intervals(day)
        return (ivs[0][0], max(b for _, b in ivs)) if ivs else None

    def all_slots(self, day: date) -> list[datetime]:
        """Inicios de cita (con zona) de ese dia, alineados a la rejilla de `slot_minutes`."""
        cached = self._slots.get(day)
        if cached is not None:
            return cached
        r = self.rules
        out = []
        for a, b in self.intervals(day):
            m = a.hour * 60 + a.minute
            m = -(-m // r.slot_minutes) * r.slot_minutes  # primera marca de la rejilla >= apertura
            cur = datetime.combine(day, time(m // 60, m % 60), r.tz) if m < 24 * 60 else None
            end = datetime.combine(day, b, r.tz)
            while cur is not None and cur + r.slot <= end:
                out.append(cur)
                cur += r.slot
        self._slots[day] = out
        return out

    def has_slot(self, start: datetime) -> bool:
        """True si `start` es exactamente el inicio de una cita de este horario (dentro de horario y alineado)."""
        local = start.astimezone(self.rules.tz)
        return local in self.all_slots(local.date())


def validate_weekly(weekly: dict, rules: Rules) -> None:
    """Forma y coherencia de un `WeeklyHours`. Lanza ValueError con el motivo."""
    if not isinstance(weekly, dict):
        raise ValueError("el horario debe ser un objeto")
    for k, ivs in weekly.items():
        if k not in DAY_KEYS:
            raise ValueError(f"dia desconocido: {k!r}")
        if not isinstance(ivs, list):
            raise ValueError(f"{k}: debe ser una lista de intervalos")
        parsed = []
        for i in ivs:
            try:
                a, b = parse_hhmm(i["start"]), parse_hhmm(i["end"])
            except (KeyError, TypeError, ValueError):
                raise ValueError(f"{k}: intervalo invalido {i!r}") from None
            if a >= b:
                raise ValueError(f"{k}: {fmt_hhmm(a)} debe ser anterior a {fmt_hhmm(b)}")
            for t in (a, b):
                if (t.hour * 60 + t.minute) % rules.slot_minutes:
                    raise ValueError(f"{k}: {fmt_hhmm(t)} no esta alineado a {rules.slot_minutes} min")
            parsed.append((a, b))
        parsed.sort()
        for (a1, b1), (a2, _b2) in zip(parsed, parsed[1:]):
            if a2 < b1:
                raise ValueError(f"{k}: intervalos solapados")
