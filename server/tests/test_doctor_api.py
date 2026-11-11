"""API del doctor (`/api/doctor/*`): SIEMPRE acotada a su propio `doctor_id`, y sin el telefono del paciente."""
from datetime import timedelta

from sqlalchemy import select

from app.db import iso_utc, to_db
from app.models import AttentionCase, PushSubscription
from helpers import assert_schema, next_weekday


def utc(dt):
    return iso_utc(to_db(dt))


def book(staff, t, doctor, name, phone):
    r = staff.post("/api/appointments", {"patientName": name, "phone": phone, "doctorId": str(doctor), "scheduledAtUtc": utc(t)})
    assert r.status_code == 201, r.get_json()
    return r.get_json()


def window(t):
    return {"from": utc(t - timedelta(hours=2)), "to": utc(t + timedelta(hours=6))}


# ------------------------------------------------------------------ citas
def test_el_doctor_solo_ve_sus_citas_y_nunca_el_telefono(login, agenda):
    staff, d1, d2 = login("staff"), login("doctor"), login("doctor2")
    t = next_weekday(agenda, 1, 10)
    a = book(staff, t, 1, "Ana Lopez", "5219981110001")
    b = book(staff, t + timedelta(hours=1), 2, "Beto Ruiz", "5219981110002")
    staff.post("/api/appointments", {"kind": "block", "roomId": "1", "scheduledAtUtc": utc(t + timedelta(hours=2))})   # un bloqueo
    r = d1.get("/api/doctor/appointments", query_string=window(t))
    j = r.get_json()
    assert r.status_code == 200 and [x["id"] for x in j["items"]] == [a["id"]]            # ni la de otro doctor ni el bloqueo
    assert_schema("BookingList", j)
    cita = j["items"][0]
    assert cita["patient"] == {"id": a["id"], "name": "Ana Lopez"}                          # patient.id = id de la cita, sin phone
    assert "5219981110001" not in r.get_data(as_text=True) and "phone" not in cita["patient"]
    assert [x["id"] for x in d2.get("/api/doctor/appointments", query_string=window(t)).get_json()["items"]] == [b["id"]]
    assert "5219981110002" not in d2.get("/api/doctor/appointments", query_string=window(t)).get_data(as_text=True)
    # el personal SI ve el telefono de la misma cita
    assert staff.get(f"/api/appointments/{a['id']}").get_json()["patient"]["phone"] == "5219981110001"


def test_una_cita_de_otro_doctor_no_se_alcanza_por_ninguna_ruta_del_doctor(login, agenda):
    staff, d2 = login("staff"), login("doctor2")
    a = book(staff, next_weekday(agenda, 1, 10), 1, "Ana Lopez", "5219981110001")
    assert d2.get(f"/api/appointments/{a['id']}").status_code == 403                       # la API del personal no es suya
    assert d2.patch(f"/api/appointments/{a['id']}", {"status": "cancelada"}).status_code == 403
    t = next_weekday(agenda, 1, 10)
    assert d2.get("/api/doctor/appointments", query_string=window(t)).get_json()["items"] == []
    assert staff.get(f"/api/appointments/{a['id']}").get_json()["status"] == "agendada"


def test_citas_del_doctor_con_etag_y_rango(login, agenda):
    staff, d1 = login("staff"), login("doctor")
    t = next_weekday(agenda, 1, 10)
    book(staff, t, 1, "Ana Lopez", "5219981110001")
    r = d1.get("/api/doctor/appointments", query_string=window(t))
    etag = r.headers["ETag"]
    assert d1.get("/api/doctor/appointments", query_string=window(t), headers={"If-None-Match": etag}).status_code == 304
    book(staff, t + timedelta(hours=1), 1, "Beto Ruiz", "5219981110002")
    r2 = d1.get("/api/doctor/appointments", query_string=window(t), headers={"If-None-Match": etag})
    assert r2.status_code == 200 and len(r2.get_json()["items"]) == 2 and r2.headers["ETag"] != etag
    t0 = next_weekday(agenda, 0, 0)
    assert d1.get("/api/doctor/appointments", query_string={"from": utc(t0), "to": utc(t0 + timedelta(days=92))}).status_code == 200
    r = d1.get("/api/doctor/appointments", query_string={"from": utc(t0), "to": utc(t0 + timedelta(days=93))})
    assert r.status_code == 422 and r.get_json()["error"] == "rango_invalido"
    assert d1.get("/api/doctor/appointments").status_code == 422


