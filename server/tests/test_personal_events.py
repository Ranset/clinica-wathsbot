"""Eventos personales del doctor (PWA): bloquean SU agenda (no el consultorio), son PRIVADOS y no caen sobre citas.

Tres cosas se vigilan aqui:
1. Motor: mientras dura un evento el doctor no se ofrece ni se le agenda (bot, personal, reprogramar), pero los DOS
   consultorios siguen libres para los demas doctores.
2. Choque: un evento no puede caer sobre una cita agendada del doctor (hay que mover la cita primero).
3. Privacidad: el titulo y las notas NUNCA salen por una ruta que no sea la del propio doctor (ni en la bitacora).
"""
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.agenda import AgendaError, parse_dt
from app.db import iso_utc, to_db
from app.models import AuditLog, PersonalEvent
from helpers import BOT_HEADERS, assert_schema, check_integrity, next_weekday

#: texto que NO debe aparecer jamas fuera de la API del propio doctor
TITULO = "Cirugia de la Sra. Margarita Quintana"
NOTAS = "hipertension, llevar estudios; tel 9981234567"
FRAGMENTOS = ("Margarita", "Quintana", "Cirugia", "hipertension", "9981234567")


def utc(dt):
    return iso_utc(to_db(dt))


def err(fn, *a, **kw):
    try:
        fn(*a, **kw)
    except AgendaError as e:
        return e.code
    return None


def reuma(agenda):
    return agenda.find_doctor("reumatologia")


def no_aparece(texto: str):
    for f in FRAGMENTOS:
        assert f not in texto, f"{f!r} se filtro: {texto[:300]}"


# ------------------------------------------------------------------ motor
def test_un_evento_personal_bloquea_solo_al_doctor_y_deja_libres_los_consultorios(agenda, avail):
    d = reuma(agenda)
    t = next_weekday(agenda, 2, 10)
    ev = avail.add_personal_event(d.id, "Dentista", None, t, t + timedelta(hours=1, minutes=30))
    assert ev.title == "Dentista" and ev.notes is None
    for h, m in ((10, 0), (10, 30), (11, 0)):
        assert agenda.book("5211", "Ana Lopez", "reumatologia", t.replace(hour=h, minute=m))["error"] == "doctor_no_disponible", (h, m)
    assert agenda.book("5211", "Ana Lopez", "reumatologia", t.replace(hour=11, minute=30))["ok"]   # al terminar el evento, si
    # el evento NO ocupa consultorio: otros dos doctores usan los DOS consultorios a esa misma hora
    assert agenda.book("5212", "Beto Ruiz", "proctologia", t)["ok"]
    assert agenda.book("5213", "Carla Diaz", "ginecologia", t)["ok"]
    check_integrity(agenda._sf)


def test_el_evento_quita_las_ofertas_de_horarios_solo_de_ese_doctor(agenda, avail):
    d = reuma(agenda)
    t = next_weekday(agenda, 3, 9)
    fin = t + timedelta(hours=3)                                    # 9:00 a 12:00
    avail.add_personal_event(d.id, "Congreso", None, t, fin)
    ofrecidos = [parse_dt(h) for h in agenda.free_slots("reumatologia", from_day=t.date(), days=1, limit=80)["horarios"]]
    assert ofrecidos and not any(t <= s < fin for s in ofrecidos), ofrecidos           # ese dia SI hay horarios, pero no en el evento
    cercanos = [parse_dt(h) for h in agenda.nearest("reumatologia", t + timedelta(hours=1))["horarios"]]
    assert cercanos and not any(t <= s < fin for s in cercanos), cercanos
    # otro doctor, a la misma hora: sin efecto
    otros = [parse_dt(h) for h in agenda.free_slots("proctologia", from_day=t.date(), days=1, limit=80)["horarios"]]
    assert any(t <= s < fin for s in otros), otros
    assert agenda.book("5212", "Beto Ruiz", "proctologia", t)["ok"]


