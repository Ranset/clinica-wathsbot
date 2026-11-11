"""API del bot (`/api/bot/*`): autenticacion, forma de las respuestas (contra `docs/openapi.yaml`), errores y privacidad por
telefono. Corre en SQLite y en MySQL (fixture `client`); las de autenticacion no tocan la BD."""
import re
from datetime import timedelta

import pytest

from app import create_app
from app.agenda import iso, parse_dt
from app.settings import set_bot_active
from helpers import BOT_HEADERS, TEST_BOT_TOKEN, assert_schema, next_weekday

A, B, C = "5219981110001", "5219981110002", "5219981110003"
Z_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")


def get(client, path, **params):
    return client.get(path, query_string=params, headers=BOT_HEADERS)


def post(client, path, body=None):
    return client.post(path, json=body if body is not None else {}, headers=BOT_HEADERS)


def book(client, phone, name, especialidad, when):
    return post(client, "/api/bot/appointments",
                {"telefono": phone, "nombre": name, "especialidad": especialidad, "inicio": iso(when)})


# ------------------------------------------------------------------ autenticacion (sin BD)
BOT_ROUTES = [
    ("GET", "/api/bot/status"), ("GET", "/api/bot/config"), ("GET", "/api/bot/availability?especialidad=proctologia"),
    ("GET", "/api/bot/nearest?especialidad=proctologia&fecha_hora=2030-01-01T10:00"),
    ("GET", "/api/bot/appointments?telefono=" + A), ("POST", "/api/bot/appointments"),
    ("POST", "/api/bot/appointments/1/cancel"), ("POST", "/api/bot/appointments/1/reschedule"),
    ("POST", "/api/bot/events/claim"), ("POST", "/api/bot/events/1/ack"), ("POST", "/api/bot/events/1/fail"),
    ("POST", "/api/bot/handoffs"),
]
BAD_AUTH = [{}, {"Authorization": "Bearer malo"}, {"Authorization": "Basic " + TEST_BOT_TOKEN},
            {"Authorization": TEST_BOT_TOKEN}, {"Authorization": "Bearer "}, {"Authorization": "Bearer " + TEST_BOT_TOKEN + "x"}]


@pytest.fixture(scope="module")
def bare():
    """App sin BD util: basta para comprobar que la autenticacion corta ANTES de tocarla."""
    return create_app({"DATABASE_URL": "sqlite://", "TESTING": True, "BOT_TOKEN": TEST_BOT_TOKEN}).test_client()


@pytest.mark.parametrize("method,path", BOT_ROUTES)
@pytest.mark.parametrize("headers", BAD_AUTH, ids=lambda h: (h.get("Authorization") or "sin-cabecera")[:14])
def test_sin_token_valido_todo_el_bot_es_401(bare, method, path, headers):
    r = bare.open(path, method=method, headers=headers, json={} if method == "POST" else None)
    assert r.status_code == 401 and r.get_json()["error"] == "no_autenticado"
    assert r.headers["WWW-Authenticate"] == "Bearer"


def test_el_token_en_la_url_no_autentica(bare):
    assert bare.get("/api/bot/status?token=" + TEST_BOT_TOKEN).status_code == 401
    assert bare.get("/api/bot/status?access_token=" + TEST_BOT_TOKEN).status_code == 401


def test_sin_bot_token_configurado_falla_cerrado():
    c = create_app({"DATABASE_URL": "sqlite://", "TESTING": True, "BOT_TOKEN": ""}).test_client()
    for h in ({}, {"Authorization": "Bearer "}, {"Authorization": "Bearer cualquiera"}):
        assert c.get("/api/bot/status", headers=h).status_code == 401


def test_el_token_se_toma_del_entorno(monkeypatch):
    monkeypatch.setenv("BOT_TOKEN", "  del-entorno  ")
    app = create_app({"DATABASE_URL": "sqlite://", "TESTING": True})
    assert app.config["BOT_TOKEN"] == "del-entorno"
    r = app.test_client().get("/api/bot/availability", headers={"Authorization": "Bearer del-entorno"})
    assert r.status_code == 422 and r.get_json()["error"] == "validacion"      # paso la autenticacion (y falta la especialidad)