def test_doctores_y_horario_propio(login):
    d1, d2 = login("doctor"), login("doctor2")
    docs = d1.get("/api/doctors").get_json()["items"]
    assert [d["id"] for d in docs] == ["1"]                                                  # un doctor ve solo su registro
    assert [d["id"] for d in d2.get("/api/doctors").get_json()["items"]] == ["2"]
    mine = d1.get("/api/doctor/hours").get_json()
    assert_schema("Doctor", mine)
    assert mine["id"] == "1" and mine["weeklyHours"]["mon"] == [{"start": "09:00", "end": "18:00"}]
    assert d1.get("/api/rooms").status_code == 200 and d1.get("/api/clinic-hours").status_code == 200


# ------------------------------------------------------------------ ausencias
def test_ausencias_propias_y_aviso_al_personal_sin_datos_de_pacientes(login, agenda, db):
    staff, d1, d2 = login("staff"), login("doctor"), login("doctor2")
    t = next_weekday(agenda, 1, 10)
    book(staff, t, 1, "Ana Lopez", "5219981110001")
    r = d1.post("/api/doctor/absences", {"startUtc": utc(t - timedelta(hours=1)), "endUtc": utc(t + timedelta(hours=1)), "reason": "enfermo"})
    j = r.get_json()
    assert r.status_code == 201 and j["affectedCount"] == 1 and j["absence"]["doctorId"] == "1" and j["absence"]["reason"] == "enfermo"
    assert_schema("Absence", j["absence"])
    with db() as s:
        (caso,) = s.scalars(select(AttentionCase)).all()
    assert caso.kind == "absence_affects_appointments" and caso.status == "open" and "1 cita" in caso.detail
    assert "Ana" not in caso.detail and "5219981110001" not in caso.detail and caso.phone is None      # sin datos de pacientes
    assert f" el {t.date().isoformat()}:" in caso.detail and "entre" not in caso.detail               # un solo dia: "el 12", no "entre el 12 y el 13"
    avisos = staff.get("/api/attention").get_json()["items"]
    assert [a["kind"] for a in avisos] == ["absence_affects_appointments"]
    assert [a["id"] for a in d1.get("/api/doctor/absences").get_json()["items"]] == [j["absence"]["id"]]
    assert d2.get("/api/doctor/absences").get_json()["items"] == []                                  # cada uno ve las suyas
    # surte efecto de inmediato: ya no se le puede agendar
    r = staff.post("/api/appointments", {"patientName": "Beto Ruiz", "doctorId": "1", "scheduledAtUtc": utc(t + timedelta(minutes=30))})
    assert r.get_json()["error"] == "doctor_no_disponible"


def test_una_ausencia_sin_citas_no_molesta_al_personal(login, agenda, db):
    d1 = login("doctor")
    t = next_weekday(agenda, 2, 10)
    r = d1.post("/api/doctor/absences", {"startUtc": utc(t), "endUtc": utc(t + timedelta(hours=2))})
    assert r.status_code == 201 and r.get_json()["affectedCount"] == 0
    with db() as s:
        assert s.scalars(select(AttentionCase)).all() == []


def test_un_doctor_no_borra_ni_ve_las_ausencias_de_otro(login, agenda):
    d1, d2 = login("doctor"), login("doctor2")
    t = next_weekday(agenda, 2, 10)
    ab = d1.post("/api/doctor/absences", {"startUtc": utc(t), "endUtc": utc(t + timedelta(hours=2))}).get_json()["absence"]["id"]
    r = d2.delete(f"/api/doctor/absences/{ab}")
    assert r.status_code == 404 and r.get_json()["error"] == "no_encontrado"                          # 404, no 403
    assert d2.delete("/api/doctor/absences/999999").status_code == 404                                # igual que una inexistente
    assert d2.delete("/api/doctor/absences/abc").status_code == 404
    assert [a["id"] for a in d1.get("/api/doctor/absences").get_json()["items"]] == [ab]              # sigue ahi
    assert d1.delete(f"/api/doctor/absences/{ab}").status_code == 204
    assert d1.get("/api/doctor/absences").get_json()["items"] == []


def test_ausencia_invalida_del_doctor(login):
    d1 = login("doctor")
    for body in ({}, {"startUtc": "x", "endUtc": "y"}, {"startUtc": "2030-01-02T10:00Z", "endUtc": "2030-01-02T09:00Z"},
                 {"startUtc": "2030-01-02T10:00Z", "endUtc": "2030-01-02T11:00Z", "reason": "x" * 201}):
        assert d1.post("/api/doctor/absences", body).status_code == 422, body