def test_reprogramar_a_una_franja_con_evento_falla_y_la_cita_original_se_conserva(agenda, avail):
    d = reuma(agenda)
    t = next_weekday(agenda, 2, 10)
    cita = agenda.book("5211", "Ana Lopez", "reumatologia", t)
    assert cita["ok"], cita
    avail.add_personal_event(d.id, "Junta", None, t + timedelta(hours=2), t + timedelta(hours=3))
    r = agenda.reschedule("5211", cita["cita_id"], t + timedelta(hours=2))
    assert r["error"] == "doctor_no_disponible"
    (mia,) = agenda.mine("5211")
    assert parse_dt(mia["inicio"]) == t and mia["cita_id"] == cita["cita_id"]
    check_integrity(agenda._sf)


def test_el_evento_no_se_acepta_sobre_una_cita_agendada(agenda, avail):
    d = reuma(agenda)
    t = next_weekday(agenda, 2, 10)
    cita = agenda.book("5211", "Ana Lopez", "reumatologia", t)                      # 10:00 a 10:30
    h = timedelta(hours=1)
    assert err(avail.add_personal_event, d.id, "Junta", None, t - h, t + timedelta(minutes=30)) == "evento_con_cita"
    assert err(avail.add_personal_event, d.id, "Junta", None, t + timedelta(minutes=15), t + h) == "evento_con_cita"
    assert err(avail.add_personal_event, d.id, "Junta", None, t - h, t + h) == "evento_con_cita"        # la envuelve
    avail.add_personal_event(d.id, "Antes", None, t - h, t)                          # pegado antes: cabe
    avail.add_personal_event(d.id, "Despues", None, t + timedelta(minutes=30), t + h)    # pegado despues: cabe
    # la cita de OTRO doctor a esa hora no estorba, y una cancelada tampoco
    otro = agenda.book("5212", "Beto Ruiz", "proctologia", t + timedelta(days=1))
    avail.add_personal_event(d.id, "Mismo dia y hora que otro doctor", None, t + timedelta(days=1), t + timedelta(days=1, hours=1))
    assert otro["ok"]
    agenda.cancel("5211", cita["cita_id"])
    avail.add_personal_event(d.id, "Ahora si", None, t, t + timedelta(minutes=30))


def test_mover_un_evento_sobre_una_cita_tambien_se_rechaza_y_no_cambia_nada(agenda, avail):
    d = reuma(agenda)
    t = next_weekday(agenda, 2, 10)
    agenda.book("5211", "Ana Lopez", "reumatologia", t + timedelta(hours=3))
    ev = avail.add_personal_event(d.id, "Junta", "sala 2", t, t + timedelta(hours=1))
    assert err(avail.update_personal_event, d.id, ev.id, start=t + timedelta(hours=3), end=t + timedelta(hours=4)) == "evento_con_cita"
    (otra,) = avail.list_personal_events(d.id, t - timedelta(days=1), t + timedelta(days=1))
    assert (otra.start_utc, otra.end_utc) == (to_db(t), to_db(t + timedelta(hours=1))) and otra.notes == "sala 2"
    # solo cambiar el texto no se vuelve a comparar con las citas
    assert avail.update_personal_event(d.id, ev.id, title="Junta cambiada").title == "Junta cambiada"


def test_validaciones_del_evento(agenda, avail):
    d = reuma(agenda)
    t = next_weekday(agenda, 2, 10)
    ok = lambda **kw: err(avail.add_personal_event, d.id, kw.get("title", "Algo"), kw.get("notes"),
                          kw.get("start", t), kw.get("end", t + timedelta(hours=1)))
    assert ok() is None
    assert ok(title="") == "validacion" and ok(title="   \n ") == "validacion" and ok(title=None) == "validacion"
    assert ok(title="x" * 121) == "validacion" and ok(title="x" * 120) is None
    assert ok(notes="y" * 1001) == "validacion" and ok(notes="y" * 1000) is None and ok(notes=123) == "validacion"
    assert ok(end=t) == "validacion" and ok(end=t - timedelta(hours=1)) == "validacion"
    assert ok(end=t + timedelta(hours=24, minutes=1)) == "validacion"            # mas de 24 h: eso es una ausencia
    assert ok(start=t + timedelta(days=500), end=t + timedelta(days=500, hours=1)) == "validacion"
    assert ok(start=t - timedelta(days=500), end=t - timedelta(days=500) + timedelta(hours=1)) == "validacion"
    assert err(avail.add_personal_event, 9999, "Algo", None, t, t + timedelta(hours=1)) == "no_encontrado"
    # el titulo se normaliza (espacios y saltos de linea) y las notas vacias quedan en None
    ev = avail.add_personal_event(d.id, "  Cita   con\nel dentista ", "   ", t + timedelta(days=1), t + timedelta(days=1, hours=1))
    assert ev.title == "Cita con el dentista" and ev.notes is None
    # dura 24 h justas: cabe (un dia completo es de 00:00 a 00:00)
    dia = (t + timedelta(days=2)).replace(hour=0, minute=0)
    assert err(avail.add_personal_event, d.id, "Todo el dia", None, dia, dia + timedelta(days=1)) is None