# ------------------------------------------------------------------ estado y configuracion
def test_status_refleja_el_interruptor(client, db):
    r = get(client, "/api/bot/status")
    assert r.status_code == 200 and r.get_json()["active"] is False          # el seed lo deja apagado
    assert_schema("BotSettings", r.get_json())
    with db() as s, s.begin():
        set_bot_active(s, True)
    j = get(client, "/api/bot/status").get_json()
    assert j["active"] is True and Z_RE.match(j["updatedAt"])
    assert_schema("BotSettings", j)


def test_config_trae_doctores_y_limites(client):
    j = get(client, "/api/bot/config").get_json()
    assert_schema("BotConfig", j)
    assert (j["timezone"], j["slotMinutes"], j["minNoticeMinutes"], j["horizonDays"]) == ("America/Cancun", 30, 60, 60)
    assert len(j["doctors"]) == 7 and {"name", "specialty", "weeklyHours", "usesClinicHours"} == set(j["doctors"][0])
    assert j["clinicHours"]["mon"] == [{"start": "09:00", "end": "18:00"}] and j["clinicHours"]["sat"] == [{"start": "09:00", "end": "13:00"}]
    assert "sun" not in j["clinicHours"] and all(d["weeklyHours"] == j["clinicHours"] and d["usesClinicHours"] for d in j["doctors"])


# ------------------------------------------------------------------ lectura de agenda
def test_availability(client, agenda):
    r = get(client, "/api/bot/availability", especialidad="proctologia")
    j = r.get_json()
    assert r.status_code == 200 and j["horarios"] and "Cervantes" in j["doctor"]
    assert_schema("BotAvailability", j)
    tarde = get(client, "/api/bot/availability", especialidad="otorrino", hora_min="14", dias="14").get_json()
    assert tarde["horarios"] and all(parse_dt(h).hour >= 14 for h in tarde["horarios"])


def test_availability_especialidad_desconocida_y_parametros_malos(client):
    r = get(client, "/api/bot/availability", especialidad="cardiologia")
    assert r.status_code == 422 and r.get_json()["error"] == "especialidad_no_encontrada"
    assert len(r.get_json()["especialidades"]) == 7
    assert get(client, "/api/bot/availability").get_json()["error"] == "validacion"
    for bad in ({"dias": "0"}, {"dias": "61"}, {"dias": "x"}, {"desde": "ayer"}, {"hora_min": "30"}, {"hora_max": "-1"}):
        r = get(client, "/api/bot/availability", especialidad="proctologia", **bad)
        assert r.status_code == 422 and r.get_json()["error"] == "validacion", bad


def test_nearest(client, agenda):
    t = next_weekday(agenda, 1, 10)
    j = get(client, "/api/bot/nearest", especialidad="proctologia", fecha_hora=iso(t)).get_json()
    assert j["exacto"] is True and iso(t) in j["horarios"]
    assert_schema("BotNearest", j)
    sin_desfase = get(client, "/api/bot/nearest", especialidad="proctologia",
                      fecha_hora=t.replace(tzinfo=None).isoformat(timespec="minutes")).get_json()
    assert sin_desfase["exacto"] is True                       # sin desfase = hora de Cancun


def test_nearest_errores(client, agenda):
    t = next_weekday(agenda, 1, 10)
    r = get(client, "/api/bot/nearest", especialidad="proctologia", fecha_hora=iso(t + timedelta(days=90)))
    assert r.status_code == 422 and r.get_json()["error"] == "fuera_de_rango"
    assert r.get_json()["horarios"] == [] and "maximo_agendable" in r.get_json()
    assert get(client, "/api/bot/nearest", especialidad="cardiologia", fecha_hora=iso(t)).get_json()["error"] == "especialidad_no_encontrada"
    for params in ({"especialidad": "proctologia"}, {"fecha_hora": iso(t)},
                   {"especialidad": "proctologia", "fecha_hora": "manana"}):
        r = get(client, "/api/bot/nearest", **params)
        assert r.status_code == 422 and r.get_json()["error"] == "validacion", params


# ------------------------------------------------------------------ reservar
def test_agendar_cumple_el_contrato(client, agenda):
    t = next_weekday(agenda, 1, 10)
    r = book(client, A, "Ana Lopez", "proctologia", t)
    j = r.get_json()
    assert r.status_code == 201 and j["ok"] is True and j["inicio"] == iso(t) and j["paciente"] == "Ana Lopez"
    assert_schema("BotBooked", j)
    (mia,) = get(client, "/api/bot/appointments", telefono=A).get_json()["citas"]
    assert mia["cita_id"] == j["cita_id"]
    assert_schema("BotAppointment", mia)


