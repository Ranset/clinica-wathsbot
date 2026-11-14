"""Cada canal del bot puede estar en modo `manual` (lo manda su interruptor) o `schedule` (se enciende y apaga solo dentro de un horario:
ciertos dias, de una hora a otra, hora de la clinica; si el fin es menor que el inicio termina al dia siguiente). `channels` (lo que
obedece el bot) es el estado EFECTIVO; el interruptor manual se conserva mientras el canal esta en `schedule`."""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.models import AuditLog, Setting
from app.settings import BotSchedule, parse_schedule, schedule_active
from helpers import BOT_HEADERS, Clock, assert_schema

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"]
NIGHT = {"days": WEEKDAYS, "start": "19:00", "end": "08:00"}      # de noche, de lunes a viernes (termina a la manana siguiente)
OFFICE = {"days": WEEKDAYS, "start": "09:00", "end": "18:00"}     # en horario de oficina


def at(day: int, hhmm: str) -> datetime:
    """Un instante de noviembre de 2026 (el 9 es lunes) a esa hora de Cancun (UTC-5), en UTC."""
    h, m = map(int, hhmm.split(":"))
    return datetime(2026, 11, day, h, m, tzinfo=timezone(timedelta(hours=-5))).astimezone(timezone.utc)


def sch(**kw) -> BotSchedule:
    return parse_schedule({**NIGHT, **kw})


# =========================================================================== el horario en si (sin servidor)
@pytest.mark.parametrize("schedule,day,hhmm,expected", [
    # mismo dia: de 9:00 a 18:00 (el fin no cuenta)
    (OFFICE, 11, "08:59", False), (OFFICE, 11, "09:00", True), (OFFICE, 11, "17:59", True), (OFFICE, 11, "18:00", False),
    (OFFICE, 14, "10:00", False),            # sabado: no esta entre los dias
    # cruza la medianoche: de 19:00 a 08:00, de lunes a viernes
    (NIGHT, 11, "18:59", False), (NIGHT, 11, "19:00", True), (NIGHT, 11, "23:59", True),   # miercoles por la noche
    (NIGHT, 12, "00:00", True), (NIGHT, 12, "07:59", True), (NIGHT, 12, "08:00", False),   # ...y la madrugada del jueves
    (NIGHT, 12, "12:00", False),
    (NIGHT, 14, "02:00", True),              # sabado de madrugada: es la noche del viernes
    (NIGHT, 14, "19:00", False), (NIGHT, 15, "02:00", False),   # sabado de noche y domingo de madrugada: no empezo en un dia de la lista
    (NIGHT, 9, "02:00", False),              # lunes de madrugada: es la noche del domingo, que no esta
    (NIGHT, 9, "19:00", True),
])
def test_el_horario_decide_segun_el_dia_y_la_hora_de_cancun(schedule, day, hhmm, expected):
    assert schedule_active(parse_schedule(schedule), at(day, hhmm)) is expected, (day, hhmm)


def test_el_horario_se_evalua_en_la_hora_de_la_clinica_no_en_utc():
    # 01:00 UTC del jueves = 20:00 del miercoles en Cancun: dentro del horario de noche
    assert schedule_active(sch(), datetime(2026, 11, 12, 1, 0, tzinfo=timezone.utc)) is True
    # 14:00 UTC del miercoles = 09:00 en Cancun: fuera
    assert schedule_active(sch(), datetime(2026, 11, 11, 14, 0, tzinfo=timezone.utc)) is False
    assert schedule_active(None, at(11, "20:00")) is False       # sin horario: apagado


