"""Horarios libres para mover una cita (el calendario emergente del formulario «Mover»): `GET /api/appointments/{id}/move-slots`.

La prueba central es la de CONSISTENCIA: lo que se lista es exactamente lo que `PATCH /api/appointments/{id}` acepta. Reloj fijo:
lunes 2026-11-09, 10:00 hora de Cancun (15:00 UTC). La clinica atiende L-V 9-18 y sabados 9-13.
"""
from datetime import date, datetime, timedelta
from types import SimpleNamespace

import pytest

from app.db import iso_utc, to_db
from helpers import Clock, Session, assert_schema, make_users

MON, TUE, WED, THU, FRI, SAT, SUN = (date(2026, 11, 9) + timedelta(days=i) for i in range(7))
ALL_DAY = [f"{h:02d}:{m:02d}" for h in range(9, 18) for m in (0, 30)]            # 09:00 .. 17:30 (18 inicios de 30 min)


def utc(dt):
    return iso_utc(to_db(dt))


@pytest.fixture
def env(make_app):
    clock = Clock()
    app = make_app(clock=clock)
    make_users(app)
    tz = app.extensions["rules"].tz
    return SimpleNamespace(app=app, clock=clock, tz=tz, agenda=app.extensions["agenda"],
                           staff=Session(app, "recepcion@clinica.test"), admin=Session(app, "admin@clinica.test"),
                           doctor=Session(app, "dr.cervantes@clinica.test"))


def at(env, day, hhmm):
    h, m = map(int, hhmm.split(":"))
    return datetime(day.year, day.month, day.day, h, m, tzinfo=env.tz)


def book(env, doctor_id, day, hhmm, minutes=30, name="Ana Lopez"):
    return env.agenda.create_booking(start=at(env, day, hhmm), patient_name=name, phone="5219981110001", doctor_id=doctor_id,
                                     duration_minutes=minutes, allow_short_notice=True)


def block(env, room_id, day, hhmm, minutes=60):
    return env.agenda.create_booking(kind="block", room_id=room_id, start=at(env, day, hhmm), duration_minutes=minutes)


def slots(env, appointment, start, end, sess=None, **q):
    r = (sess or env.staff).get(f"/api/appointments/{appointment.id}/move-slots",
                                query_string={"from": start.isoformat(), "to": end.isoformat(), **q})
    assert r.status_code == 200, r.get_json()
    j = r.get_json()
    assert_schema("FreeSlots", j)
    return {d["date"]: d["slots"] for d in j["days"]}, j


def accepted(env, appointment, day, hhmm, **extra):
    r = env.staff.patch(f"/api/appointments/{appointment.id}", {"scheduledAtUtc": utc(at(env, day, hhmm)), **extra})
    return r.status_code == 200


# ------------------------------------------------------------------ lo que se lista
def test_lista_por_dia_los_horarios_de_la_clinica_y_su_propio_horario_cuenta_como_libre(env):
    a = book(env, 1, TUE, "10:00")
    d, j = slots(env, a, MON, MON + timedelta(days=8))
    assert j["slotMinutes"] == 30 and j["durationMinutes"] == 30
    assert d[MON.isoformat()] == [s for s in ALL_DAY if s >= "11:00"]                   # hoy: faltan 60 min de antelacion (son las 10:00)
    assert d[TUE.isoformat()] == ALL_DAY and "10:00" in d[TUE.isoformat()]              # su horario actual cuenta como libre para ella
    assert d[WED.isoformat()] == ALL_DAY and d[FRI.isoformat()] == ALL_DAY
    assert d[SAT.isoformat()] == ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30"]
    assert SUN.isoformat() not in d                                                      # domingo no se atiende: ni sale el dia
    assert (MON + timedelta(days=7)).isoformat() in d                                    # el siguiente lunes
    assert list(d) == sorted(d)


def test_otra_cita_del_doctor_o_los_dos_consultorios_ocupados_quitan_el_horario(env):
    a = book(env, 1, TUE, "10:00")
    book(env, 1, TUE, "11:00", name="Beto Ruiz")                  # el mismo doctor: ocupado
    book(env, 2, WED, "11:30", name="Carla Mena")                  # otro doctor: ocupa UN consultorio
    d, _ = slots(env, a, TUE, THU)
    assert "11:00" not in d[TUE.isoformat()] and "10:30" in d[TUE.isoformat()] and "11:30" in d[TUE.isoformat()]
    assert "11:30" in d[WED.isoformat()]                           # un consultorio libre basta
    book(env, 3, WED, "11:30", name="Diego Pardo")                 # y otro doctor en el segundo consultorio: ya no hay donde
    d, _ = slots(env, a, TUE, THU)
    assert "11:30" not in d[WED.isoformat()] and "11:00" in d[WED.isoformat()] and "12:00" in d[WED.isoformat()]


