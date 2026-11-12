"""Administracion: usuarios, doctores, horario de la clinica, interruptor del bot y casos de atencion."""
import pytest
from sqlalchemy import select

from app.agenda import AgendaError
from app.models import AuditLog
from helpers import BOT_HEADERS, PASSWORD, Session, assert_schema, next_weekday


# ------------------------------------------------------------------ usuarios
def test_listar_usuarios_sin_exponer_contrasenas(login):
    r = login("admin").get("/api/users")
    items = r.get_json()["items"]
    assert r.status_code == 200 and [u["email"] for u in items] == [
        "admin@clinica.test", "recepcion@clinica.test", "dr.cervantes@clinica.test", "dra.perez@clinica.test"]
    for u in items:
        assert_schema("User", u)
        assert set(u) == {"id", "email", "name", "role", "doctorId", "active"}
    assert [u["doctorId"] for u in items] == [None, None, "1", "2"]


def test_crear_usuario_y_que_pueda_entrar(app, login):
    admin = login("admin")
    r = admin.post("/api/users", {"email": "  Nueva@Clinica.Test ", "name": "  Nueva   Persona ", "role": "staff", "password": "clave-larga-123"})
    j = r.get_json()
    assert r.status_code == 201 and j["email"] == "nueva@clinica.test" and j["name"] == "Nueva Persona" and j["active"] is True
    assert_schema("User", j)
    assert Session(app, "nueva@clinica.test", "clave-larga-123").user["role"] == "staff"


@pytest.mark.parametrize("cambio", [
    {"email": "admin@clinica.test"},                            # repetido
    {"email": "Admin@Clinica.Test"},                            # repetido sin distinguir mayusculas
    {"email": "no-es-correo"}, {"email": ""}, {"email": None}, {"name": ""}, {"name": "x" * 121}, {"name": 5},
    {"password": "corta"}, {"password": "x" * 129}, {"password": None},
    {"role": "dios"}, {"role": None},
    {"role": "doctor"},                                         # un doctor sin doctorId
    {"role": "doctor", "doctorId": "999"},                      # doctor inexistente
    {"role": "staff", "doctorId": "1"},                         # solo el doctor lleva doctorId
])
def test_crear_usuario_invalido_es_422(login, cambio):
    body = {"email": "nuevo@clinica.test", "name": "Nuevo Usuario", "role": "staff", "password": "clave-larga-123", **cambio}
    r = login("admin").post("/api/users", body)
    assert r.status_code == 422 and r.get_json()["error"] == "validacion", cambio


def test_un_usuario_doctor_se_liga_a_su_doctor(login, app):
    r = login("admin").post("/api/users", {"email": "dr3@clinica.test", "name": "Dra Tres", "role": "doctor", "doctorId": "3",
                                           "password": "clave-larga-123"})
    assert r.status_code == 201 and r.get_json()["doctorId"] == "3"
    assert Session(app, "dr3@clinica.test", "clave-larga-123").get("/api/doctor/hours").get_json()["id"] == "3"


def test_editar_usuario(login):
    admin = login("admin")
    uid = admin.get("/api/users").get_json()["items"][1]["id"]
    r = admin.patch(f"/api/users/{uid}", {"name": "Recepcion Nueva"})
    assert r.status_code == 200 and r.get_json()["name"] == "Recepcion Nueva" and r.get_json()["role"] == "staff"
    r = admin.patch(f"/api/users/{uid}", {"role": "doctor", "doctorId": "4"})
    assert r.get_json()["role"] == "doctor" and r.get_json()["doctorId"] == "4"
    r = admin.patch(f"/api/users/{uid}", {"role": "staff", "doctorId": None})
    assert r.get_json()["role"] == "staff" and r.get_json()["doctorId"] is None
    for body in ({}, {"role": "doctor"}, {"role": "staff", "doctorId": "1"}, {"active": "si"}, {"name": ""}, {"password": "corta"},
                 {"password": "recepcion@clinica.test"}, {"role": "otro"}):
        assert admin.patch(f"/api/users/{uid}", body).status_code == 422, body
    assert admin.patch("/api/users/999999", {"name": "X Y"}).status_code == 404
    assert admin.patch("/api/users/abc", {"name": "X Y"}).status_code == 404