def test_editar_es_un_parche_y_solo_el_dueno_toca_el_evento(agenda, avail):
    d1, d2 = reuma(agenda), agenda.find_doctor("proctologia")
    t = next_weekday(agenda, 2, 10)
    ev = avail.add_personal_event(d1.id, "Titulo", "notas", t, t + timedelta(hours=1))
    e2 = avail.update_personal_event(d1.id, ev.id, title="Otro titulo")
    assert (e2.title, e2.notes, e2.start_utc) == ("Otro titulo", "notas", to_db(t))        # lo demas no se toco
    assert avail.update_personal_event(d1.id, ev.id, notes=None).notes is None            # null borra las notas
    e4 = avail.update_personal_event(d1.id, ev.id, start=t + timedelta(hours=2), end=t + timedelta(hours=3))
    assert e4.start_utc == to_db(t + timedelta(hours=2)) and e4.title == "Otro titulo"
    assert err(avail.update_personal_event, d1.id, ev.id, title="") == "validacion"
    assert err(avail.update_personal_event, d1.id, ev.id, end=t) == "validacion"          # antes del inicio nuevo
    # el evento de otro doctor es como si no existiera
    assert err(avail.update_personal_event, d2.id, ev.id, title="Hackeado") == "no_encontrado"
    assert err(avail.delete_personal_event, d2.id, ev.id) == "no_encontrado"
    assert err(avail.delete_personal_event, d1.id, 99999) == "no_encontrado"
    assert avail.list_personal_events(d2.id, t - timedelta(days=1), t + timedelta(days=1)) == []
    # borrarlo devuelve al doctor a la oferta
    avail.delete_personal_event(d1.id, ev.id)
    assert agenda.book("5211", "Ana Lopez", "reumatologia", t + timedelta(hours=2))["ok"]


def test_la_bitacora_guarda_ids_y_horas_pero_nunca_el_texto(agenda, avail, db):
    d = reuma(agenda)
    t = next_weekday(agenda, 2, 10)
    ev = avail.add_personal_event(d.id, TITULO, NOTAS, t, t + timedelta(hours=1))
    avail.update_personal_event(d.id, ev.id, title=TITULO + " (cambio)", notes=NOTAS + " 2")
    avail.delete_personal_event(d.id, ev.id)
    with db() as s:
        logs = [a for a in s.scalars(select(AuditLog)) if a.action.startswith("personal_event.")]
    assert [a.action for a in logs] == ["personal_event.create", "personal_event.update", "personal_event.delete"]
    no_aparece(" ".join(str(a.data) + str(a.entity_id) + str(a.action) for a in logs))


def test_busy_between_solo_carga_id_doctor_y_horas(agenda, avail):
    d = reuma(agenda)
    t = next_weekday(agenda, 2, 10)
    ev = avail.add_personal_event(d.id, TITULO, NOTAS, t, t + timedelta(hours=1))
    (fila,) = avail.busy_between(t - timedelta(days=1), t + timedelta(days=1))
    assert fila == (ev.id, d.id, to_db(t), to_db(t + timedelta(hours=1)))
    no_aparece(repr(fila))


# ------------------------------------------------------------------ API del doctor
def window(t, days=1):
    return {"from": utc(t - timedelta(days=days)), "to": utc(t + timedelta(days=days))}