def test_una_cita_larga_necesita_todos_sus_huecos_libres(env):
    a = book(env, 1, TUE, "10:00", minutes=60)
    book(env, 1, TUE, "12:00", name="Beto Ruiz")
    d, j = slots(env, a, TUE, WED)
    assert j["durationMinutes"] == 60
    t = d[TUE.isoformat()]
    assert "09:30" in t and "10:00" in t and "10:30" in t       # se solapa con su propio horario: eso no estorba
    assert "11:00" in t and "11:30" not in t and "12:00" not in t   # 11:30-12:30 pisa la cita de las 12:00
    assert "12:30" in t and "17:00" in t and "17:30" not in t       # 17:30-18:30 se sale del horario de la clinica


def test_las_ausencias_y_los_eventos_personales_del_doctor_quitan_horarios(env):
    a = book(env, 1, TUE, "10:00")
    assert env.admin.post("/api/doctors/1/absences", {"startUtc": utc(at(env, TUE, "14:00")), "endUtc": utc(at(env, TUE, "16:00"))}).status_code == 201
    assert env.doctor.post("/api/doctor/personal-events", {"title": "Dentista", "startUtc": utc(at(env, WED, "09:00")), "endUtc": utc(at(env, WED, "10:00"))}).status_code == 201
    d, _ = slots(env, a, TUE, THU)
    assert [s for s in ALL_DAY if s not in d[TUE.isoformat()]] == ["14:00", "14:30", "15:00", "15:30"]
    assert [s for s in ALL_DAY if s not in d[WED.isoformat()]] == ["09:00", "09:30"]
    assert "Dentista" not in str(d)                                # el motivo es privado


def test_con_horario_propio_del_doctor_solo_salen_sus_horas(env):
    a = book(env, 1, TUE, "10:00")
    assert env.admin.put("/api/doctors/1/weekly-hours", {"weeklyHours": {"tue": [{"start": "10:00", "end": "12:00"}]}}).status_code == 200
    d, _ = slots(env, a, TUE, SAT)
    assert d == {TUE.isoformat(): ["10:00", "10:30", "11:00", "11:30"]}


def test_un_doctor_dado_de_baja_no_ofrece_horarios(env):
    a = book(env, 1, TUE, "10:00")
    assert env.admin.patch("/api/doctors/1", {"active": False}).status_code == 200
    assert slots(env, a, TUE, SAT)[0] == {}


def test_con_roomid_solo_cuentan_los_huecos_libres_de_ese_consultorio(env):
    a = book(env, 1, TUE, "10:00")                                    # cae en el consultorio 1
    book(env, 2, WED, "11:00", name="Beto Ruiz")                      # el otro doctor ocupa el consultorio 1 el miercoles
    d_any, _ = slots(env, a, WED, THU)
    d_r1, _ = slots(env, a, WED, THU, roomId="1")
    d_r2, _ = slots(env, a, WED, THU, roomId="2")
    assert "11:00" in d_any[WED.isoformat()] and "11:00" not in d_r1[WED.isoformat()] and "11:00" in d_r2[WED.isoformat()]


def test_horizonte_de_60_dias_y_cita_de_mostrador(env):
    a = book(env, 1, TUE, "10:00")
    d, _ = slots(env, a, date(2027, 1, 7), date(2027, 1, 10))        # el limite es 2027-01-08 10:00 (60 dias despues de "ahora")
    assert d == {"2027-01-07": ALL_DAY, "2027-01-08": ["09:00", "09:30", "10:00"]}
    assert slots(env, a, date(2027, 2, 1), date(2027, 2, 8))[0] == {}
    corto, _ = slots(env, a, MON, TUE, allowShortNotice="true")
    assert corto[MON.isoformat()][0] == "10:00" and slots(env, a, MON, TUE)[0][MON.isoformat()][0] == "11:00"


def test_pasado_no_se_ofrece(env):
    a = book(env, 1, TUE, "10:00")
    assert slots(env, a, date(2026, 11, 1), MON, allowShortNotice="true")[0] == {}