def test_desactivar_a_alguien_cierra_su_sesion_al_instante(app, login, users):
    admin, staff = login("admin"), login("staff")
    assert staff.get("/api/me").status_code == 200
    assert admin.patch(f"/api/users/{users['staff'][2].id}", {"active": False}).get_json()["active"] is False
    assert staff.get("/api/me").status_code == 401
    assert admin.patch(f"/api/users/{users['staff'][2].id}", {"active": True}).status_code == 200
    assert Session(app, "recepcion@clinica.test").get("/api/me").status_code == 200       # reactivado: vuelve a entrar


def test_cambiar_el_rol_o_la_contrasena_cierra_las_sesiones_del_usuario(app, login, users):
    admin, staff, doc = login("admin"), login("staff"), login("doctor")
    admin.patch(f"/api/users/{users['staff'][2].id}", {"role": "admin"})
    assert staff.get("/api/me").status_code == 401                                         # un cambio de privilegios obliga a re-entrar
    admin.patch(f"/api/users/{users['doctor'][2].id}", {"password": "otra-clave-larga-9"})
    assert doc.get("/api/me").status_code == 401
    r = app.test_client().post("/api/auth/login", json={"email": "dr.cervantes@clinica.test", "password": PASSWORD})
    assert r.status_code == 401                                                            # la vieja ya no sirve
    assert Session(app, "dr.cervantes@clinica.test", "otra-clave-larga-9").user["role"] == "doctor"


def test_restablecer_la_contrasena_desbloquea_al_usuario(app, login, users):
    c = app.test_client()
    for _ in range(5):
        c.post("/api/auth/login", json={"email": "recepcion@clinica.test", "password": "mala"})
    assert c.post("/api/auth/login", json={"email": "recepcion@clinica.test", "password": PASSWORD}).status_code == 429
    login("admin").patch(f"/api/users/{users['staff'][2].id}", {"password": "clave-restablecida-1"})
    assert Session(app, "recepcion@clinica.test", "clave-restablecida-1").get("/api/me").status_code == 200


def test_un_administrador_no_se_quita_el_acceso_ni_cambia_su_rol(login, users):
    admin = login("admin")
    me = users["admin"][2].id
    for body in ({"active": False}, {"role": "staff"}):
        r = admin.patch(f"/api/users/{me}", body)
        assert r.status_code == 422 and r.get_json()["error"] == "validacion", body
    assert admin.patch(f"/api/users/{me}", {"name": "Admin Renombrado"}).status_code == 200      # lo demas si
    assert admin.get("/api/me").status_code == 200


def test_nunca_queda_el_sistema_sin_administrador_activo(app, users):
    auth = app.extensions["auth"]
    with pytest.raises(AgendaError) as e:
        auth.update_user(users["admin"][2].id, {"active": False})
    assert "administrador" in e.value.detail
    with pytest.raises(AgendaError):
        auth.update_user(users["admin"][2].id, {"role": "staff"})
    otro = auth.create_user(email="otro@clinica.test", name="Otro Admin", role="admin", password="clave-larga-123")
    assert auth.update_user(users["admin"][2].id, {"active": False}).active is False             # ya hay otro
    with pytest.raises(AgendaError):
        auth.update_user(otro.id, {"role": "doctor", "doctor_id": 1})                           # pero ahora el otro es el ultimo


def test_los_cambios_de_usuarios_quedan_en_la_bitacora_sin_secretos(login, users, db):
    admin = login("admin")
    admin.post("/api/users", {"email": "n@clinica.test", "name": "Nueva Persona", "role": "staff", "password": "clave-larga-123"})
    admin.patch(f"/api/users/{users['staff'][2].id}", {"password": "clave-restablecida-1"})
    with db() as s:
        logs = [a for a in s.scalars(select(AuditLog)) if a.action.startswith("user.")]
    assert {a.action for a in logs} >= {"user.create", "user.update"}
    texto = str([(a.data, a.entity_id) for a in logs])
    assert "clave-" not in texto and "n@clinica.test" not in texto and "Nueva" not in texto