@pytest.mark.parametrize("value", [
    None, [], "lunes", {}, {"days": [], "start": "19:00", "end": "08:00"}, {"days": ["mon"], "start": "19:00"},
    {"days": ["mon", "mon"], "start": "19:00", "end": "08:00"}, {"days": ["lunes"], "start": "19:00", "end": "08:00"},
    {"days": ["mon"], "start": "7pm", "end": "08:00"}, {"days": ["mon"], "start": "24:00", "end": "08:00"},
    {"days": ["mon"], "start": "19:60", "end": "08:00"}, {"days": ["mon"], "start": "09:00", "end": "09:00"},
    {"days": ["mon"], "start": 19, "end": 8}, {"days": "mon", "start": "19:00", "end": "08:00"},
    {**NIGHT, "extra": 1}, {"days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun", "mon"], "start": "19:00", "end": "08:00"},
])
def test_un_horario_invalido_no_se_acepta(value):
    assert parse_schedule(value) is None


def test_los_dias_se_ordenan_y_el_horario_valido_se_normaliza():
    s = parse_schedule({"days": ["fri", "mon"], "start": "19:00", "end": "08:00"})
    assert s.days == ("mon", "fri") and s.to_json() == {"days": ["mon", "fri"], "start": "19:00", "end": "08:00"}


# =========================================================================== por la API
@pytest.fixture
def clock():
    return Clock(at(11, "12:00"))                 # miercoles al mediodia (hora de Cancun)


@pytest.fixture
def timed(make_app, clock):
    """App con el reloj falso: la hora que se evalua es la del reloj."""
    return make_app(clock=clock)


@pytest.fixture
def people(timed):
    from helpers import make_users
    return make_users(timed)


@pytest.fixture
def staff(timed, people):
    from helpers import Session
    return Session(timed, people["staff"][0])


def status(app):
    r = app.test_client().get("/api/bot/status", headers=BOT_HEADERS)
    assert r.status_code == 200
    assert_schema("BotSettings", r.get_json())
    return r.get_json()


def test_sin_tocar_nada_todo_es_manual_y_como_siempre(timed, staff):
    j = status(timed)
    assert j["modes"] == {"whatsapp": "manual", "facebook": "manual", "instagram": "manual"}
    assert j["schedules"] == {"whatsapp": None, "facebook": None, "instagram": None}
    assert j["channels"] == j["manual"] == {"whatsapp": False, "facebook": False, "instagram": False}
    assert staff.get("/api/settings/bot").get_json()["modes"]["facebook"] == "manual"


def test_pasar_a_horario_exige_un_horario_valido_y_no_cambia_nada_si_falla(timed, staff):
    r = staff.put("/api/settings/bot", {"channel": "facebook", "mode": "schedule"})            # sin horario guardado ni nuevo
    assert r.status_code == 400 and "horario" in r.get_json()["detail"]
    assert status(timed)["modes"]["facebook"] == "manual"
    r = staff.put("/api/settings/bot", {"channel": "facebook", "mode": "schedule", "schedule": {"days": [], "start": "19:00", "end": "08:00"}})
    assert r.status_code == 400
    assert status(timed)["schedules"]["facebook"] is None


def test_en_horario_el_bot_se_enciende_y_apaga_solo_con_la_hora(timed, staff, clock):
    j = staff.put("/api/settings/bot", {"channel": "facebook", "mode": "schedule", "schedule": NIGHT}).get_json()
    assert j["modes"]["facebook"] == "schedule" and j["schedules"]["facebook"] == NIGHT
    assert j["channels"]["facebook"] is False and j["manual"]["facebook"] is False       # mediodia del miercoles: fuera del horario
    assert j["evaluatedAt"].endswith("Z")

    clock.t = at(11, "19:30")
    assert status(timed)["channels"]["facebook"] is True                                 # empezo el horario
    assert staff.get("/api/settings/bot").get_json()["channels"]["facebook"] is True     # el personal ve lo mismo que el bot
    clock.t = at(12, "03:00")
    assert status(timed)["channels"]["facebook"] is True                                 # madrugada del jueves: sigue
    clock.t = at(12, "08:00")
    assert status(timed)["channels"]["facebook"] is False                                # termino
    clock.t = at(14, "10:00")
    assert status(timed)["channels"]["facebook"] is False                                # sabado
    clock.t = at(14, "01:00")
    assert status(timed)["channels"]["facebook"] is True                                 # la noche del viernes llega al sabado de madrugada