# ------------------------------------------------------------------ CONSISTENCIA con lo que PATCH acepta
def _prepare_mixed_agenda(env):
    """Una semana con de todo: citas de otros doctores, ausencia, evento personal, horario propio y los dos consultorios llenos."""
    a = book(env, 1, TUE, "10:00")
    book(env, 1, WED, "12:00", name="Beto Ruiz")
    book(env, 2, THU, "10:00", name="Carla Mena")
    book(env, 3, THU, "10:00", name="Diego Pardo")                   # los dos consultorios llenos el jueves a las 10:00
    book(env, 2, FRI, "09:30", minutes=60, name="Elena Soto")
    assert env.admin.post("/api/doctors/1/absences", {"startUtc": utc(at(env, FRI, "15:00")), "endUtc": utc(at(env, FRI, "17:00"))}).status_code == 201
    assert env.doctor.post("/api/doctor/personal-events", {"title": "Comida", "startUtc": utc(at(env, TUE, "16:00")), "endUtc": utc(at(env, TUE, "17:00"))}).status_code == 201
    return a


def test_lo_que_se_lista_es_exactamente_lo_que_patch_acepta(env):
    a = _prepare_mixed_agenda(env)
    days = [MON + timedelta(days=i) for i in range(8)]
    listed, _ = slots(env, a, days[0], days[-1] + timedelta(days=1))
    mismatches = []
    for day in days:
        for h in range(7, 20):
            for m in (0, 30):
                hhmm = f"{h:02d}:{m:02d}"
                expected = hhmm in listed.get(day.isoformat(), [])
                if accepted(env, a, day, hhmm) != expected:
                    mismatches.append((day.isoformat(), hhmm, "listado" if expected else "no listado"))
    assert mismatches == []
    # el horario de la cita no cambia por mirar: sigue siendo una cita agendada que se puede volver a consultar
    assert slots(env, a, days[0], days[-1] + timedelta(days=1))[0] == listed


def test_lo_mismo_para_un_consultorio_concreto_y_para_una_cita_larga(env):
    a = book(env, 1, TUE, "10:00", minutes=60)
    book(env, 2, WED, "11:00", name="Beto Ruiz")
    book(env, 3, THU, "09:30", name="Carla Mena")
    for room in ("1", "2"):
        listed, _ = slots(env, a, TUE, SAT, roomId=room)
        bad = []
        for day in (TUE, WED, THU, FRI):
            for h in range(8, 19):
                for m in (0, 30):
                    hhmm = f"{h:02d}:{m:02d}"
                    if accepted(env, a, day, hhmm, roomId=room) != (hhmm in listed.get(day.isoformat(), [])):
                        bad.append((room, day.isoformat(), hhmm))
        assert bad == []


def test_con_cita_de_mostrador_tambien_coincide_hoy(env):
    a = book(env, 1, TUE, "10:00")
    listed, _ = slots(env, a, MON, TUE, allowShortNotice="true")
    bad = []
    for h in range(8, 19):
        for m in (0, 30):
            hhmm = f"{h:02d}:{m:02d}"
            if accepted(env, a, MON, hhmm, allowShortNotice=True) != (hhmm in listed.get(MON.isoformat(), [])):
                bad.append(hhmm)
    assert bad == []


# ------------------------------------------------------------------ bloqueos de consultorio
def test_un_bloqueo_ofrece_los_inicios_de_7_a_20_donde_su_consultorio_este_libre_y_coincide_con_patch(env):
    blk = block(env, 1, TUE, "13:00", minutes=60)
    book(env, 1, TUE, "15:00")                                        # cae en el consultorio 1 (el primero libre)
    listed, j = slots(env, blk, MON, THU)
    assert j["durationMinutes"] == 60
    t = listed[TUE.isoformat()]
    assert t[0] == "07:00" and t[-1] == "19:30" and "13:00" in t      # su propio horario cuenta como libre
    assert "14:00" in t and "14:30" not in t and "15:00" not in t and "15:30" in t   # un bloqueo de 60 min no pisa la cita de las 15:00
    assert MON.isoformat() in listed and listed[MON.isoformat()][0] == "09:30"        # hoy: el que ya termino no; 09:30-10:30 sigue en curso
    bad = []
    for day in (MON, TUE):
        for h in range(7, 20):
            for m in (0, 30):
                hhmm = f"{h:02d}:{m:02d}"
                if accepted(env, blk, day, hhmm) != (hhmm in listed.get(day.isoformat(), [])):
                    bad.append((day.isoformat(), hhmm))
    assert bad == []