# ------------------------------------------------------------------ horario de la clinica y doctores
def test_el_administrador_y_el_personal_cambian_el_horario_de_la_clinica_pero_un_doctor_no(login, users, client, db):
    nuevo = {"mon": [{"start": "09:00", "end": "14:00"}, {"start": "16:00", "end": "19:00"}], "sat": [{"start": "09:00", "end": "13:00"}]}
    otro = {"mon": [{"start": "10:00", "end": "15:00"}], "sat": [{"start": "09:00", "end": "12:00"}]}
    # un doctor, o quien no inicio sesion, no puede (y el horario no cambia)
    antes = login("admin").get("/api/clinic-hours").get_json()
    assert login("doctor").put("/api/clinic-hours", nuevo).status_code == 403
    assert login("doctor2").put("/api/clinic-hours", nuevo).status_code == 403
    assert client.put("/api/clinic-hours", json=nuevo).status_code == 401
    assert login("admin").get("/api/clinic-hours").get_json() == antes
    # recepcion SI puede, y el cambio llega a todos: web, doctores y bot
    staff = login("staff")
    r = staff.put("/api/clinic-hours", otro)
    assert r.status_code == 200 and r.get_json() == otro and staff.get("/api/clinic-hours").get_json() == otro
    assert login("doctor").get("/api/clinic-hours").get_json() == otro
    assert client.get("/api/bot/config", headers=BOT_HEADERS).get_json()["clinicHours"] == otro
    with db() as s:   # y queda en la bitacora a nombre de quien lo hizo
        log = [x for x in s.scalars(select(AuditLog)) if x.action == "clinic_hours.set"][-1]
        assert log.actor_kind == "user" and log.actor_user_id == users["staff"][2].id
    admin = login("admin")
    r = admin.put("/api/clinic-hours", nuevo)
    assert r.status_code == 200 and r.get_json() == nuevo and admin.get("/api/clinic-hours").get_json() == nuevo
    assert_schema("WeeklyHours", r.get_json())
    for malo in ({"lun": []}, {"mon": [{"start": "10:00", "end": "09:00"}]}, {"mon": [{"start": "09:10", "end": "12:00"}]},
                 {"mon": [{"start": "09:00", "end": "12:00"}, {"start": "11:00", "end": "13:00"}]}, {"mon": "x"}):
        assert admin.put("/api/clinic-hours", malo).status_code == 422, malo
    assert admin.put("/api/clinic-hours", []).status_code == 422
    for vacio in ({}, {"mon": [], "tue": []}):                                  # un horario vacio borraria toda la agenda
        r = admin.put("/api/clinic-hours", vacio)
        assert r.status_code == 422 and "al menos un intervalo" in r.get_json()["detail"], vacio
    assert admin.get("/api/clinic-hours").get_json() == nuevo                    # y el horario sigue intacto


def test_alta_y_edicion_de_doctores_llegan_al_bot(login, client):
    admin = login("admin")
    r = admin.post("/api/doctors", {"name": "Dra. Nueva Persona", "specialty": "Cardiologia", "aliases": ["cardiologa", " corazon ", "Corazon"]})
    j = r.get_json()
    assert r.status_code == 201 and j["aliases"] == ["cardiologa", "corazon"] and j["active"] is True and j["usesClinicHours"] is True
    assert_schema("Doctor", j)
    cfg = client.get("/api/bot/config", headers=BOT_HEADERS).get_json()
    assert "Cardiologia" in [d["specialty"] for d in cfg["doctors"]]
    assert client.get("/api/bot/availability", query_string={"especialidad": "corazon"}, headers=BOT_HEADERS).get_json()["doctor"] == "Dra. Nueva Persona"
    r = admin.patch(f"/api/doctors/{j['id']}", {"active": False})
    assert r.status_code == 200 and r.get_json()["active"] is False and r.get_json()["name"] == "Dra. Nueva Persona"
    cfg = client.get("/api/bot/config", headers=BOT_HEADERS).get_json()
    assert "Cardiologia" not in [d["specialty"] for d in cfg["doctors"]]                       # un doctor inactivo deja de ofrecerse
    assert client.get("/api/bot/availability", query_string={"especialidad": "cardiologia"}, headers=BOT_HEADERS).status_code == 422
    assert len(admin.get("/api/doctors").get_json()["items"]) == 8                              # el personal si lo sigue viendo