def test_el_doctor_crea_lista_edita_y_borra_sus_eventos(login, agenda):
    d1 = login("doctor")
    t = next_weekday(agenda, 2, 10)
    r = d1.post("/api/doctor/personal-events", {"title": "Dentista", "notes": "llevar radiografia",
                                                "startUtc": utc(t), "endUtc": utc(t + timedelta(hours=1))})
    ev = r.get_json()
    assert r.status_code == 201 and ev["title"] == "Dentista" and ev["notes"] == "llevar radiografia"
    assert_schema("PersonalEvent", ev)
    items = d1.get("/api/doctor/personal-events", query_string=window(t)).get_json()["items"]
    assert [x["id"] for x in items] == [ev["id"]] and items[0] == ev
    # parche: el titulo, luego las notas a null, luego el horario
    r = d1.patch(f"/api/doctor/personal-events/{ev['id']}", {"title": "Dentista (cambio)"})
    assert r.status_code == 200 and r.get_json()["title"] == "Dentista (cambio)" and r.get_json()["notes"] == "llevar radiografia"
    assert d1.patch(f"/api/doctor/personal-events/{ev['id']}", {"notes": None}).get_json()["notes"] is None
    r = d1.patch(f"/api/doctor/personal-events/{ev['id']}", {"startUtc": utc(t + timedelta(hours=2)), "endUtc": utc(t + timedelta(hours=3))})
    assert r.status_code == 200 and r.get_json()["startUtc"] == utc(t + timedelta(hours=2))
    assert d1.patch(f"/api/doctor/personal-events/{ev['id']}", {}).status_code == 422
    # borrar
    assert d1.delete(f"/api/doctor/personal-events/{ev['id']}").status_code == 204
    assert d1.get("/api/doctor/personal-events", query_string=window(t)).get_json()["items"] == []
    assert d1.delete(f"/api/doctor/personal-events/{ev['id']}").status_code == 404             # ya no existe


def test_un_doctor_no_ve_ni_toca_los_eventos_de_otro(login, agenda):
    d1, d2 = login("doctor"), login("doctor2")
    t = next_weekday(agenda, 2, 10)
    ev = d1.post("/api/doctor/personal-events", {"title": TITULO, "notes": NOTAS, "startUtc": utc(t), "endUtc": utc(t + timedelta(hours=1))}).get_json()
    assert d2.get("/api/doctor/personal-events", query_string=window(t)).get_json()["items"] == []
    r = d2.patch(f"/api/doctor/personal-events/{ev['id']}", {"title": "Mio ahora"})
    assert r.status_code == 404 and r.get_json()["error"] == "no_encontrado"                     # 404, no 403
    no_aparece(r.get_data(as_text=True))
    assert d2.delete(f"/api/doctor/personal-events/{ev['id']}").status_code == 404
    assert d2.delete("/api/doctor/personal-events/999999").status_code == 404                    # igual que uno inexistente
    assert d2.delete("/api/doctor/personal-events/abc").status_code == 404
    assert d1.get("/api/doctor/personal-events", query_string=window(t)).get_json()["items"][0]["title"] == TITULO   # intacto