# ------------------------------------------------------------------ errores y permisos
def test_errores(env):
    a = book(env, 1, TUE, "10:00")
    q = lambda **kw: env.staff.get(f"/api/appointments/{a.id}/move-slots", query_string=kw)
    assert q(**{"from": "2026-11-10", "to": "2026-11-10"}).get_json()["error"] == "rango_invalido"       # to <= from
    assert q(**{"from": "2026-11-10", "to": "2026-11-09"}).status_code == 422
    assert q(**{"from": "2026-11-10", "to": "2026-12-22"}).status_code == 200                              # 42 dias justos
    r = q(**{"from": "2026-11-10", "to": "2026-12-23"})                                                    # 43
    assert r.status_code == 422 and r.get_json()["error"] == "rango_invalido"
    for bad in ({}, {"from": "2026-11-10"}, {"to": "2026-11-12"}, {"from": "ayer", "to": "hoy"}, {"from": "2026-11-10", "to": "2026-11-12", "roomId": "x"},
                {"from": "2026-11-10", "to": "2026-11-12", "roomId": "99"}, {"from": "2026-11-10", "to": "2026-11-12", "allowShortNotice": "quizas"}):
        r = q(**bad)
        assert r.status_code == 422 and r.get_json()["error"] in ("validacion", "rango_invalido"), bad
    assert env.staff.get("/api/appointments/9999/move-slots", query_string={"from": "2026-11-10", "to": "2026-11-12"}).status_code == 404
    assert env.staff.get("/api/appointments/abc/move-slots", query_string={"from": "2026-11-10", "to": "2026-11-12"}).status_code == 404


def test_una_cita_cancelada_o_ya_realizada_no_se_mueve(env):
    a = book(env, 1, TUE, "10:00")
    assert env.staff.patch(f"/api/appointments/{a.id}", {"status": "cancelada"}).status_code == 200
    r = env.staff.get(f"/api/appointments/{a.id}/move-slots", query_string={"from": "2026-11-10", "to": "2026-11-12"})
    assert r.status_code == 409 and r.get_json()["error"] == "transicion_invalida"


def test_el_doctor_no_puede_consultarlo_y_la_respuesta_no_trae_datos_de_pacientes(env):
    a = book(env, 1, TUE, "10:00", name="Paciente Secreto")
    r = env.doctor.client.get(f"/api/appointments/{a.id}/move-slots", query_string={"from": "2026-11-10", "to": "2026-11-12"})
    assert r.status_code == 403
    text = env.staff.get(f"/api/appointments/{a.id}/move-slots", query_string={"from": "2026-11-10", "to": "2026-11-12"}).get_data(as_text=True)
    assert "Secreto" not in text and "5219981110001" not in text


# ====================================================================== cita NUEVA: GET /api/availability
def avail(env, start, end, **q):
    r = env.staff.get("/api/availability", query_string={"from": start.isoformat(), "to": end.isoformat(), **q})
    assert r.status_code == 200, r.get_json()
    j = r.get_json()
    assert_schema("FreeSlots", j)
    return {d["date"]: d["slots"] for d in j["days"]}, j


def creates(env, day, hhmm, **body):
    """¿`POST /api/appointments` la acepta? Si la crea, la cancela de inmediato (libera el hueco para la siguiente prueba)."""
    payload = {"kind": "session", "patientName": "Zoe Prueba", "scheduledAtUtc": utc(at(env, day, hhmm)), **body}
    r = env.staff.post("/api/appointments", payload)
    if r.status_code != 201:
        return False
    assert env.staff.patch(f"/api/appointments/{r.get_json()['id']}", {"status": "cancelada"}).status_code == 200
    return True


def test_cita_nueva_lista_los_horarios_del_doctor_y_ninguno_es_propio(env):
    book(env, 1, TUE, "10:00")                                         # ya hay una cita de ese doctor: para la NUEVA no cuenta como libre
    d, j = avail(env, MON, MON + timedelta(days=8), doctorId="1")
    assert j["slotMinutes"] == 30 and j["durationMinutes"] == 30
    assert d[MON.isoformat()] == [s for s in ALL_DAY if s >= "11:00"]  # hoy: faltan 60 min de antelacion
    assert d[TUE.isoformat()] == [s for s in ALL_DAY if s != "10:00"]
    assert d[SAT.isoformat()][-1] == "12:30" and SUN.isoformat() not in d
    d60, j60 = avail(env, TUE, WED, doctorId="1", durationMinutes="60")
    assert j60["durationMinutes"] == 60
    t60 = d60[TUE.isoformat()]
    assert "09:30" not in t60 and "10:00" not in t60                  # 09:30-10:30 y 10:00-11:00 pisan la cita de las 10:00
    assert "09:00" in t60 and "10:30" in t60 and "11:00" in t60       # 09:00-10:00 y 10:30-11:30 caben
    assert "17:00" in d60[TUE.isoformat()] and "17:30" not in d60[TUE.isoformat()]