def test_el_personal_da_de_alta_edita_y_da_de_baja_doctores_pero_un_doctor_no(login, users, client, db):
    nuevo = {"name": "Dr. Alta Recepcion", "specialty": "Pediatria", "aliases": ["pediatra"]}
    # un doctor, o quien no inicio sesion, no puede (y no se crea nada)
    assert login("doctor").post("/api/doctors", nuevo).status_code == 403
    assert login("doctor2").patch("/api/doctors/1", {"specialty": "Otra"}).status_code == 403
    assert client.post("/api/doctors", json=nuevo).status_code == 401
    assert "Pediatria" not in [d["specialty"] for d in login("admin").get("/api/doctors").get_json()["items"]]
    # recepcion SI: alta, edicion y baja, y el bot lo ve
    staff = login("staff")
    r = staff.post("/api/doctors", nuevo)
    j = r.get_json()
    assert r.status_code == 201 and j["name"] == "Dr. Alta Recepcion" and j["active"] is True
    assert_schema("Doctor", j)
    cfg = lambda: client.get("/api/bot/config", headers=BOT_HEADERS).get_json()["doctors"]
    assert "Pediatria" in [d["specialty"] for d in cfg()]
    r = staff.patch(f"/api/doctors/{j['id']}", {"specialty": "Pediatria general", "aliases": ["pediatra", "ninos"]})
    assert r.status_code == 200 and r.get_json()["specialty"] == "Pediatria general" and r.get_json()["aliases"] == ["pediatra", "ninos"]
    assert "Pediatria general" in [d["specialty"] for d in cfg()]
    assert staff.patch(f"/api/doctors/{j['id']}", {"active": False}).get_json()["active"] is False
    assert "Pediatria general" not in [d["specialty"] for d in cfg()]                          # de baja: el bot ya no lo ofrece
    assert staff.patch("/api/doctors/1", {"name": "Dr. Pérez Lago"}).status_code == 422         # las reglas de validacion son las mismas
    assert staff.post("/api/doctors", {"name": "Dr. Cervantes Peláez", "specialty": "Repetido"}).status_code == 422
    # queda en la bitacora a nombre de recepcion
    with db() as s:
        logs = [a for a in s.scalars(select(AuditLog)) if a.action in ("doctor.create", "doctor.update")]
    assert {a.action for a in logs} == {"doctor.create", "doctor.update"}
    assert all(a.actor_kind == "user" and a.actor_user_id == users["staff"][2].id for a in logs)


# ------------------------------------------------------------------ color del doctor (se elige en la web)
def test_el_color_del_doctor_se_elige_se_quita_y_llega_a_las_citas(login, users, db, agenda):
    from datetime import timedelta
    admin, staff = login("admin"), login("staff")
    # los doctores del seed no traen color elegido: automatico (null)
    assert {d["color"] for d in admin.get("/api/doctors").get_json()["items"]} == {None}

    # alta con color: se guarda en minusculas
    j = admin.post("/api/doctors", {"name": "Dr. Con Color", "specialty": "Urologia", "color": "#1D4ED8"}).get_json()
    assert j["color"] == "#1d4ed8"
    assert_schema("Doctor", j)
    did = j["id"]

    # recepcion tambien lo cambia; lo demas del doctor queda como estaba
    r = staff.patch(f"/api/doctors/{did}", {"color": "#be185d"})
    assert r.status_code == 200 and r.get_json()["color"] == "#be185d" and r.get_json()["name"] == "Dr. Con Color"
    assert staff.patch(f"/api/doctors/{did}", {"specialty": "Urologia general"}).get_json()["color"] == "#be185d"   # no se pierde
    assert [d["color"] for d in admin.get("/api/doctors").get_json()["items"] if d["id"] == did] == ["#be185d"]

    # las citas de ese doctor llevan su color (el calendario lo pinta); las de otro doctor, null
    t = next_weekday(agenda, 2, 10)
    cita = admin.post("/api/appointments", {"patientName": "Ana Lopez", "phone": "5219981110001", "doctorId": did, "scheduledAtUtc": _utc(t)})
    assert cita.status_code == 201 and cita.get_json()["doctor"]["color"] == "#be185d"
    assert_schema("Booking", cita.get_json())
    otra = admin.post("/api/appointments", {"patientName": "Beto Ruiz", "doctorId": "2", "scheduledAtUtc": _utc(t + timedelta(hours=1))}).get_json()
    assert otra["doctor"]["color"] is None
    q = {"from": _utc(t - timedelta(hours=1)), "to": _utc(t + timedelta(hours=4))}
    assert {b["id"]: b["doctor"]["color"] for b in admin.get("/api/appointments", query_string=q).get_json()["items"]} == \
        {cita.get_json()["id"]: "#be185d", otra["id"]: None}
    # cambiar el color cambia el ETag: el calendario que refresca con If-None-Match se entera
    etag = admin.get("/api/appointments", query_string=q).headers["ETag"]
    assert staff.patch(f"/api/doctors/{did}", {"color": "#7e22ce"}).status_code == 200
    r = admin.get("/api/appointments", query_string=q)
    assert r.headers["ETag"] != etag and [b["doctor"]["color"] for b in r.get_json()["items"] if b["id"] == cita.get_json()["id"]] == ["#7e22ce"]

    # quitarlo (null) vuelve al automatico
    assert admin.patch(f"/api/doctors/{did}", {"color": None}).get_json()["color"] is None
    # queda en la bitacora que se toco el color
    with db() as s:
        cambios = [a.data["changed"] for a in s.scalars(select(AuditLog)) if a.action == "doctor.update" and a.entity_id == did]
    assert ["color"] in cambios


