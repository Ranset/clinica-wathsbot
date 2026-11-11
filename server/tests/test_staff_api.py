"""API del personal y el administrador: citas, bloqueos, horarios, ausencias y solicitudes de cambio de horario.
Las respuestas se validan contra `docs/openapi.yaml`."""
from datetime import timedelta

import pytest

from app.agenda import iso
from helpers import assert_schema, next_weekday


def utc(dt):
    """Instante para el JSON de la API: UTC con `Z`."""
    from app.db import iso_utc, to_db
    return iso_utc(to_db(dt))


def new_booking(s, agenda, t, **over):
    body = {"patientName": "Ana Lopez", "phone": "5219981110001", "doctorId": "1", "scheduledAtUtc": utc(t)}
    body.update(over)
    return s.post("/api/appointments", body)


# ------------------------------------------------------------------ citas
def test_alta_manual_cumple_el_contrato_y_el_personal_ve_el_telefono(login, agenda):
    s = login("staff")
    t = next_weekday(agenda, 1, 10)
    r = new_booking(s, agenda, t, notes="trae estudios")
    j = r.get_json()
    assert r.status_code == 201 and j["kind"] == "session" and j["status"] == "agendada" and j["source"] == "manual"
    assert j["patient"] == {"id": "5219981110001", "name": "Ana Lopez", "phone": "5219981110001"}
    assert j["doctor"]["id"] == "1" and j["room"]["name"] and j["notes"] == "trae estudios"
    assert j["scheduledAtUtc"] == utc(t) and j["durationMinutes"] == 30
    assert_schema("Booking", j)
    assert s.get(f"/api/appointments/{j['id']}").get_json() == j


def test_cita_de_mostrador_sin_telefono_usa_el_id_de_la_cita_como_paciente(login, agenda):
    s = login("staff")
    j = new_booking(s, agenda, next_weekday(agenda, 1, 10), phone=None).get_json()
    assert j["patient"] == {"id": j["id"], "name": "Ana Lopez"}
    assert_schema("Booking", j)


def test_bloqueo_de_consultorio(login, agenda):
    s = login("admin")
    t = next_weekday(agenda, 2, 11)
    r = s.post("/api/appointments", {"kind": "block", "roomId": "1", "scheduledAtUtc": utc(t), "durationMinutes": 60,
                                     "notes": "mantenimiento"})
    j = r.get_json()
    assert r.status_code == 201 and j["kind"] == "block" and j["patient"] is None and j["doctor"] is None
    assert j["durationMinutes"] == 60 and j["room"]["id"] == "1"
    assert_schema("Booking", j)
    # un bloqueo ocupa su consultorio: otra cita a esa hora usa el otro, y la 3.a no cabe
    assert new_booking(s, agenda, t, doctorId="1").status_code == 201
    r = new_booking(s, agenda, t, doctorId="2", patientName="Beto Ruiz", phone=None)
    assert r.status_code == 409 and r.get_json()["error"] == "horario_ocupado"


def test_errores_al_crear(login, agenda):
    s = login("staff")
    t = next_weekday(agenda, 1, 10)
    casos = [({"patientName": "Beto"}, "falta_nombre_completo"),
             ({"doctorId": None}, "validacion"), ({"doctorId": "999"}, "validacion"),
             ({"scheduledAtUtc": utc(next_weekday(agenda, 6, 10))}, "fuera_de_horario"),
             ({"scheduledAtUtc": utc(agenda.now())}, "horario_pasado_o_muy_cercano"),
             ({"scheduledAtUtc": utc(t + timedelta(days=90))}, "fuera_de_rango"),
             ({"scheduledAtUtc": utc(t + timedelta(minutes=10))}, "fuera_de_horario"),       # no alineada a la rejilla de 30 min
             ({"durationMinutes": 45}, "validacion"), ({"kind": "otra"}, "validacion")]
    for cambio, codigo in casos:
        r = new_booking(s, agenda, t, **cambio)
        assert r.get_json()["error"] == codigo, (cambio, r.get_json())
        assert r.status_code in (404, 422), cambio
        assert_schema("ErrorBody", r.get_json())
    for cambio in ({"phone": "abc"}, {"patientName": 5}, {"notes": 5}, {"allowShortNotice": "si"}, {"durationMinutes": "30"},
                   {"scheduledAtUtc": "manana"}, {"scheduledAtUtc": None}):
        r = new_booking(s, agenda, t, **cambio)
        assert r.status_code == 422 and r.get_json()["error"] == "validacion", cambio
    assert s.post("/api/appointments", {}).status_code == 422
    assert s.client.post("/api/appointments", data="no json", headers={"X-CSRF-Token": s.csrf}).status_code == 422