def test_cita_nueva_lo_que_se_lista_es_exactamente_lo_que_post_acepta(env):
    _prepare_mixed_agenda(env)
    days = [MON + timedelta(days=i) for i in range(8)]
    bad = []
    for minutes, extra in ((30, {}), (60, {}), (30, {"roomId": "2"}), (30, {"allowShortNotice": True})):
        q = {"doctorId": "1", "durationMinutes": str(minutes), **({"roomId": "2"} if "roomId" in extra else {}), **({"allowShortNotice": "true"} if "allowShortNotice" in extra else {})}
        listed, _ = avail(env, days[0], days[-1] + timedelta(days=1), **q)
        for day in days if minutes == 30 and not extra else days[:5]:
            for h in range(8, 19):
                for m in (0, 30):
                    hhmm = f"{h:02d}:{m:02d}"
                    ok = creates(env, day, hhmm, doctorId="1", durationMinutes=minutes, **extra)
                    if ok != (hhmm in listed.get(day.isoformat(), [])):
                        bad.append((minutes, tuple(extra), day.isoformat(), hhmm))
    assert bad == []


def test_bloqueo_nuevo_ofrece_de_7_a_20_donde_su_consultorio_este_libre_y_coincide_con_post(env):
    book(env, 1, TUE, "15:00")                                         # ocupa el consultorio 1
    listed, j = avail(env, MON, THU, kind="block", roomId="1", durationMinutes="60")
    assert j["durationMinutes"] == 60
    t = listed[TUE.isoformat()]
    assert t[0] == "07:00" and t[-1] == "19:30" and "14:00" in t and "14:30" not in t and "15:00" not in t and "15:30" in t
    assert listed[MON.isoformat()][0] == "09:30"                       # hoy: el que ya termino no; 09:30-10:30 sigue en curso
    r2, _ = avail(env, TUE, WED, kind="block", roomId="2", durationMinutes="60")
    assert "14:30" in r2[TUE.isoformat()]                              # el consultorio 2 si esta libre
    bad = []
    for day in (MON, TUE):
        for h in range(7, 20):
            for m in (0, 30):
                hhmm = f"{h:02d}:{m:02d}"
                body = {"kind": "block", "roomId": "1", "durationMinutes": 60}
                r = env.staff.post("/api/appointments", {"scheduledAtUtc": utc(at(env, day, hhmm)), **body})
                ok = r.status_code == 201
                if ok:
                    assert env.staff.patch(f"/api/appointments/{r.get_json()['id']}", {"status": "cancelada"}).status_code == 200
                if ok != (hhmm in listed.get(day.isoformat(), [])):
                    bad.append((day.isoformat(), hhmm))
    assert bad == []


def test_cita_nueva_con_doctor_de_baja_o_con_ausencia(env):
    assert env.admin.post("/api/doctors/2/absences", {"startUtc": utc(at(env, TUE, "09:00")), "endUtc": utc(at(env, TUE, "12:00"))}).status_code == 201
    d, _ = avail(env, TUE, WED, doctorId="2")
    assert d[TUE.isoformat()][0] == "12:00"
    assert env.admin.patch("/api/doctors/2", {"active": False}).status_code == 200
    assert avail(env, TUE, SAT, doctorId="2")[0] == {}


def test_cita_nueva_errores_y_permisos(env):
    q = lambda **kw: env.staff.get("/api/availability", query_string={"from": "2026-11-10", "to": "2026-11-12", **kw})
    for bad in ({}, {"doctorId": "999"}, {"doctorId": "x"}, {"doctorId": "1", "roomId": "99"}, {"doctorId": "1", "durationMinutes": "45"},
                {"doctorId": "1", "durationMinutes": "0"}, {"doctorId": "1", "durationMinutes": "9999"}, {"doctorId": "1", "kind": "otra"},
                {"doctorId": "1", "allowShortNotice": "quizas"}, {"kind": "block"}, {"kind": "block", "roomId": "1", "doctorId": "1"},
                {"kind": "block", "roomId": "99"}):
        r = q(**bad)
        assert r.status_code == 422 and r.get_json()["error"] in ("validacion", "rango_invalido"), bad
    assert env.staff.get("/api/availability", query_string={"from": "2026-11-10", "to": "2026-11-10", "doctorId": "1"}).get_json()["error"] == "rango_invalido"
    assert env.staff.get("/api/availability", query_string={"from": "2026-11-10", "to": "2026-12-23", "doctorId": "1"}).status_code == 422   # 43 dias
    assert env.staff.get("/api/availability", query_string={"from": "2026-11-10", "to": "2026-12-22", "doctorId": "1"}).status_code == 200
    assert env.doctor.client.get("/api/availability", query_string={"from": "2026-11-10", "to": "2026-11-12", "doctorId": "1"}).status_code == 403
