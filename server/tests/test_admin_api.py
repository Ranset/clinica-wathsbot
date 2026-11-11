"""Administracion: usuarios, doctores, horario de la clinica, interruptor del bot y casos de atencion."""
import pytest
from sqlalchemy import select

from app.agenda import AgendaError
from app.models import AuditLog
from helpers import BOT_HEADERS, PASSWORD, Session, assert_schema


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
def test_solo_el_administrador_cambia_el_horario_de_la_clinica(login):
    nuevo = {"mon": [{"start": "09:00", "end": "14:00"}, {"start": "16:00", "end": "19:00"}], "sat": [{"start": "09:00", "end": "13:00"}]}
    assert login("staff").put("/api/clinic-hours", nuevo).status_code == 403
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
