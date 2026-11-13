"""Carga inicial desde `bot/agenda_config.json`: doctores (con alias), consultorios y horario de la clinica.

Es idempotente: no duplica ni pisa lo que ya existe (las ediciones hechas desde la app se respetan). El interruptor
del bot se crea APAGADO: hasta que el personal lo encienda, el bot no contesta.
"""
from __future__ import annotations

import json
from datetime import time
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import SERVER_DIR
from .doctor_codes import next_code
from .models import ClinicHours, Doctor, Room, Setting

DEFAULT_CONFIG = SERVER_DIR.parent / "bot" / "agenda_config.json"


def load_agenda_config(path: Path | str | None = None) -> dict:
    return json.loads(Path(path or DEFAULT_CONFIG).read_text(encoding="utf-8"))


def seed(s: Session, config: dict | None = None, *, bot_active: bool = False) -> dict:
    """Aplica el seed dentro de la sesion (no hace commit). Devuelve cuanto creo de cada cosa."""
    cfg = config or load_agenda_config()
    made = {"rooms": 0, "doctors": 0, "clinic_hours": 0, "settings": 0}

    # consultorios: en el orden del archivo (el primero libre gana al reservar)
    for pos, name in enumerate(cfg["consultorios"], start=1):
        if s.scalar(select(Room).where(Room.name == name)) is None:
            s.add(Room(name=name, position=pos))
            made["rooms"] += 1

    # doctores: la etiqueta es la especialidad; las claves del JSON y `match` ya no hacen falta. Cada uno recibe su codigo de 4 digitos.
    codes = set(s.scalars(select(Doctor.code)))
    for d in cfg["doctors"].values():
        if s.scalar(select(Doctor).where(Doctor.name == d["name"])) is None:
            code = next_code(codes)
            codes.add(code)
            s.add(Doctor(code=code, name=d["name"], specialty=d["label"], aliases=list(d.get("aliases", [])), active=True,
                         uses_clinic_hours=True))
            made["doctors"] += 1

    # horario de la clinica: solo si esta vacio. En el JSON: {"0": ["09:00", "18:00"], ...} (0 = lunes)
    if s.scalar(select(ClinicHours.id).limit(1)) is None:
        for wd, (a, b) in cfg["hours"].items():
            s.add(ClinicHours(weekday=int(wd), start_time=time.fromisoformat(a), end_time=time.fromisoformat(b)))
            made["clinic_hours"] += 1

    if s.get(Setting, "bot_active") is None:
        s.add(Setting(key="bot_active", value=bool(bot_active)))
        made["settings"] += 1
    s.flush()
    return made