def test_el_interruptor_manual_se_conserva_y_no_manda_en_modo_horario(timed, staff, clock):
    staff.put("/api/settings/bot", {"channel": "instagram", "active": True})
    j = staff.put("/api/settings/bot", {"channel": "instagram", "mode": "schedule", "schedule": NIGHT}).get_json()
    assert j["manual"]["instagram"] is True and j["channels"]["instagram"] is False      # el horario manda: ahora esta fuera
    clock.t = at(11, "19:30")                    # (la sesion del personal vence tras 8 h sin actividad: no se salta mas que eso)
    assert status(timed)["channels"]["instagram"] is True
    staff.put("/api/settings/bot", {"channel": "instagram", "active": False})            # cambiar el manual no cambia lo efectivo en horario
    assert status(timed)["channels"]["instagram"] is True and status(timed)["manual"]["instagram"] is False
    j = staff.put("/api/settings/bot", {"channel": "instagram", "mode": "manual"}).get_json()
    assert j["channels"]["instagram"] is False and j["schedules"]["instagram"] == NIGHT  # vuelve a mandar el interruptor; el horario queda guardado
    j = staff.put("/api/settings/bot", {"channel": "instagram", "mode": "schedule"}).get_json()   # ...y se puede volver a usar sin redefinirlo
    assert j["modes"]["instagram"] == "schedule" and j["channels"]["instagram"] is True


def test_los_canales_son_independientes_y_active_es_el_efectivo_de_whatsapp(timed, staff, clock):
    staff.put("/api/settings/bot", {"channels": {"facebook": True}})                      # Messenger manual encendido
    staff.put("/api/settings/bot", {"channel": "whatsapp", "mode": "schedule", "schedule": OFFICE})
    j = status(timed)
    assert j["channels"] == {"whatsapp": True, "facebook": True, "instagram": False}      # el mediodia de un miercoles esta en horario de oficina
    assert j["active"] is True and j["active"] is j["channels"]["whatsapp"]
    clock.t = at(11, "19:30")
    j = status(timed)
    assert j["channels"] == {"whatsapp": False, "facebook": True, "instagram": False} and j["active"] is False
    assert j["modes"] == {"whatsapp": "schedule", "facebook": "manual", "instagram": "manual"}


def test_solo_el_horario_o_solo_el_modo_o_todo_junto(timed, staff, clock):
    staff.put("/api/settings/bot", {"channel": "facebook", "schedule": NIGHT})            # guardar el horario no cambia el modo
    assert status(timed)["modes"]["facebook"] == "manual"
    clock.t = at(11, "19:30")
    assert status(timed)["channels"]["facebook"] is False
    staff.put("/api/settings/bot", {"channel": "facebook", "mode": "schedule"})            # y el modo usa el horario ya guardado
    assert status(timed)["channels"]["facebook"] is True
    other = {"days": ["sat", "sun"], "start": "10:00", "end": "14:00"}
    j = staff.put("/api/settings/bot", {"channel": "facebook", "mode": "schedule", "schedule": other, "active": True}).get_json()
    assert j["schedules"]["facebook"] == other and j["manual"]["facebook"] is True and j["channels"]["facebook"] is False


@pytest.mark.parametrize("body", [
    {"channel": "facebook", "mode": "automatico"}, {"channel": "facebook", "mode": None}, {"channel": "facebook", "mode": 1},
    {"channel": "facebook", "schedule": "19:00-08:00"}, {"channel": "facebook", "schedule": {"days": ["mon"], "start": "19:00", "end": "19:00"}},
    {"channel": "facebook", "schedule": {**NIGHT, "days": ["lunes"]}}, {"channel": "facebook", "schedule": None},
    {"channel": "telegram", "mode": "manual"}, {"channel": "facebook", "foo": 1, "mode": "manual"},
    {"channels": {"facebook": True}, "mode": "manual"}, {"channel": "facebook", "mode": "manual", "active": "si"},
])
def test_peticiones_invalidas_son_400_y_no_cambian_nada(timed, staff, body):
    r = staff.put("/api/settings/bot", body)
    assert r.status_code == 400 and r.get_json()["error"] == "validacion", (body, r.get_json())
    j = status(timed)
    assert j["modes"] == {"whatsapp": "manual", "facebook": "manual", "instagram": "manual"} and j["schedules"]["facebook"] is None