def test_el_personal_y_el_bot_solo_ven_ocupado_nunca_el_texto(login, agenda, client):
    admin, staff, d1 = login("admin"), login("staff"), login("doctor")
    t = next_weekday(agenda, 2, 10)
    d1.post("/api/doctor/personal-events", {"title": TITULO, "notes": NOTAS, "startUtc": utc(t), "endUtc": utc(t + timedelta(hours=1))})
    for quien in (staff, admin):
        r = quien.get("/api/busy-times", query_string=window(t))
        j = r.get_json()
        assert r.status_code == 200 and len(j["items"]) == 1
        assert set(j["items"][0]) == {"id", "doctorId", "startUtc", "endUtc"} and j["items"][0]["doctorId"] == "1"
        assert j["items"][0]["startUtc"] == utc(t) and j["items"][0]["endUtc"] == utc(t + timedelta(hours=1))
        assert_schema("BusyTime", j["items"][0])
        no_aparece(r.get_data(as_text=True))
    # ninguna otra ruta de lectura del personal lo trae
    w = window(t)
    for ruta, qs in (("/api/appointments", w), ("/api/absences", w), ("/api/doctors", None), ("/api/doctors/1/absences", w),
                     ("/api/attention", None), ("/api/schedule-change-requests", None), ("/api/rooms", None)):
        r = staff.get(ruta, query_string=qs)
        assert r.status_code == 200, ruta
        no_aparece(r.get_data(as_text=True))
    # y al intentar agendarle en esa franja el error no revela por que
    r = staff.post("/api/appointments", {"patientName": "Ana Lopez", "phone": "5219981110001", "doctorId": "1", "scheduledAtUtc": utc(t + timedelta(minutes=30))})
    assert r.status_code == 422 and r.get_json()["error"] == "doctor_no_disponible"
    no_aparece(r.get_data(as_text=True))
    assert "evento" not in r.get_data(as_text=True).lower() and "personal" not in r.get_data(as_text=True).lower()
    # el bot tampoco lo ofrece ni lo reserva
    h = client.get("/api/bot/availability", headers=BOT_HEADERS, query_string={
        "especialidad": "proctologia", "desde": t.date().isoformat(), "dias": 1, "hora_min": 9, "hora_max": 12})    # el doctor 1
    assert h.status_code == 200, h.get_json()
    ofrecidos = [parse_dt(s) for s in h.get_json()["horarios"]]
    assert ofrecidos and not any(t <= s < t + timedelta(hours=1) for s in ofrecidos), ofrecidos     # 9:00 si; 10:00 y 10:30 no
    no_aparece(h.get_data(as_text=True))
    b = client.post("/api/bot/appointments", headers=BOT_HEADERS, json={
        "telefono": "5219981112222", "nombre": "Beto Ruiz", "especialidad": "proctologia", "inicio": t.isoformat()})
    assert b.status_code in (409, 422) and b.get_json()["error"] == "doctor_no_disponible", b.get_json()
    no_aparece(b.get_data(as_text=True))


def test_staff_y_administrador_no_usan_la_api_del_doctor_y_el_doctor_no_usa_la_del_personal(login, agenda):
    t = next_weekday(agenda, 2, 10)
    for quien in ("staff", "admin"):
        s = login(quien)
        assert s.get("/api/doctor/personal-events", query_string=window(t)).status_code == 403
        assert s.post("/api/doctor/personal-events", {"title": "x", "startUtc": utc(t), "endUtc": utc(t + timedelta(hours=1))}).status_code == 403
    assert login("doctor").get("/api/busy-times", query_string=window(t)).status_code == 403


def test_un_evento_sobre_una_cita_es_409_con_codigo_propio_y_sin_datos_del_paciente(login, agenda):
    staff, d1 = login("staff"), login("doctor")
    t = next_weekday(agenda, 2, 10)
    cita = staff.post("/api/appointments", {"patientName": "Ana Lopez", "phone": "5219981110001", "doctorId": "1", "scheduledAtUtc": utc(t)}).get_json()
    body = {"title": "Junta", "startUtc": utc(t - timedelta(minutes=30)), "endUtc": utc(t + timedelta(minutes=30))}
    r = d1.post("/api/doctor/personal-events", body)
    assert r.status_code == 409 and r.get_json()["error"] == "evento_con_cita"
    assert "Ana" not in r.get_data(as_text=True) and "5219981110001" not in r.get_data(as_text=True)
    assert d1.get("/api/doctor/personal-events", query_string=window(t)).get_json()["items"] == []     # no se creo nada
    staff.patch(f"/api/appointments/{cita['id']}", {"status": "cancelada"})
    assert d1.post("/api/doctor/personal-events", body).status_code == 201                             # sin la cita, ya cabe


@pytest.mark.parametrize("cuerpo", [
    {}, {"title": "x"}, {"startUtc": "2030-01-02T10:00Z", "endUtc": "2030-01-02T11:00Z"},
    {"title": "", "startUtc": "2030-01-02T10:00Z", "endUtc": "2030-01-02T11:00Z"},
    {"title": 123, "startUtc": "2030-01-02T10:00Z", "endUtc": "2030-01-02T11:00Z"},
    {"title": "x" * 121, "startUtc": "2030-01-02T10:00Z", "endUtc": "2030-01-02T11:00Z"},
    {"title": "x", "startUtc": "no-es-fecha", "endUtc": "y"},
    {"title": "x", "startUtc": "2030-01-02T11:00Z", "endUtc": "2030-01-02T10:00Z"},
    {"title": "x", "notes": "y" * 1001, "startUtc": "2030-01-02T10:00Z", "endUtc": "2030-01-02T11:00Z"},
    {"title": "x", "notes": 5, "startUtc": "2030-01-02T10:00Z", "endUtc": "2030-01-02T11:00Z"},
])
def test_evento_invalido_es_422(login, cuerpo):
    assert login("doctor").post("/api/doctor/personal-events", cuerpo).status_code == 422, cuerpo