# ------------------------------------------------------------------ solicitudes de cambio de horario
def test_el_doctor_solo_ve_sus_solicitudes_y_valida_antes_de_enviar(login, agenda):
    d1, d2 = login("doctor"), login("doctor2")
    hoy = agenda.now().date()
    ok = {"weeklyHours": {"mon": [{"start": "10:00", "end": "14:00"}]}, "effectiveFrom": (hoy + timedelta(days=7)).isoformat(), "note": "x"}
    r = d1.post("/api/doctor/schedule-change-requests", ok)
    assert r.status_code == 201 and r.get_json()["status"] == "pending"
    assert_schema("ScheduleChangeRequest", r.get_json())
    assert [x["id"] for x in d1.get("/api/doctor/schedule-change-requests").get_json()["items"]] == [r.get_json()["id"]]
    assert d2.get("/api/doctor/schedule-change-requests").get_json()["items"] == []
    for body, codigo in (({**ok, "weeklyHours": {"sun": [{"start": "10:00", "end": "12:00"}]}}, "fuera_de_horario"),     # la clinica no abre
                         ({**ok, "weeklyHours": {"mon": [{"start": "08:00", "end": "12:00"}]}}, "fuera_de_horario"),
                         ({**ok, "weeklyHours": {"mon": [{"start": "12:00", "end": "10:00"}]}}, "validacion"),
                         ({**ok, "weeklyHours": []}, "validacion"), ({**ok, "weeklyHours": None}, "validacion"),
                         ({**ok, "effectiveFrom": (hoy - timedelta(days=1)).isoformat()}, "validacion"),
                         ({**ok, "effectiveFrom": "manana"}, "validacion"), ({**ok, "effectiveFrom": None}, "validacion"),
                         ({**ok, "note": "x" * 501}, "validacion"), ({**ok, "note": 5}, "validacion")):
        r = d1.post("/api/doctor/schedule-change-requests", body)
        assert r.status_code == 422 and r.get_json()["error"] == codigo, (body, r.get_json())


def test_maximo_tres_solicitudes_pendientes(login, agenda):
    d1 = login("doctor")
    body = {"weeklyHours": {"mon": [{"start": "10:00", "end": "14:00"}]}, "effectiveFrom": (agenda.now().date() + timedelta(days=7)).isoformat()}
    assert [d1.post("/api/doctor/schedule-change-requests", body).status_code for _ in range(3)] == [201, 201, 201]
    r = d1.post("/api/doctor/schedule-change-requests", body)
    assert r.status_code == 422 and "pendientes" in r.get_json()["detail"]


# ------------------------------------------------------------------ notificaciones push
SUB = {"endpoint": "https://push.example.test/abc", "keys": {"p256dh": "clave-publica", "auth": "secreto-auth"}}


def subs(db):
    with db() as s:
        return list(s.scalars(select(PushSubscription)))


def test_suscripcion_push_es_idempotente_y_se_puede_quitar(login, db):
    d1 = login("doctor")
    assert d1.post("/api/doctor/push-subscriptions", SUB).status_code == 204
    assert d1.post("/api/doctor/push-subscriptions", {**SUB, "keys": {"p256dh": "otra", "auth": "otra"}}).status_code == 204
    (row,) = subs(db)
    assert row.endpoint == SUB["endpoint"] and row.p256dh == "otra"                    # misma suscripcion, claves actualizadas
    assert d1.delete("/api/doctor/push-subscriptions", {"endpoint": SUB["endpoint"]}).status_code == 204
    assert d1.delete("/api/doctor/push-subscriptions", {"endpoint": SUB["endpoint"]}).status_code == 204   # idempotente
    assert subs(db) == []


def test_un_doctor_no_quita_la_suscripcion_de_otro(login, db):
    d1, d2 = login("doctor"), login("doctor2")
    d1.post("/api/doctor/push-subscriptions", SUB)
    assert d2.delete("/api/doctor/push-subscriptions", {"endpoint": SUB["endpoint"]}).status_code == 204
    assert len(subs(db)) == 1                                                          # sigue siendo del doctor 1


def test_suscripcion_push_invalida_y_limite(login, db):
    d1 = login("doctor")
    for body in ({}, {"endpoint": "http://inseguro.test/x", "keys": SUB["keys"]}, {"endpoint": 5, "keys": SUB["keys"]},
                 {"endpoint": SUB["endpoint"]}, {"endpoint": SUB["endpoint"], "keys": {"p256dh": "a"}},
                 {"endpoint": SUB["endpoint"], "keys": {"p256dh": "", "auth": "b"}}, {"endpoint": "https://x.test/" + "a" * 600, "keys": SUB["keys"]}):
        assert d1.post("/api/doctor/push-subscriptions", body).status_code == 422, body
    assert d1.delete("/api/doctor/push-subscriptions", {}).status_code == 422
    for i in range(10):
        assert d1.post("/api/doctor/push-subscriptions", {**SUB, "endpoint": f"https://push.example.test/{i}"}).status_code == 204
    assert d1.post("/api/doctor/push-subscriptions", {**SUB, "endpoint": "https://push.example.test/otro"}).status_code == 422
    assert len(subs(db)) == 10