def test_allow_short_notice_omite_solo_los_60_minutos(login, agenda):
    s = login("staff")
    pronto = agenda.now() + timedelta(minutes=20)
    pronto = pronto.replace(minute=(pronto.minute // 30) * 30, second=0, microsecond=0) + timedelta(minutes=30)
    r = new_booking(s, agenda, pronto, allowShortNotice=False)
    # el motor acepta cualquier hora ya valida; lo que importa: con la bandera no se rechaza por antelacion
    assert r.get_json().get("error") in (None, "fuera_de_horario", "horario_pasado_o_muy_cercano")
    pasado = agenda.now() - timedelta(hours=2)
    r = new_booking(s, agenda, pasado, allowShortNotice=True)
    assert r.status_code == 422                                                   # una hora ya pasada se sigue rechazando


def test_lista_por_rango_con_filtros_y_etag(login, agenda):
    s = login("staff")
    t = next_weekday(agenda, 1, 10)
    a = new_booking(s, agenda, t).get_json()
    b = new_booking(s, agenda, t + timedelta(hours=1), doctorId="2", patientName="Beto Ruiz", phone=None).get_json()
    q = {"from": utc(t - timedelta(hours=1)), "to": utc(t + timedelta(hours=4))}
    r = s.get("/api/appointments", query_string=q)
    j = r.get_json()
    assert r.status_code == 200 and [x["id"] for x in j["items"]] == [a["id"], b["id"]] and j["serverTimeUtc"].endswith("Z")
    assert_schema("BookingList", j)
    assert [x["id"] for x in s.get("/api/appointments", query_string={**q, "doctorId": "2"}).get_json()["items"]] == [b["id"]]
    room = a["room"]["id"]                                       # a horas distintas ambas caen en el primer consultorio libre
    assert [x["id"] for x in s.get("/api/appointments", query_string={**q, "roomId": room}).get_json()["items"]] == [a["id"], b["id"]]
    assert s.get("/api/appointments", query_string={**q, "roomId": "2" if room == "1" else "1"}).get_json()["items"] == []
    assert s.get("/api/appointments", query_string={**q, "status": "cancelada"}).get_json()["items"] == []
    etag = r.headers["ETag"]
    r2 = s.get("/api/appointments", query_string=q, headers={"If-None-Match": etag})
    assert r2.status_code == 304 and r2.data == b"" and r2.headers["ETag"] == etag
    s.patch(f"/api/appointments/{a['id']}", {"notes": "cambio"})                    # algo cambia -> otro ETag, 200
    r3 = s.get("/api/appointments", query_string=q, headers={"If-None-Match": etag})
    assert r3.status_code == 200 and r3.headers["ETag"] != etag


def test_rango_maximo_92_dias_inclusive(login, agenda):
    s = login("staff")
    t0 = next_weekday(agenda, 0, 0)
    ok = s.get("/api/appointments", query_string={"from": utc(t0), "to": utc(t0 + timedelta(days=92))})
    assert ok.status_code == 200                                                    # la vista Lista pide EXACTAMENTE 92
    for q in ({"from": utc(t0), "to": utc(t0 + timedelta(days=92, minutes=1))}, {"from": utc(t0), "to": utc(t0)},
              {"from": utc(t0 + timedelta(days=1)), "to": utc(t0)}):
        r = s.get("/api/appointments", query_string=q)
        assert r.status_code == 422 and r.get_json()["error"] == "rango_invalido", q
    for q in ({}, {"from": utc(t0)}, {"to": utc(t0)}, {"from": "x", "to": "y"}, {"from": utc(t0), "to": utc(t0 + timedelta(days=1)), "status": "otro"},
              {"from": utc(t0), "to": utc(t0 + timedelta(days=1)), "doctorId": "abc"}):
        assert s.get("/api/appointments", query_string=q).status_code == 422, q


def test_estados_y_transiciones(login, agenda):
    s = login("staff")
    j = new_booking(s, agenda, next_weekday(agenda, 1, 10)).get_json()
    url = f"/api/appointments/{j['id']}"
    assert s.patch(url, {"status": "realizada"}).get_json()["status"] == "realizada"
    assert s.patch(url, {"status": "no_show"}).get_json()["status"] == "no_show"            # correccion permitida
    r = s.patch(url, {"status": "agendada"})
    assert r.status_code == 409 and r.get_json()["error"] == "transicion_invalida"
    k = new_booking(s, agenda, next_weekday(agenda, 2, 10)).get_json()
    assert s.patch(f"/api/appointments/{k['id']}", {"status": "cancelada"}).get_json()["status"] == "cancelada"
    assert s.patch(f"/api/appointments/{k['id']}", {"status": "realizada"}).status_code == 409     # cancelada es terminal
    assert s.patch(url, {"status": "inventado"}).status_code == 422


def test_cancelar_libera_el_hueco_y_mover_es_atomico(login, agenda):
    s = login("staff")
    t = next_weekday(agenda, 1, 10)
    a = new_booking(s, agenda, t).get_json()
    new_booking(s, agenda, t + timedelta(hours=1), doctorId="1", patientName="Beto Ruiz", phone=None)   # mismo doctor, otra hora
    r = s.patch(f"/api/appointments/{a['id']}", {"scheduledAtUtc": utc(t + timedelta(hours=1))})
    assert r.status_code == 409 and r.get_json()["error"] == "horario_ocupado"
    assert s.get(f"/api/appointments/{a['id']}").get_json()["scheduledAtUtc"] == utc(t)    # la original se conserva
    r = s.patch(f"/api/appointments/{a['id']}", {"scheduledAtUtc": utc(t + timedelta(hours=2))})
    assert r.status_code == 200 and r.get_json()["scheduledAtUtc"] == utc(t + timedelta(hours=2))
    s.patch(f"/api/appointments/{a['id']}", {"status": "cancelada"})
    assert new_booking(s, agenda, t + timedelta(hours=2), patientName="Carla Mena", phone=None).status_code == 201


def test_notas_se_editan_y_se_borran_con_null(login, agenda):
    s = login("staff")
    j = new_booking(s, agenda, next_weekday(agenda, 1, 10), notes="uno").get_json()
    url = f"/api/appointments/{j['id']}"
    assert s.patch(url, {"notes": "dos"}).get_json()["notes"] == "dos"
    assert s.patch(url, {"notes": None}).get_json()["notes"] is None
    assert s.patch(url, {"notes": "x" * 501}).status_code == 422
    assert s.patch(url, {}).status_code == 422                                              # minProperties: 1


@pytest.mark.parametrize("cita_id", ["999999", "abc", "0", "-1", "1;DROP"])
def test_citas_inexistentes_son_404(login, cita_id):
    s = login("staff")
    assert s.get(f"/api/appointments/{cita_id}").status_code == 404
    r = s.patch(f"/api/appointments/{cita_id}", {"notes": "x"})
    assert r.status_code == 404 and r.get_json()["error"] == "no_encontrado"


def test_los_cambios_del_personal_quedan_en_la_bitacora_sin_nombres(login, agenda, db):
    from sqlalchemy import select
    from app.models import AuditLog
    s = login("staff")
    new_booking(s, agenda, next_weekday(agenda, 1, 10))
    with db() as ses:
        logs = list(ses.scalars(select(AuditLog)))
    assert any(a.actor_kind == "user" and a.actor_user_id == int(s.user["id"]) for a in logs)
    assert "Ana" not in str([a.data for a in logs]) and "5219981110001" not in str([a.data for a in logs])


# ------------------------------------------------------------------ catalogos
def test_consultorios_horario_de_la_clinica_y_doctores(login):
    s = login("staff")
    assert [r["name"] for r in s.get("/api/rooms").get_json()["items"]] == ["Consultorio 1", "Consultorio 2"]
    hours = s.get("/api/clinic-hours").get_json()
    assert_schema("WeeklyHours", hours)
    assert hours["mon"] == [{"start": "09:00", "end": "18:00"}] and hours["sat"] == [{"start": "09:00", "end": "13:00"}] and "sun" not in hours
    docs = s.get("/api/doctors").get_json()["items"]
    assert len(docs) == 7 and docs[0]["usesClinicHours"] is True and docs[0]["weeklyHours"] == hours
    for d in docs:
        assert_schema("Doctor", d)


# ------------------------------------------------------------------ horario semanal y ausencias de un doctor
def test_horario_propio_del_doctor_lista_las_citas_afectadas_y_no_las_toca(login, agenda):
    s = login("staff")
    t = next_weekday(agenda, 1, 16)                                                          # martes 16:00
    cita = new_booking(s, agenda, t).get_json()
    corto = {"tue": [{"start": "09:00", "end": "12:00"}]}
    r = s.put("/api/doctors/1/weekly-hours", {"weeklyHours": corto})
    j = r.get_json()
    assert r.status_code == 200 and j["doctor"]["usesClinicHours"] is False and j["doctor"]["weeklyHours"] == corto
    assert [a["id"] for a in j["affectedAppointments"]] == [cita["id"]]
    assert_schema("Doctor", j["doctor"])
    assert s.get(f"/api/appointments/{cita['id']}").get_json()["status"] == "agendada"       # la cita NO se toco
    r = new_booking(s, agenda, next_weekday(agenda, 1, 17), patientName="Beto Ruiz", phone=None)   # ya no atiende por la tarde
    assert r.status_code == 422 and r.get_json()["error"] == "doctor_no_disponible"          # fuera de SU horario
    j = s.put("/api/doctors/1/weekly-hours", {"weeklyHours": None}).get_json()               # vuelve al horario de la clinica
    assert j["doctor"]["usesClinicHours"] is True and j["affectedAppointments"] == []


def test_horario_del_doctor_debe_caber_en_el_de_la_clinica(login):
    s = login("staff")
    for weekly in ({"sun": [{"start": "09:00", "end": "12:00"}]}, {"mon": [{"start": "08:00", "end": "12:00"}]},
                   {"mon": [{"start": "10:00", "end": "09:00"}]}, {"mon": [{"start": "09:10", "end": "12:00"}]},
                   {"lun": []}):
        r = s.put("/api/doctors/1/weekly-hours", {"weeklyHours": weekly})
        assert r.status_code == 422 and r.get_json()["error"] in ("fuera_de_horario", "validacion"), weekly
    assert s.put("/api/doctors/1/weekly-hours", {}).status_code == 422
    assert s.put("/api/doctors/1/weekly-hours", {"weeklyHours": [1]}).status_code == 422
    assert s.put("/api/doctors/999/weekly-hours", {"weeklyHours": None}).status_code == 404


def test_ausencias_del_doctor(login, agenda):
    s = login("staff")
    t = next_weekday(agenda, 1, 10)
    cita = new_booking(s, agenda, t).get_json()
    r = s.post("/api/doctors/1/absences", {"startUtc": utc(t - timedelta(hours=1)), "endUtc": utc(t + timedelta(hours=2)), "reason": "congreso"})
    j = r.get_json()
    assert r.status_code == 201 and j["absence"]["reason"] == "congreso" and [a["id"] for a in j["affectedAppointments"]] == [cita["id"]]
    assert_schema("AbsenceResult", j)
    assert new_booking(s, agenda, t + timedelta(hours=1), patientName="Beto Ruiz", phone=None).get_json()["error"] == "doctor_no_disponible"
    assert s.get(f"/api/appointments/{cita['id']}").get_json()["status"] == "agendada"       # no se cancela nada
    items = s.get("/api/doctors/1/absences").get_json()["items"]
    assert [a["id"] for a in items] == [j["absence"]["id"]]
    fuera = {"from": utc(t + timedelta(days=3)), "to": utc(t + timedelta(days=4))}
    assert s.get("/api/doctors/1/absences", query_string=fuera).get_json()["items"] == []
    assert s.get("/api/doctors/2/absences").get_json()["items"] == []                       # otro doctor: nada
    ab = j["absence"]["id"]
    assert s.delete(f"/api/doctors/2/absences/{ab}").status_code == 404                     # no es de ese doctor
    assert s.delete(f"/api/doctors/1/absences/{ab}").status_code == 204
    assert new_booking(s, agenda, t + timedelta(hours=1), patientName="Beto Ruiz", phone=None).status_code == 201   # vuelve a ofrecerse


@pytest.mark.parametrize("body", [{}, {"startUtc": "x", "endUtc": "y"}, {"startUtc": "2030-01-02T10:00Z", "endUtc": "2030-01-02T09:00Z"},
                                  {"startUtc": "2030-01-02T10:00Z", "endUtc": "2030-01-02T11:00Z", "reason": "x" * 201},
                                  {"startUtc": "2030-01-02T10:00Z", "endUtc": "2030-01-02T11:00Z", "reason": 5}])
def test_ausencia_invalida_es_422(login, body):
    r = login("staff").post("/api/doctors/1/absences", body)
    assert r.status_code == 422 and r.get_json()["error"] == "validacion"


def test_ausencias_de_todos_los_doctores_en_un_rango(login, agenda):
    s = login("staff")
    t = next_weekday(agenda, 1, 10)
    s.post("/api/doctors/1/absences", {"startUtc": utc(t), "endUtc": utc(t + timedelta(hours=2))})
    s.post("/api/doctors/3/absences", {"startUtc": utc(t + timedelta(days=1)), "endUtc": utc(t + timedelta(days=1, hours=2))})
    r = s.get("/api/absences", query_string={"from": utc(t - timedelta(days=1)), "to": utc(t + timedelta(days=3))})
    items = r.get_json()["items"]
    assert r.status_code == 200 and [a["doctorId"] for a in items] == ["1", "3"]
    for a in items:
        assert_schema("Absence", a)
    r = s.get("/api/absences", query_string={"from": utc(t + timedelta(days=10)), "to": utc(t + timedelta(days=11))})
    assert r.get_json()["items"] == []
    assert s.get("/api/absences").status_code == 422


# ------------------------------------------------------------------ solicitudes de cambio de horario
def test_aprobar_una_solicitud_aplica_el_horario_y_avisa_de_las_citas_afectadas(login, agenda, app):
    doc, staff = login("doctor"), login("staff")
    t = next_weekday(agenda, 1, 16)
    cita = new_booking(staff, agenda, t).get_json()                               # martes 16:00 con el doctor 1
    nuevo = {"tue": [{"start": "09:00", "end": "12:00"}]}
    r = doc.post("/api/doctor/schedule-change-requests", {"weeklyHours": nuevo, "effectiveFrom": (agenda.now().date() + timedelta(days=7)).isoformat(), "note": "consulta privada"})
    req = r.get_json()
    assert r.status_code == 201 and req["status"] == "pending" and req["doctorId"] == "1"
    pend = staff.get("/api/schedule-change-requests", query_string={"status": "pending"}).get_json()["items"]
    assert [x["id"] for x in pend] == [req["id"]]
    r = staff.post(f"/api/schedule-change-requests/{req['id']}/approve")
    j = r.get_json()
    assert r.status_code == 200 and j["status"] == "approved" and j["decidedBy"] == "Recepcion Prueba" and j["decidedAtUtc"]
    assert [a["id"] for a in j["affectedAppointments"]] == [cita["id"]]
    assert_schema("ScheduleChangeApplied", j)
    assert staff.get("/api/doctors").get_json()["items"][0]["weeklyHours"] == nuevo
    r = staff.post(f"/api/schedule-change-requests/{req['id']}/approve")
    assert r.status_code == 409 and r.get_json()["error"] == "transicion_invalida"          # ya resuelta
    assert staff.post(f"/api/schedule-change-requests/{req['id']}/reject").status_code == 409


def test_rechazar_una_solicitud_deja_el_horario_igual_y_guarda_la_respuesta(login, agenda):
    doc, staff = login("doctor"), login("staff")
    req = doc.post("/api/doctor/schedule-change-requests", {"weeklyHours": {"mon": [{"start": "10:00", "end": "14:00"}]},
                   "effectiveFrom": agenda.now().date().isoformat(), "note": "mis motivos"}).get_json()
    r = staff.post(f"/api/schedule-change-requests/{req['id']}/reject", {"note": "no por ahora"})
    j = r.get_json()
    assert r.status_code == 200 and j["status"] == "rejected" and "Respuesta: no por ahora" in j["note"] and "mis motivos" in j["note"]
    assert_schema("ScheduleChangeRequest", j)
    assert staff.get("/api/doctors").get_json()["items"][0]["usesClinicHours"] is True       # nada cambio
    assert staff.post("/api/schedule-change-requests/999999/reject").status_code == 404
    assert staff.post("/api/schedule-change-requests/abc/approve").status_code == 404


def test_si_el_horario_ya_no_cabe_al_aprobar_la_solicitud_sigue_pendiente(login, agenda):
    doc, staff, admin = login("doctor"), login("staff"), login("admin")
    req = doc.post("/api/doctor/schedule-change-requests", {"weeklyHours": {"sat": [{"start": "09:00", "end": "13:00"}]},
                   "effectiveFrom": agenda.now().date().isoformat()}).get_json()
    assert admin.put("/api/clinic-hours", {"mon": [{"start": "09:00", "end": "18:00"}]}).status_code == 200   # la clinica ya no abre los sabados
    r = staff.post(f"/api/schedule-change-requests/{req['id']}/approve")
    assert r.status_code == 422 and r.get_json()["error"] == "fuera_de_horario"
    j = staff.get("/api/schedule-change-requests", query_string={"status": "pending"}).get_json()["items"]
    assert [x["id"] for x in j] == [req["id"]]                                            # atomico: no quedo a medias
    assert staff.get("/api/doctors").get_json()["items"][0]["usesClinicHours"] is True
    assert staff.get("/api/schedule-change-requests", query_string={"status": "otro"}).status_code == 422
