"""Ata el motor al contrato `docs/openapi.yaml` (que NO se edita): codigos de error y forma de las respuestas del bot."""
from datetime import timedelta
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator

from app.agenda import errors
from helpers import next_weekday

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def spec():
    return yaml.safe_load((ROOT / "docs" / "openapi.yaml").read_text(encoding="utf-8"))


def validate(spec, name, instance):
    schema = {"$ref": f"#/components/schemas/{name}", "components": spec["components"]}
    errs = sorted(Draft202012Validator(schema).iter_errors(instance), key=str)
    assert not errs, f"{name}: {[e.message for e in errs]} en {instance}"


def test_codigos_de_error_del_motor_estan_en_el_contrato(spec):
    enum = set(spec["components"]["schemas"]["ErrorCode"]["enum"])
    usados = {v for k, v in vars(errors).items() if k.isupper() and isinstance(v, str) and k != "HTTP_STATUS"}
    assert usados <= enum, usados - enum
    # y los heredados de scheduler.py siguen, con las mismas cadenas
    heredados = {"horario_ocupado", "horario_pasado_o_muy_cercano", "fuera_de_rango", "fuera_de_horario",
                 "falta_nombre_completo", "especialidad_no_encontrada", "cita_no_encontrada"}
    assert heredados <= usados and "doctor_no_disponible" in usados


def test_estados_http_de_los_errores_coinciden_con_el_contrato(spec):
    assert errors.AgendaError("horario_ocupado").http_status == 409
    assert errors.AgendaError("transicion_invalida").http_status == 409
    assert errors.AgendaError("cita_no_encontrada").http_status == 404
    assert errors.AgendaError("fuera_de_rango").http_status == 422
    assert errors.AgendaError("doctor_no_disponible", "ausente").body() == {"error": "doctor_no_disponible", "detail": "ausente"}


def test_respuestas_del_bot_cumplen_el_contrato(spec, agenda, avail):
    t = next_weekday(agenda, 1, 10)
    validate(spec, "BotAvailability", agenda.free_slots("proctologia"))
    validate(spec, "BotNearest", agenda.nearest("proctologia", t))
    booked = agenda.book("5219990001", "Ana Lopez", "proctologia", t)
    validate(spec, "BotBooked", booked)
    for cita in agenda.mine("5219990001"):
        validate(spec, "BotAppointment", cita)
    moved = agenda.reschedule("5219990001", booked["cita_id"], t + timedelta(hours=1))
    validate(spec, "BotBooked", moved)
    assert Draft202012Validator({"$ref": "#/components/schemas/IsoLocal", "components": spec["components"]}).is_valid(moved["reprogramada_desde"])
    assert moved["reprogramada_desde"] and set(moved) >= {"ok", "cita_id", "doctor", "especialidad", "consultorio", "inicio", "paciente", "reprogramada_desde"}
    cancelled = agenda.cancel("5219990001", booked["cita_id"])
    assert cancelled["ok"] is True
    validate(spec, "BotAppointment", cancelled["cancelada"])


def test_errores_del_bot_cumplen_el_contrato(spec, agenda, avail):
    t = next_weekday(agenda, 1, 10)
    avail.add_absence(agenda.find_doctor("reumatologia").id, t, t + timedelta(hours=1))
    agenda.book("5219990001", "Ana Lopez", "proctologia", t)
    casos = [agenda.book("5219990002", "Beto Ruiz", "proctologia", t),                       # horario_ocupado
             agenda.book("5219990002", "Beto", "proctologia", t),                              # falta_nombre_completo
             agenda.book("5219990002", "Beto Ruiz", "cardiologia", t),                         # especialidad_no_encontrada
             agenda.book("5219990002", "Beto Ruiz", "reumatologia", t),                        # doctor_no_disponible
             agenda.book("5219990002", "Beto Ruiz", "proctologia", agenda.now()),              # horario_pasado_o_muy_cercano
             agenda.book("5219990002", "Beto Ruiz", "proctologia", t + timedelta(days=90)),    # fuera_de_rango
             agenda.book("5219990002", "Beto Ruiz", "proctologia", next_weekday(agenda, 6, 10)),   # fuera_de_horario
             agenda.cancel("5219990002", 12345),                                                # cita_no_encontrada
             agenda.nearest("proctologia", t + timedelta(days=90))]                             # fuera_de_rango (con horarios: [])
    assert [c["error"] for c in casos] == ["horario_ocupado", "falta_nombre_completo", "especialidad_no_encontrada",
                                           "doctor_no_disponible", "horario_pasado_o_muy_cercano", "fuera_de_rango",
                                           "fuera_de_horario", "cita_no_encontrada", "fuera_de_rango"]
    for c in casos:
        validate(spec, "ErrorBody", c)
    assert len(casos[2]["especialidades"]) == 7