def test_el_doctor_ve_el_color_de_sus_propias_citas(login, agenda):
    from datetime import timedelta
    admin = login("admin")
    assert admin.patch("/api/doctors/1", {"color": "#c2410c"}).status_code == 200
    t = next_weekday(agenda, 2, 10)
    admin.post("/api/appointments", {"patientName": "Ana Lopez", "doctorId": "1", "scheduledAtUtc": _utc(t)})
    doctor = login("doctor")                                                  # el usuario ligado al doctor 1
    items = doctor.get("/api/doctor/appointments", query_string={"from": _utc(t - timedelta(hours=1)),
                                                                  "to": _utc(t + timedelta(hours=3))}).get_json()["items"]
    assert [b["doctor"]["color"] for b in items] == ["#c2410c"]
    assert doctor.get("/api/doctors").get_json()["items"][0]["color"] == "#c2410c"


@pytest.mark.parametrize("color", ["azul", "#fff", "1d4ed8", "#12345g", "#1d4ed8ff", 123, True, [], {}, ""])
def test_un_color_con_mal_formato_es_422(login, color):
    admin = login("admin")
    for r in (admin.post("/api/doctors", {"name": "Dr. Mal Color", "specialty": "X", "color": color}),
              admin.patch("/api/doctors/1", {"color": color})):
        assert r.status_code == 422 and r.get_json()["error"] == "validacion" and "color" in r.get_json()["detail"], color
    assert admin.get("/api/doctors").get_json()["items"][0]["color"] is None


@pytest.mark.parametrize("color", ["#ffffff", "#ffff00", "#cccccc", "#a3e635", "#777777"])
def test_un_color_demasiado_claro_para_texto_blanco_es_422_y_no_se_guarda(login, color):
    admin = login("admin")
    r = admin.patch("/api/doctors/1", {"color": color})
    assert r.status_code == 422 and r.get_json()["error"] == "validacion" and "demasiado claro" in r.get_json()["detail"]
    assert admin.post("/api/doctors", {"name": "Dr. Muy Claro", "specialty": "X", "color": color}).status_code == 422
    assert admin.get("/api/doctors").get_json()["items"][0]["color"] is None
    assert "Dr. Muy Claro" not in [d["name"] for d in admin.get("/api/doctors").get_json()["items"]]
    assert admin.patch("/api/doctors/1", {"color": "#767676"}).status_code == 200            # justo el limite AA: pasa


def test_el_color_no_cambia_lo_que_ve_el_bot(login, client):
    admin = login("admin")
    antes = client.get("/api/bot/config", headers=BOT_HEADERS).get_json()
    admin.patch("/api/doctors/1", {"color": "#1d4ed8"})
    assert client.get("/api/bot/config", headers=BOT_HEADERS).get_json() == antes


# ------------------------------------------------------------------ eliminar un doctor (solo el administrador, sin historial)
def _utc(dt):
    from app.db import iso_utc, to_db
    return iso_utc(to_db(dt))


