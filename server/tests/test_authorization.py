"""Autorizacion dirigida por el contrato: cada operacion de `docs/openapi.yaml` (menos bot, webhook y las publicas) se prueba sin
sesion (401), con cada rol que NO le toca (403) y con cada rol que SI (nunca 401/403). Si manana alguien agrega una ruta sin
proteger, o el contrato declara una que no existe, estas pruebas lo dicen."""
import re

import pytest

from helpers import _spec, assert_schema

ROLES = ("admin", "staff", "doctor")
SKIP_PREFIX = ("/api/bot/", "/webhooks/")
PUBLIC = {"health", "login", "listLoginDoctors", "doctorLogin", "checkPasswordLink", "usePasswordLink", "getBranding", "getBrandingLogo"}


def operations():
    spec = _spec()
    for path, item in spec["paths"].items():
        if path.startswith(SKIP_PREFIX):
            continue
        for method, op in item.items():
            if method in ("get", "post", "put", "patch", "delete") and op["operationId"] not in PUBLIC:
                yield method.upper(), path, op["operationId"], set(op.get("x-roles") or ROLES)


def fill(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "1", path)


def call(session_or_client, method, path, csrf=None):
    headers = {"X-CSRF-Token": csrf} if csrf else {}
    c = getattr(session_or_client, "client", session_or_client)
    return c.open(fill(path), method=method, headers=headers, json={} if method != "GET" else None)


def test_cada_operacion_del_contrato_exige_sesion_y_su_rol(app, users, login):
    sessions = {"admin": login("admin"), "staff": login("staff"), "doctor": login("doctor")}
    anonimo = app.test_client()
    fallos = []
    ops = sorted(operations(), key=lambda o: o[2] == "logout")      # `logout` al final: cierra las sesiones que se estan usando
    assert len(ops) == 49          # 70 operaciones del contrato - 13 del bot/webhook - 8 publicas (health, login, lista y login del doctor, enlace: revisar y usar, branding y su logo)
    for method, path, op_id, roles in ops:
        r = call(anonimo, method, path)
        if r.status_code != 401:
            fallos.append(f"{op_id}: sin sesion dio {r.status_code}, debia ser 401")
        for role, s in sessions.items():
            r = call(s, method, path, s.csrf)
            if role in roles and r.status_code in (401, 403):
                fallos.append(f"{op_id}: {role} deberia poder y dio {r.status_code}")
            if role not in roles and r.status_code != 403:
                fallos.append(f"{op_id}: {role} no deberia poder y dio {r.status_code}")
            if r.mimetype != "application/json" and r.status_code not in (204, 304):
                fallos.append(f"{op_id}: {role} respondio {r.mimetype}")
    assert not fallos, "\n".join(fallos)


def test_las_escrituras_sin_csrf_son_403_para_cualquier_rol_permitido(users, login):
    sessions = {"admin": login("admin"), "staff": login("staff"), "doctor": login("doctor")}
    fallos = []
    for method, path, op_id, roles in operations():
        if method == "GET":
            continue
        for role in roles:
            r = call(sessions[role], method, path, csrf=None)
            if r.status_code != 403 or r.get_json().get("detail") != "csrf":
                fallos.append(f"{op_id}: {role} sin CSRF dio {r.status_code} {r.get_json()}")
    assert not fallos, "\n".join(fallos)


def test_no_hay_rutas_fuera_del_contrato(app):
    norm = lambda p: re.sub(r"\{[^}]+\}|<[^>]+>", "{}", p)
    declarado = {(m.upper(), norm(p)) for p, item in _spec()["paths"].items() for m in item
                 if m in ("get", "post", "put", "patch", "delete")}
    real = {(m, norm(str(r))) for r in app.url_map.iter_rules() if not str(r).startswith("/static")
            for m in r.methods - {"HEAD", "OPTIONS"}}
    assert real - declarado == set(), "rutas sin documentar en docs/openapi.yaml"
    assert declarado - real == set(), "operaciones del contrato sin implementar"


def test_los_errores_de_autorizacion_cumplen_el_contrato(app, users, login):
    anon = app.test_client().get("/api/users")
    assert anon.status_code == 401 and anon.get_json() == {"error": "no_autenticado"}
    assert_schema("ErrorBody", anon.get_json())
    forb = login("staff").get("/api/users")
    assert forb.status_code == 403 and forb.get_json() == {"error": "sin_permiso"}
    assert_schema("ErrorBody", forb.get_json())


@pytest.mark.parametrize("path", ["/api/doctor/appointments?from=2030-01-01T00:00&to=2030-01-02T00:00", "/api/doctor/hours",
                                  "/api/doctor/absences", "/api/doctor/schedule-change-requests"])
def test_personal_y_admin_no_usan_la_api_del_doctor(login, path):
    for who in ("admin", "staff"):
        assert login(who).get(path).status_code == 403


@pytest.mark.parametrize("path", ["/api/appointments?from=2030-01-01T00:00&to=2030-01-02T00:00", "/api/appointments/1", "/api/users",
                                  "/api/attention", "/api/settings/bot", "/api/schedule-change-requests", "/api/absences?from=2030-01-01&to=2030-01-02",
                                  "/api/doctors/1/absences"])
def test_un_doctor_no_entra_a_lo_del_personal(login, path):
    assert login("doctor").get(path).status_code == 403


def test_el_validador_de_conformidad_detecta_las_desviaciones():
    """Guarda de la guarda: `Session` valida CADA respuesta contra el contrato; aqui se comprueba que ese validador muerde."""
    from types import SimpleNamespace
    from helpers import check_contract

    def resp(status, body=None):
        return SimpleNamespace(status_code=status, get_json=lambda: body)
    me = {"user": {"id": "1", "email": "a@b.co", "name": "A B", "role": "staff", "doctorId": None, "active": True, "passwordSet": True}, "csrfToken": "t"}
    check_contract("GET", "/api/me", resp(200, me))                                      # lo correcto pasa
    check_contract("GET", "/api/me", resp(401, {"error": "no_autenticado"}))
    check_contract("DELETE", "/api/doctor/absences/7", resp(204))
    for metodo, ruta, r, texto in (("GET", "/api/me", resp(418, {}), "NO declara"),                   # estado no declarado
                                   ("GET", "/api/me", resp(200, {"user": me["user"]}), "no cumple"),   # falta csrfToken
                                   ("GET", "/api/me", resp(401, {"error": "inventado"}), "no cumple"),  # codigo fuera del enum
                                   ("GET", "/api/nada", resp(200, {}), "fuera del contrato"),
                                   ("PATCH", "/api/me", resp(200, me), "fuera del contrato")):
        with pytest.raises(AssertionError, match=texto):
            check_contract(metodo, ruta, r)