def test_evento_de_mas_de_24_horas_o_en_fecha_absurda_es_422(login, agenda):
    d1 = login("doctor")
    t = next_weekday(agenda, 2, 10)
    r = d1.post("/api/doctor/personal-events", {"title": "Viaje", "startUtc": utc(t), "endUtc": utc(t + timedelta(hours=25))})
    assert r.status_code == 422 and "ausencia" in r.get_json()["detail"]
    far = t + timedelta(days=900)
    assert d1.post("/api/doctor/personal-events", {"title": "Lejos", "startUtc": utc(far), "endUtc": utc(far + timedelta(hours=1))}).status_code == 422


def test_rangos_de_las_listas(login, agenda):
    d1, staff = login("doctor"), login("staff")
    t = next_weekday(agenda, 2, 10)
    d1.post("/api/doctor/personal-events", {"title": "A", "startUtc": utc(t), "endUtc": utc(t + timedelta(hours=1))})
    d1.post("/api/doctor/personal-events", {"title": "B", "startUtc": utc(t + timedelta(days=10)), "endUtc": utc(t + timedelta(days=10, hours=1))})
    for ruta, quien in (("/api/doctor/personal-events", d1), ("/api/busy-times", staff)):
        assert quien.get(ruta).status_code == 422                                                      # el rango es obligatorio
        r = quien.get(ruta, query_string={"from": utc(t), "to": utc(t + timedelta(days=93))})
        assert r.status_code == 422 and r.get_json()["error"] == "rango_invalido"
        assert len(quien.get(ruta, query_string={"from": utc(t), "to": utc(t + timedelta(days=92))}).get_json()["items"]) == 2
        # [from, to): un evento que termina justo en `from` o empieza justo en `to` no cuenta
        assert quien.get(ruta, query_string={"from": utc(t + timedelta(hours=1)), "to": utc(t + timedelta(days=1))}).get_json()["items"] == []
        assert len(quien.get(ruta, query_string={"from": utc(t + timedelta(minutes=59)), "to": utc(t + timedelta(days=1))}).get_json()["items"]) == 1
        assert len(quien.get(ruta, query_string={"from": utc(t - timedelta(days=1)), "to": utc(t + timedelta(days=1))}).get_json()["items"]) == 1


def test_busy_times_trae_los_de_todos_los_doctores(login, agenda):
    d1, d2, staff = login("doctor"), login("doctor2"), login("staff")
    t = next_weekday(agenda, 2, 10)
    d1.post("/api/doctor/personal-events", {"title": "Uno", "startUtc": utc(t), "endUtc": utc(t + timedelta(hours=1))})
    d2.post("/api/doctor/personal-events", {"title": "Dos", "startUtc": utc(t + timedelta(hours=1)), "endUtc": utc(t + timedelta(hours=2))})
    items = staff.get("/api/busy-times", query_string=window(t)).get_json()["items"]
    assert [(i["doctorId"], i["startUtc"]) for i in items] == [("1", utc(t)), ("2", utc(t + timedelta(hours=1)))]


def test_al_eliminar_un_doctor_sus_eventos_se_van_con_el(login, agenda, avail, db):
    admin = login("admin")
    did = admin.post("/api/doctors", {"name": "Dr. Por Error", "specialty": "Cardiologia"}).get_json()["id"]
    t = next_weekday(agenda, 2, 10)
    avail.add_personal_event(int(did), "Algo", None, t, t + timedelta(hours=1))
    with db() as s:
        assert len(s.scalars(select(PersonalEvent)).all()) == 1
    assert admin.delete(f"/api/doctors/{did}").status_code == 204
    with db() as s:
        assert s.scalars(select(PersonalEvent)).all() == []
