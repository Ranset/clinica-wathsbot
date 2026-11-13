#!/usr/bin/env python3
"""Crea la base de DESARROLLO LOCAL (`server/instance/dev.db`, SQLite) con migraciones, doctores, usuarios y citas de ejemplo.

    cd server
    .venv/Scripts/python scripts/dev_seed.py            # primera vez (Windows; en Linux/macOS: .venv/bin/python)
    .venv/Scripts/python scripts/dev_seed.py --reset    # borra la base de desarrollo y la deja como nueva

SOLO PARA DESARROLLO: las contrasenas de los usuarios de ejemplo son publicas (estan en este archivo). Por eso el script se NIEGA a
trabajar sobre cualquier base que no sea el archivo SQLite de desarrollo (nunca MySQL, nunca la de produccion).
Las citas de ejemplo se calculan desde HOY (los proximos dias habiles), asi que siempre hay algo que ver.
"""
from __future__ import annotations

import argparse
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

DEV_DB = SERVER_DIR / "instance" / "dev.db"
DEV_URL = "sqlite:///" + DEV_DB.as_posix()
DEV_PASSWORD = "clave-de-desarrollo-1"
USERS = [("admin@dev.test", "Admin Desarrollo", "admin", None),
         ("recepcion@dev.test", "Recepcion Desarrollo", "staff", None),
         ("doctor@dev.test", "Dr. Cervantes (desarrollo)", "doctor", 1),
         ("doctor2@dev.test", "Dr. Perez Lago (desarrollo)", "doctor", 2),
         ("doctor3@dev.test", "Dra. Bordas (desarrollo)", "doctor", 3)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--reset", action="store_true", help="borra la base de desarrollo y la vuelve a crear")
    args = ap.parse_args()

    import os
    env_url = os.environ.get("DATABASE_URL")
    if env_url and env_url != DEV_URL:
        print("ABORTADO: DATABASE_URL apunta a otra base. Este script solo toca server/instance/dev.db "
              "(las contrasenas de ejemplo son publicas). Quita la variable de entorno y repite.")
        return 2
    if DEV_DB.exists():
        if not args.reset:
            print(f"Ya existe {DEV_DB}.\n  - Para usarla tal cual: npm run dev:local (desde la raiz del repo).\n"
                  "  - Para borrarla y empezar de cero: agrega --reset.")
            return 1
        for suffix in ("", "-wal", "-shm"):
            Path(str(DEV_DB) + suffix).unlink(missing_ok=True)

    from app import create_app
    from app.agenda import Actor
    from app.migrate import upgrade
    from app.seed import seed

    DEV_DB.parent.mkdir(parents=True, exist_ok=True)
    upgrade(DEV_URL)
    app = create_app({"DATABASE_URL": DEV_URL})
    with app.extensions["db"].session_factory() as s, s.begin():
        seed(s, bot_active=False)                                   # el bot nace APAGADO, como en produccion

    auth, agenda = app.extensions["auth"], app.extensions["agenda"]
    avail, directory, events = app.extensions["availability"], app.extensions["directory"], app.extensions["events"]
    created = [auth.create_user(email=e, name=n, role=r, password=DEV_PASSWORD, doctor_id=d) for e, n, r, d in USERS]
    admin = created[0]

    # citas de ejemplo en los proximos 3 dias habiles
    tz = app.extensions["rules"].tz
    day, days = agenda.now().date() + timedelta(days=1), []
    while len(days) < 3:
        if day.weekday() < 5:
            days.append(day)
        day += timedelta(days=1)
    patients = [("Ana Lopez", "5219981110001"), ("Beto Ruiz", "5219981110002"), ("Carla Mena", "5219981110003"),
                ("Diego Pardo", "5219981110004"), ("Elena Soto", "5219981110005"), ("Fabio Cruz", "5219981110006")]
    plan = [(0, 10, 0, 1, "manual"), (0, 10, 0, 2, "manual"), (0, 12, 0, 3, "ai"), (1, 9, 30, 1, "manual"), (1, 11, 0, 1, "ai"),
            (1, 11, 0, 4, "ai"), (2, 15, 0, 5, "manual"), (2, 16, 30, 1, "manual")]
    for i, (d, h, m, doctor, source) in enumerate(plan):
        name, phone = patients[i % len(patients)]
        start = datetime(days[d].year, days[d].month, days[d].day, h, m, tzinfo=tz)
        agenda.create_booking(start=start, patient_name=name, phone=phone, doctor_id=doctor, source=source,
                              actor=Actor.user(admin.id))
    # una ausencia, una solicitud de cambio de horario pendiente y un caso para una persona
    d1 = days[1]
    avail.add_absence(3, datetime(d1.year, d1.month, d1.day, 9, 0, tzinfo=tz), datetime(d1.year, d1.month, d1.day, 13, 0, tzinfo=tz),
                      "congreso")
    # dos eventos personales de doctores (privados: el doctor ve el texto en su PWA; el personal solo ve «No disponible»)
    d0, d2 = days[0], days[2]
    avail.add_personal_event(1, "Comida con residentes", "Reservacion a nombre del doctor",
                             datetime(d0.year, d0.month, d0.day, 13, 0, tzinfo=tz), datetime(d0.year, d0.month, d0.day, 14, 0, tzinfo=tz))
    avail.add_personal_event(3, "Junta de especialidad", None,
                             datetime(d2.year, d2.month, d2.day, 11, 0, tzinfo=tz), datetime(d2.year, d2.month, d2.day, 12, 0, tzinfo=tz))
    directory.create_schedule_change(1, {"mon": [{"start": "10:00", "end": "14:00"}], "wed": [{"start": "10:00", "end": "14:00"}]},
                                     date.today() + timedelta(days=14), "Quiero atender solo lunes y miercoles por la manana")
    events.handoff("conv-dev-1", "pidio_persona", "5219981119999", "La paciente pidio hablar con una persona")

    print(f"Base de desarrollo lista: {DEV_DB}\n")
    print("Usuarios (la misma contrasena para todos). Los doctores entran a su app con su CODIGO de 4 digitos, no con el correo:")
    for e, n, r, d in USERS:
        code = directory.get_doctor(d).code if d else None
        print(f"  {r:7} {e}" + (f"   codigo {code}" if code else ""))
    print(f"  contrasena: {DEV_PASSWORD}\n")
    print("Siguiente paso, desde la raiz del repo:  npm run dev:local")
    return 0


if __name__ == "__main__":
    sys.exit(main())