def test_el_administrador_elimina_un_doctor_sin_historial_y_deja_rastro(login, users, client, db, agenda):
    from datetime import timedelta
    from app.models import Doctor, DoctorAbsence, DoctorHours
    admin = login("admin")
    j = admin.post("/api/doctors", {"name": "Dr. Por Error", "specialty": "Cardiologia", "aliases": ["corazon"]}).get_json()
    did = j["id"]
    t = next_weekday(agenda, 2, 10)
    assert admin.put(f"/api/doctors/{did}/weekly-hours", {"weeklyHours": {"tue": [{"start": "10:00", "end": "12:00"}]}}).status_code == 200
    assert admin.post(f"/api/doctors/{did}/absences", {"startUtc": _utc(t), "endUtc": _utc(t + timedelta(hours=2))}).status_code == 201
    antes = len(admin.get("/api/doctors").get_json()["items"])

    r = admin.delete(f"/api/doctors/{did}")
    assert r.status_code == 204 and r.data == b""
    assert len(admin.get("/api/doctors").get_json()["items"]) == antes - 1
    assert did not in [d["id"] for d in admin.get("/api/doctors").get_json()["items"]]
    assert "Cardiologia" not in [d["specialty"] for d in client.get("/api/bot/config", headers=BOT_HEADERS).get_json()["doctors"]]
    assert admin.patch(f"/api/doctors/{did}", {"active": True}).status_code == 404            # ya no existe
    assert admin.delete(f"/api/doctors/{did}").status_code == 404                              # ni se borra dos veces
    with db() as s:    # sus tramos y ausencias se fueron con el, y queda en la bitacora quien y que se elimino
        assert s.get(Doctor, int(did)) is None
        assert s.scalars(select(DoctorHours).where(DoctorHours.doctor_id == int(did))).all() == []
        assert s.scalars(select(DoctorAbsence).where(DoctorAbsence.doctor_id == int(did))).all() == []
        log = [x for x in s.scalars(select(AuditLog)) if x.action == "doctor.delete"][-1]
        assert log.actor_kind == "user" and log.actor_user_id == users["admin"][2].id
        assert log.entity_id == did and log.data == {"name": "Dr. Por Error", "specialty": "Cardiologia"}


def test_no_se_elimina_un_doctor_con_citas_ni_con_cuenta_ligada(login, agenda):
    admin = login("admin")
    # el doctor 1 tiene una cuenta de usuario (dr.cervantes): primero la cuenta
    r = admin.delete("/api/doctors/1")
    assert r.status_code == 409 and r.get_json()["error"] == "doctor_con_usuario" and "Usuarios" in r.get_json()["detail"]
    # un doctor sin cuenta pero con una cita (aunque luego se cancele) tampoco: se conserva el historial
    did = admin.post("/api/doctors", {"name": "Dr. Con Historial", "specialty": "Urologia"}).get_json()["id"]
    t = next_weekday(agenda, 2, 11)
    cita = admin.post("/api/appointments", {"patientName": "Ana Lopez", "phone": "5219981110001", "doctorId": did, "scheduledAtUtc": _utc(t)})
    assert cita.status_code == 201, cita.get_json()
    r = admin.delete(f"/api/doctors/{did}")
    assert r.status_code == 409 and r.get_json()["error"] == "doctor_con_citas"
    assert admin.patch(f"/api/appointments/{cita.get_json()['id']}", {"status": "cancelada"}).status_code == 200
    assert admin.delete(f"/api/doctors/{did}").get_json()["error"] == "doctor_con_citas"       # cancelada sigue siendo historial
    # nada se perdio: el doctor y su cita siguen ahi, y la baja (PATCH) si es posible
    assert did in [d["id"] for d in admin.get("/api/doctors").get_json()["items"]]
    assert admin.patch(f"/api/doctors/{did}", {"active": False}).get_json()["active"] is False


