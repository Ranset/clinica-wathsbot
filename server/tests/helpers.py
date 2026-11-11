"""Ayudas de las pruebas (fechas relativas al reloj de la agenda, como en `bot/test_scheduler.py`)."""
from __future__ import annotations

import os
from datetime import datetime, timedelta

#: Limite de conexiones SIMULTANEAS del usuario MySQL de pruebas (0 = sin limite). El MySQL gratuito de PythonAnywhere
#: permite 3 (error 1226 `max_user_connections`); `scripts/pa_run_tests.py` lo detecta y lo pone en TEST_MYSQL_MAX_CONN.
MAXCONN = int(os.environ.get("TEST_MYSQL_MAX_CONN") or 0)


def next_weekday(agenda, wd: int, hour: int, minute: int = 0, weeks: int = 1) -> datetime:
    """Proximo dia de la semana `wd` (0=lunes) a esa hora, al menos `weeks` semanas adelante (aware, zona de la clinica)."""
    d = agenda.now().date() + timedelta(days=7 * weeks)
    d += timedelta(days=(wd - d.weekday()) % 7)
    return datetime(d.year, d.month, d.day, hour, minute, tzinfo=agenda.rules.tz)


def room_block(agenda, room, start, minutes=30, **kw):
    """Bloqueo manual de consultorio (lo que antes era un evento manual en Google Calendar)."""
    return agenda.create_booking(kind="block", room_id=room.id, start=start, duration_minutes=minutes, **kw)


def check_integrity(session_factory, rules=None):
    """Invariantes que SIEMPRE deben cumplirse en la BD (se llaman al final de las pruebas de concurrencia/atomicidad):

    - cada cita/bloqueo `agendada|realizada|no_show` tiene exactamente duracion/30 huecos consecutivos desde su inicio,
      en su consultorio y con su doctor (NULL en bloqueos);
    - una `cancelada` no tiene huecos;
    - ningun consultorio ni doctor tiene dos huecos a la misma hora (lo garantiza el UNIQUE; se verifica por si acaso);
    - no hay huecos huerfanos.
    """
    from collections import Counter
    from datetime import timedelta

    from sqlalchemy import select

    from app.models import Appointment, AppointmentBlock

    with session_factory() as s:
        appts = {a.id: a for a in s.scalars(select(Appointment))}
        blocks = list(s.scalars(select(AppointmentBlock)))
    by_appt = {}
    for b in blocks:
        assert b.appointment_id in appts, f"hueco huerfano {b.id}"
        by_appt.setdefault(b.appointment_id, []).append(b)
    for aid, a in appts.items():
        got = sorted(by_appt.get(aid, []), key=lambda b: b.slot_start)
        if a.status == "cancelada":
            assert not got, f"cita {aid} cancelada conserva huecos"
            continue
        n = a.duration_minutes // 30
        assert [b.slot_start for b in got] == [a.start_utc + timedelta(minutes=30 * i) for i in range(n)], \
            f"cita {aid}: huecos {[b.slot_start for b in got]} no coinciden con {a.start_utc} x{n}"
        assert all(b.room_id == a.room_id for b in got), f"cita {aid}: huecos en otro consultorio"
        assert all(b.doctor_id == a.doctor_id for b in got), f"cita {aid}: huecos con otro doctor"
    rooms = Counter((b.room_id, b.slot_start) for b in blocks)
    docs = Counter((b.doctor_id, b.slot_start) for b in blocks if b.doctor_id is not None)
    assert max(rooms.values(), default=0) <= 1 and max(docs.values(), default=0) <= 1
