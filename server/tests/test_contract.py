"""Guardas del contrato `docs/openapi.yaml`: que sea valido y que no se separe del bot ni del calendario."""
import re
from pathlib import Path

import pytest
import yaml
from openapi_spec_validator import validate

ROOT = Path(__file__).resolve().parents[2]
METHODS = ("get", "post", "put", "patch", "delete")
PUBLIC = {"/api/health", "/api/auth/login", "/api/auth/doctors", "/api/auth/doctor-login", "/api/auth/password-link/check",
          "/api/auth/password-link/use", "/webhooks/zernio", "/api/branding", "/api/branding/logo"}


@pytest.fixture(scope="module")
def spec():
    return yaml.safe_load((ROOT / "docs" / "openapi.yaml").read_text(encoding="utf-8"))


def operations(spec):
    for path, item in spec["paths"].items():
        for method, op in item.items():
            if method in METHODS:
                yield path, method, op


def test_contrato_es_openapi_valido(spec):
    validate(spec)


def test_operation_id_unicos_y_roles_declarados(spec):
    ids = [op["operationId"] for _, _, op in operations(spec)]
    assert len(ids) == len(set(ids))
    sin_roles = [(m, p) for p, m, op in operations(spec) if p not in PUBLIC and "x-roles" not in op]
    assert sin_roles == []


def test_metodos_que_escriben_con_sesion_exigen_csrf(spec):
    """POST/PUT/PATCH/DELETE autenticados por cookie declaran `csrf`; los del bot/webhook/login no."""
    for path, method, op in operations(spec):
        if method == "get" or path in PUBLIC or path.startswith("/api/bot/"):
            continue
        schemes = {name for req in op.get("security", spec["security"]) for name in req}
        assert "csrf" in schemes, f"{method.upper()} {path} no exige CSRF"


def test_endpoints_del_bot_solo_con_token_de_servicio(spec):
    for path, _, op in operations(spec):
        if path.startswith("/api/bot/") and path != "/api/bot/status":
            assert op["security"] == [{"botToken": []}], path


def test_codigos_de_error_del_bot_actual_estan_en_el_contrato(spec):
    # codigos que el bot devuelve al modelo por su cuenta (no vienen de la API): agenda caida, accion desconocida,
    # `pasar_a_persona` fuera del backend api o con el aviso a la clinica fallido, y (canales) una conversacion sin identidad
    # utilizable o un agendado en Messenger / Instagram al que aun le falta el telefono de contacto
    codigos = set(spec["components"]["schemas"]["ErrorCode"]["enum"]) | {
        "agenda_no_disponible", "accion_desconocida", "no_disponible", "no_se_pudo_avisar", "sin_identidad", "falta_telefono"}
    fuente = (ROOT / "bot" / "scheduler.py").read_text(encoding="utf-8") + (ROOT / "bot" / "server.py").read_text(encoding="utf-8")
    usados = set(re.findall(r'"error":\s*"([a-z_]+)"', fuente)) | set(re.findall(r'error="([a-z_]+)"', fuente))
    assert usados - codigos == set()


def test_cada_accion_del_bot_tiene_endpoint(spec):
    ids = {op["operationId"] for _, _, op in operations(spec)}
    acciones = {"horarios": "botAvailability", "cercanos": "botNearest", "agendar": "botBook",
                "mis_citas": "botMyAppointments", "cancelar": "botCancel", "reprogramar": "botReschedule",
                "pasar_a_persona": "botHandoff"}
    assert {o for o in acciones.values()} <= ids


def test_booking_del_contrato_coincide_con_types_ts(spec):
    ts = (ROOT / "shared" / "calendar" / "src" / "types.ts").read_text(encoding="utf-8")
    cuerpo = ts.split("export type Booking = {")[1].split("\n};")[0]
    claves_ts = set(re.findall(r"^  (\w+)\??:", cuerpo, re.M))      # `channel?:` (opcional) tambien cuenta
    assert claves_ts == set(spec["components"]["schemas"]["Booking"]["properties"])