def test_solo_el_administrador_elimina_doctores(login, client):
    did = login("admin").post("/api/doctors", {"name": "Dr. Solo Admin", "specialty": "Oncologia"}).get_json()["id"]
    for who in ("staff", "doctor", "doctor2"):
        assert login(who).delete(f"/api/doctors/{did}").status_code == 403, who
    assert client.delete(f"/api/doctors/{did}").status_code == 401
    assert did in [d["id"] for d in login("admin").get("/api/doctors").get_json()["items"]]    # sigue ahi
    for raro in ("999", "abc", "0", "-1"):
        assert login("admin").delete(f"/api/doctors/{raro}").status_code == 404, raro
    assert login("admin").delete(f"/api/doctors/{did}").status_code == 204


@pytest.mark.parametrize("body", [{}, {"name": "Solo Nombre"}, {"specialty": "Sin nombre"}, {"name": "", "specialty": "x"},
                                  {"name": "Dr. Cervantes Peláez", "specialty": "Repetido"},      # nombre repetido
                                  {"name": "A B", "specialty": "x", "aliases": "no-lista"}, {"name": "A B", "specialty": "x", "aliases": [1]},
                                  {"name": "A B", "specialty": "x", "aliases": [str(i) for i in range(21)]},
                                  {"name": "A B", "specialty": "x", "active": "si"}, {"name": "x" * 121, "specialty": "x"}])
def test_alta_de_doctor_invalida_es_422(login, body):
    r = login("admin").post("/api/doctors", body)
    assert r.status_code == 422 and r.get_json()["error"] == "validacion", body


def test_editar_doctor_inexistente_o_con_datos_malos(login):
    admin = login("admin")
    assert admin.patch("/api/doctors/999", {"active": False}).status_code == 404
    assert admin.patch("/api/doctors/abc", {"active": False}).status_code == 404
    assert admin.patch("/api/doctors/1", {}).status_code == 422
    assert admin.patch("/api/doctors/1", {"name": "Dr. Pérez Lago"}).status_code == 422          # el nombre de otro doctor
    assert admin.patch("/api/doctors/1", {"active": "no"}).status_code == 422


# ------------------------------------------------------------------ interruptor del bot
def test_el_boton_del_bot_lo_ven_y_cambian_admin_y_personal(login, client):
    staff = login("staff")
    j = staff.get("/api/settings/bot").get_json()
    assert j["active"] is False
    assert_schema("BotSettings", j)
    r = staff.put("/api/settings/bot", {"active": True})
    assert r.status_code == 200 and r.get_json()["active"] is True and r.get_json()["updatedBy"] == "Recepcion Prueba"
    assert_schema("BotSettings", r.get_json())
    assert client.get("/api/bot/status", headers=BOT_HEADERS).get_json()["active"] is True        # lo que lee el bot
    assert login("admin").put("/api/settings/bot", {"active": False}).get_json()["updatedBy"] == "Admin Prueba"
    assert client.get("/api/bot/status", headers=BOT_HEADERS).get_json()["active"] is False
    for body in ({}, {"active": "si"}, {"active": 1}, {"active": None}):
        assert staff.put("/api/settings/bot", body).status_code == 422, body


def test_el_interruptor_queda_en_la_bitacora(login, db):
    login("staff").put("/api/settings/bot", {"active": True})
    with db() as s:
        a = [x for x in s.scalars(select(AuditLog)) if x.action == "bot.set_active"][-1]
    assert a.actor_kind == "user" and a.data == {"active": True}


# ------------------------------------------------------------------ casos de atencion
def test_casos_de_atencion_se_listan_y_se_resuelven(app, login):
    ev = app.extensions["events"]
    ev.handoff("conv-1", "pidio_persona", "5219981112222", "pidio hablar con alguien")
    ev.handoff("conv-2", "modelo_fallo")
    staff = login("staff")
    r = staff.get("/api/attention")
    items = r.get_json()["items"]
    assert r.status_code == 200 and [i["conversationId"] for i in items] == ["conv-2", "conv-1"]            # el mas reciente primero
    assert items[1] == {**items[1], "kind": "handoff", "status": "open", "phone": "5219981112222", "reason": "pidio_persona"}
    for i in items:
        assert_schema("AttentionItem", i)
    r = staff.post(f"/api/attention/{items[0]['id']}/resolve")
    assert r.status_code == 200 and r.get_json()["status"] == "resolved"
    assert_schema("AttentionItem", r.get_json())
    assert staff.post(f"/api/attention/{items[0]['id']}/resolve").status_code == 200                       # idempotente
    assert [i["conversationId"] for i in staff.get("/api/attention").get_json()["items"]] == ["conv-1"]
    assert [i["conversationId"] for i in staff.get("/api/attention", query_string={"status": "resolved"}).get_json()["items"]] == ["conv-2"]
    assert staff.get("/api/attention", query_string={"status": "otro"}).status_code == 422
    assert staff.post("/api/attention/999999/resolve").status_code == 404
    assert staff.post("/api/attention/abc/resolve").status_code == 404


