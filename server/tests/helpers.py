"""Ayudas de las pruebas (fechas relativas al reloj de la agenda, como en `bot/test_scheduler.py`)."""
from __future__ import annotations

import os
import re
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


# ------------------------------------------------------------------ F3: bot, webhook y cola
import hashlib  # noqa: E402
import hmac  # noqa: E402
import json  # noqa: E402
from functools import lru_cache  # noqa: E402
from pathlib import Path  # noqa: E402

TEST_BOT_TOKEN = "token-de-prueba-del-bot"
TEST_WEBHOOK_SECRET = "secreto-de-prueba-del-webhook"
BOT_HEADERS = {"Authorization": "Bearer " + TEST_BOT_TOKEN}


class Clock:
    """Reloj falso (UTC, en segundos enteros: MySQL redondea los DATETIME sin fraccion) para probar plazos y esperas."""

    def __init__(self, start=None):
        from datetime import timezone
        self.t = start or datetime(2026, 11, 9, 15, 0, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.t

    def advance(self, **kw):
        self.t += timedelta(**kw)


def sign(raw: bytes, secret: str = TEST_WEBHOOK_SECRET) -> str:
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def zernio_message(event_id="evt-1", phone="5219981112222", text="Hola, quiero una cita", conv="conv-1", **over) -> dict:
    """Un `message.received` de WhatsApp como lo manda Zernio. `over` sustituye claves de primer nivel."""
    ev = {"id": event_id, "event": "message.received", "timestamp": "2026-11-12T15:00:00.000Z", "test": False,
          "message": {"id": "m-" + str(event_id), "conversationId": conv, "platform": "whatsapp", "direction": "incoming",
                      "text": text, "sender": {"id": phone, "name": "Paciente Prueba"}, "metadata": {}},
          "account": {"accountId": "acc-1"}, "conversation": {"id": conv}}
    ev.update(over)
    return ev


def post_webhook(client, payload=None, *, raw=None, secret=TEST_WEBHOOK_SECRET, header="X-Zernio-Signature", sig=None):
    """POST firmado a /webhooks/zernio. `raw` manda esos bytes tal cual; `sig` fuerza el valor de la firma."""
    raw = raw if raw is not None else json.dumps(payload).encode()
    value = sig if sig is not None else (sign(raw, secret) if secret is not None else None)
    headers = {header: value} if value is not None else {}
    return client.post("/webhooks/zernio", data=raw, headers=headers, content_type="application/json")


@lru_cache(maxsize=1)
def _spec():
    import yaml
    return yaml.safe_load((Path(__file__).resolve().parents[2] / "docs" / "openapi.yaml").read_text(encoding="utf-8"))


def assert_schema(name: str, instance) -> None:
    """La respuesta cumple el esquema `name` de `docs/openapi.yaml`."""
    from jsonschema import Draft202012Validator
    schema = {"$ref": f"#/components/schemas/{name}", "components": _spec()["components"]}
    errs = sorted(Draft202012Validator(schema).iter_errors(instance), key=str)
    assert not errs, f"{name}: {[e.message for e in errs]} en {instance}"


# ------------------------------------------------------------------ F4: personas, sesiones y CSRF
PASSWORD = "contrasena-de-prueba-1"
ACCOUNTS = {"admin": ("admin@clinica.test", "Admin Prueba", "admin", None),
            "staff": ("recepcion@clinica.test", "Recepcion Prueba", "staff", None),
            "doctor": ("dr.cervantes@clinica.test", "Dr. Cervantes", "doctor", 1),
            "doctor2": ("dra.perez@clinica.test", "Dra. Perez", "doctor", 2)}


def make_users(app) -> dict:
    """Crea un administrador, un miembro del personal y dos doctores (ligados a los doctores 1 y 2 del seed)."""
    auth = app.extensions["auth"]
    out = {}
    for who, (email, name, role, doctor_id) in ACCOUNTS.items():
        u = auth.create_user(email=email, name=name, role=role, password=PASSWORD, doctor_id=doctor_id)
        out[who] = (email, PASSWORD, u)
    return out


def _routes():
    """(regex de la ruta, objeto del contrato) de cada path de `docs/openapi.yaml`."""
    out = []
    for path, item in _spec()["paths"].items():
        rx = "^" + "[^/]+".join(re.escape(p) for p in re.split(r"\{[^}]+\}", path)) + "$"
        out.append((re.compile(rx), item))
    return out


def check_contract(method: str, path: str, resp) -> None:
    """La respuesta cumple el contrato: la ruta y el metodo existen, el ESTADO esta declarado para esa operacion y el
    cuerpo JSON cumple el esquema de ese estado. Lanza AssertionError con el motivo."""
    from jsonschema import Draft202012Validator
    spec = _spec()
    path = path.split("?")[0]
    item = next((it for rx, it in _routes() if rx.match(path)), None)
    op = item.get(method.lower()) if item else None
    assert op, f"{method} {path}: fuera del contrato"
    declared = op["responses"]
    r = declared.get(str(resp.status_code))
    assert r is not None, f"{op['operationId']}: respondio {resp.status_code}, que el contrato NO declara ({sorted(declared)})"
    while "$ref" in r:                                   # #/components/responses/NotFound, etc.
        node = spec
        for k in r["$ref"][2:].split("/"):
            node = node[k]
        r = node
    content = (r.get("content") or {}).get("application/json")
    if content and resp.status_code not in (204, 304):
        errs = sorted(Draft202012Validator({**content["schema"], "components": spec["components"]}).iter_errors(resp.get_json()), key=str)
        assert not errs, f"{op['operationId']} {resp.status_code}: el cuerpo no cumple el contrato: {[e.message for e in errs][:3]}"


class Session:
    """Un navegador con sesion iniciada: guarda la cookie y manda el `X-CSRF-Token` en las escrituras.
    CADA respuesta recibida por estos metodos se valida contra el contrato (estado declarado y esquema del cuerpo)."""

    def __init__(self, app, email, password=PASSWORD):
        self.client = app.test_client()
        r = self.client.post("/api/auth/login", json={"email": email, "password": password})
        assert r.status_code == 200, r.get_json()
        check_contract("POST", "/api/auth/login", r)
        self.csrf, self.user = r.get_json()["csrfToken"], r.get_json()["user"]

    def _h(self, kw):
        kw.setdefault("headers", {})
        kw["headers"].setdefault("X-CSRF-Token", self.csrf)
        return kw

    def _do(self, method, path, **kw):
        resp = getattr(self.client, method.lower())(path, **kw)
        check_contract(method, path, resp)
        return resp

    def get(self, path, **kw):
        return self._do("GET", path, **kw)

    def post(self, path, json=None, **kw):
        return self._do("POST", path, json=json if json is not None else {}, **self._h(kw))

    def put(self, path, json=None, **kw):
        return self._do("PUT", path, json=json if json is not None else {}, **self._h(kw))

    def patch(self, path, json=None, **kw):
        return self._do("PATCH", path, json=json if json is not None else {}, **self._h(kw))

    def delete(self, path, json=None, **kw):
        return self._do("DELETE", path, json=json, **self._h(kw))