def test_una_peticion_con_un_error_no_cambia_ni_lo_valido(timed, staff):
    r = staff.put("/api/settings/bot", {"channel": "facebook", "active": True, "mode": "schedule"})   # sin horario: todo o nada
    assert r.status_code == 400
    j = status(timed)
    assert j["manual"]["facebook"] is False and j["modes"]["facebook"] == "manual"


def test_solo_el_personal_cambia_modo_y_horario(timed, people):
    from helpers import Session
    c = timed.test_client()
    assert c.put("/api/settings/bot", json={"channel": "facebook", "mode": "manual"}).status_code in (401, 403)
    doctor = Session(timed, people["doctor"][0])
    assert doctor.put("/api/settings/bot", {"channel": "facebook", "mode": "manual"}).status_code == 403
    assert doctor.get("/api/settings/bot").status_code == 403


def test_la_bitacora_guarda_un_aviso_por_cambio_con_el_canal(timed, staff, db):
    staff.put("/api/settings/bot", {"channel": "facebook", "mode": "schedule", "schedule": NIGHT, "active": True})
    with db() as s:
        acts = [(a.action, a.entity_id, a.data) for a in s.scalars(select(AuditLog).order_by(AuditLog.id)) if a.action.startswith("bot.")]
    assert acts == [("bot.set_active", "bot_active.facebook", {"active": True, "channel": "facebook"}),
                    ("bot.set_schedule", "bot_schedule.facebook", {"channel": "facebook", **NIGHT}),
                    ("bot.set_mode", "bot_mode.facebook", {"channel": "facebook", "mode": "schedule"})]


def test_quien_y_cuando_es_lo_ultimo_que_se_cambio_del_canal(timed, staff, clock):
    j = staff.put("/api/settings/bot", {"channel": "facebook", "mode": "schedule", "schedule": NIGHT}).get_json()
    assert j["channelUpdates"]["facebook"]["updatedBy"] == "Recepcion Prueba" and j["channelUpdates"]["facebook"]["updatedAt"]
    assert j["channelUpdates"]["instagram"]["updatedBy"] is None


def test_falla_cerrado_si_el_horario_guardado_no_sirve(timed, staff, db):
    staff.put("/api/settings/bot", {"channel": "facebook", "mode": "schedule", "schedule": NIGHT})
    with db() as s, s.begin():                                   # alguien (o un error) deja un horario roto
        s.get(Setting, "bot_schedule.facebook").value = {"days": ["mon"], "start": "x", "end": "y"}
    j = status(timed)
    assert j["modes"]["facebook"] == "schedule" and j["schedules"]["facebook"] is None and j["channels"]["facebook"] is False
    with db() as s, s.begin():
        s.get(Setting, "bot_mode.facebook").value = "raro"        # un modo desconocido es manual
    assert status(timed)["modes"]["facebook"] == "manual"


def test_la_cola_ve_el_estado_efectivo_del_canal(timed, staff, clock):
    """El bot decide si contesta por `GET /api/bot/status`: en horario, el evento se atiende; fuera, se cierra como `skipped_bot_inactive`."""
    staff.put("/api/settings/bot", {"channel": "facebook", "mode": "schedule", "schedule": NIGHT})
    clock.t = at(11, "23:00")
    assert status(timed)["channels"]["facebook"] is True
    clock.t = at(12, "09:00")
    assert status(timed)["channels"]["facebook"] is False