def test_dos_citas_caben_y_la_tercera_no(client, agenda):
    t = next_weekday(agenda, 1, 10)
    assert book(client, A, "Ana Lopez", "proctologia", t).status_code == 201
    assert book(client, B, "Beto Ruiz", "ginecologia", t).status_code == 201
    r = book(client, C, "Carla Mena", "reumatologia", t)                      # los 2 consultorios ocupados
    assert r.status_code == 409 and r.get_json()["error"] == "horario_ocupado"
    r = book(client, C, "Carla Mena", "proctologia", t + timedelta(hours=1))   # otro horario: libre
    assert r.status_code == 201
    r = book(client, B, "Beto Ruiz", "proctologia", t + timedelta(hours=1))    # el MISMO doctor a esa hora
    assert r.status_code == 409 and r.get_json()["error"] == "horario_ocupado"


def test_agendar_errores_de_regla(client, agenda):
    t = next_weekday(agenda, 1, 10)
    casos = [("Beto", "proctologia", t, "falta_nombre_completo"),
             ("Beto Ruiz", "cardiologia", t, "especialidad_no_encontrada"),
             ("Beto Ruiz", "proctologia", next_weekday(agenda, 6, 10), "fuera_de_horario"),
             ("Beto Ruiz", "proctologia", agenda.now(), "horario_pasado_o_muy_cercano"),
             ("Beto Ruiz", "proctologia", t + timedelta(days=90), "fuera_de_rango")]
    for nombre, esp, cuando, codigo in casos:
        r = book(client, B, nombre, esp, cuando)
        assert r.status_code == 422 and r.get_json()["error"] == codigo, (codigo, r.get_json())
        assert_schema("ErrorBody", r.get_json())
    assert get(client, "/api/bot/appointments", telefono=B).get_json() == {"citas": []}   # ninguna dejo rastro


def test_agendar_entrada_invalida(client, agenda):
    t = iso(next_weekday(agenda, 1, 10))
    base = {"telefono": A, "nombre": "Ana Lopez", "especialidad": "proctologia", "inicio": t}
    for cambio in ({"telefono": "abc"}, {"telefono": "123"}, {"telefono": None}, {"nombre": None}, {"nombre": 5},
                   {"especialidad": None}, {"inicio": "manana"}, {"inicio": 12}, {"inicio": None}):
        r = post(client, "/api/bot/appointments", {**base, **cambio})
        assert r.status_code == 422 and r.get_json()["error"] == "validacion", cambio
    r = client.post("/api/bot/appointments", data="no es json", headers=BOT_HEADERS)
    assert r.status_code == 422 and r.get_json()["error"] == "validacion"
    assert get(client, "/api/bot/appointments", telefono=A).get_json() == {"citas": []}


# ------------------------------------------------------------------ privacidad: solo las citas de ESE telefono
def test_un_paciente_no_ve_cancela_ni_mueve_citas_ajenas(client, agenda):
    t = next_weekday(agenda, 1, 10)
    cita = book(client, A, "Ana Lopez", "proctologia", t).get_json()["cita_id"]
    assert get(client, "/api/bot/appointments", telefono=B).get_json() == {"citas": []}
    r = post(client, f"/api/bot/appointments/{cita}/cancel", {"telefono": B})
    assert r.status_code == 404 and r.get_json()["error"] == "cita_no_encontrada"
    r = post(client, f"/api/bot/appointments/{cita}/reschedule", {"telefono": B, "inicio": iso(t + timedelta(hours=1))})
    assert r.status_code == 404 and r.get_json()["error"] == "cita_no_encontrada"
    (mia,) = get(client, "/api/bot/appointments", telefono=A).get_json()["citas"]
    assert mia["cita_id"] == cita and mia["inicio"] == iso(t)                  # intacta