def test_casos_atendidos_se_piden_por_paginas_con_su_total(app, login):
    """Los atendidos se acumulan sin fin: la web pide `limit`/`offset` y el servidor solo trae esa pagina (+ el total)."""
    ev = app.extensions["events"]
    for i in range(1, 26):
        ev.handoff(f"conv-{i}", "pidio_persona", None, f"caso {i}")
    staff = login("staff")
    sin_limite = staff.get("/api/attention").get_json()
    assert sin_limite["total"] == 25 and len(sin_limite["items"]) == 25                 # sin `limit`: todos, como antes, mas el total
    assert_schema("AttentionList", sin_limite)
    por_id = {i["conversationId"]: i["id"] for i in sin_limite["items"]}
    for n in range(1, 24):                                                                # se atienden 23 (quedan abiertos el 24 y el 25)
        assert staff.post(f"/api/attention/{por_id[f'conv-{n}']}/resolve").status_code == 200

    def page(**qs):
        r = staff.get("/api/attention", query_string={"status": "resolved", **qs})
        assert r.status_code == 200, r.get_json()
        j = r.get_json()
        assert_schema("AttentionList", j)
        return [i["conversationId"] for i in j["items"]], j["total"]

    p1, total = page(limit=10)
    assert total == 23 and p1 == [f"conv-{n}" for n in range(23, 13, -1)]                # el mas reciente primero
    p2, total2 = page(limit=10, offset=10)
    assert total2 == 23 and p2 == [f"conv-{n}" for n in range(13, 3, -1)]
    p3, _ = page(limit=10, offset=20)
    assert p3 == ["conv-3", "conv-2", "conv-1"]                                           # la ultima, con lo que sobra
    assert page(limit=10, offset=30) == ([], 23)                                          # mas alla del final: vacia, pero el total sigue
    assert p1 + p2 + p3 == [f"conv-{n}" for n in range(23, 0, -1)]                        # sin huecos ni repetidos
    assert page(limit=100)[0] == p1 + p2 + p3 and page()[1] == 23                         # el tope y «sin limit»

    # los pendientes tambien aceptan paginar, y cada estado cuenta lo suyo
    r = staff.get("/api/attention", query_string={"limit": 1}).get_json()
    assert [i["conversationId"] for i in r["items"]] == ["conv-25"] and r["total"] == 2

    for qs in ({"limit": 0}, {"limit": 101}, {"limit": "abc"}, {"limit": 1.5}, {"limit": 10, "offset": -1}, {"limit": 10, "offset": "x"},
               {"offset": 5}):                                                            # `offset` solo con `limit`
        r = staff.get("/api/attention", query_string={"status": "resolved", **qs})
        assert r.status_code == 422 and r.get_json()["error"] == "validacion", qs


def test_la_pagina_de_atendidos_solo_trae_esas_filas_de_la_bd(app):
    """El `LIMIT` va en la consulta (no se trae todo para recortar despues)."""
    from sqlalchemy import event
    ev, directory = app.extensions["events"], app.extensions["directory"]
    for i in range(1, 31):
        ev.handoff(f"c-{i}", "otro", None, None)
    for c in directory.attention("open")[0]:
        directory.resolve_attention(c.id)
    consultas: list[str] = []
    engine = app.extensions["db"].engine
    listener = lambda conn, cur, statement, *a: consultas.append(statement)
    event.listen(engine, "before_cursor_execute", listener)
    try:
        rows, total = directory.attention("resolved", limit=10, offset=10)
    finally:
        event.remove(engine, "before_cursor_execute", listener)
    assert len(rows) == 10 and total == 30
    listado = [q for q in consultas if "FROM attention_cases" in q and "count(" not in q.lower()]
    assert len(listado) == 1 and "LIMIT" in listado[0].upper(), consultas