def test_cancelar_libera_el_hueco(client, agenda):
    t = next_weekday(agenda, 1, 10)
    cita = book(client, A, "Ana Lopez", "proctologia", t).get_json()["cita_id"]
    assert book(client, B, "Beto Ruiz", "proctologia", t).status_code == 409
    r = post(client, f"/api/bot/appointments/{cita}/cancel", {"telefono": A})
    assert r.status_code == 200 and r.get_json()["ok"] is True
    assert_schema("BotAppointment", r.get_json()["cancelada"])
    assert get(client, "/api/bot/appointments", telefono=A).get_json() == {"citas": []}
    assert book(client, B, "Beto Ruiz", "proctologia", t).status_code == 201   # ahora si
    assert post(client, f"/api/bot/appointments/{cita}/cancel", {"telefono": A}).status_code == 404   # ya no existe


@pytest.mark.parametrize("cita_id", ["abc", "999999", "0", "-1", "1;DROP", "1.5", "%20"])
def test_ids_de_cita_raros_son_404_y_no_revientan(client, cita_id):
    r = post(client, f"/api/bot/appointments/{cita_id}/cancel", {"telefono": A})
    assert r.status_code == 404 and r.get_json()["error"] == "cita_no_encontrada"
    r = post(client, f"/api/bot/appointments/{cita_id}/reschedule", {"telefono": A, "inicio": "2030-01-01T10:00"})
    assert r.status_code in (404, 422)


def test_reprogramar_ok_y_si_falla_se_conserva_la_original(client, agenda):
    t = next_weekday(agenda, 1, 10)
    cita = book(client, A, "Ana Lopez", "proctologia", t).get_json()["cita_id"]
    assert book(client, C, "Carla Mena", "proctologia", t + timedelta(hours=1)).status_code == 201

    r = post(client, f"/api/bot/appointments/{cita}/reschedule", {"telefono": A, "inicio": iso(t + timedelta(hours=1))})
    assert r.status_code == 409 and r.get_json()["error"] == "horario_ocupado"          # el doctor ya esta a esa hora
    r = post(client, f"/api/bot/appointments/{cita}/reschedule", {"telefono": A, "inicio": iso(agenda.now())})
    assert r.status_code == 422 and r.get_json()["error"] == "horario_pasado_o_muy_cercano"
    (mia,) = get(client, "/api/bot/appointments", telefono=A).get_json()["citas"]
    assert mia["cita_id"] == cita and mia["inicio"] == iso(t)                           # sigue en su horario original

    r = post(client, f"/api/bot/appointments/{cita}/reschedule", {"telefono": A, "inicio": iso(t + timedelta(hours=2))})
    j = r.get_json()
    assert r.status_code == 200 and j["cita_id"] == cita and j["reprogramada_desde"] == iso(t)
    assert_schema("BotBooked", j)
    (mia,) = get(client, "/api/bot/appointments", telefono=A).get_json()["citas"]
    assert mia["inicio"] == iso(t + timedelta(hours=2))


def test_las_respuestas_son_json_y_no_se_guardan_en_cache(client):
    for path in ("/api/bot/status", "/api/bot/config", "/api/bot/appointments?telefono=" + A, "/api/bot/nada"):
        r = client.get(path, headers=BOT_HEADERS)
        assert r.mimetype == "application/json" and r.headers["Cache-Control"] == "no-store", path
    assert client.get("/api/bot/status").mimetype == "application/json"          # tambien el 401


def test_config_refleja_los_cambios_del_personal_para_que_el_bot_no_use_datos_viejos(login, client):
    """El bot arma su respuesta con esto: si el personal cambia el horario o desactiva a un doctor, el bot debe enterarse YA."""
    admin = login("admin")
    admin.put("/api/clinic-hours", {"mon": [{"start": "10:00", "end": "14:00"}], "sat": [{"start": "09:00", "end": "12:00"}]})
    admin.put("/api/doctors/1/weekly-hours", {"weeklyHours": {"mon": [{"start": "11:00", "end": "13:00"}]}})
    admin.patch("/api/doctors/2", {"active": False})
    j = get(client, "/api/bot/config").get_json()
    assert_schema("BotConfig", j)
    assert j["clinicHours"] == {"mon": [{"start": "10:00", "end": "14:00"}], "sat": [{"start": "09:00", "end": "12:00"}]}
    por_nombre = {d["name"]: d for d in j["doctors"]}
    assert len(j["doctors"]) == 6 and "Dr. Pérez Lago" not in por_nombre                      # el inactivo ya no aparece
    cervantes = por_nombre["Dr. Cervantes Peláez"]
    assert cervantes["weeklyHours"] == {"mon": [{"start": "11:00", "end": "13:00"}]} and cervantes["usesClinicHours"] is False
