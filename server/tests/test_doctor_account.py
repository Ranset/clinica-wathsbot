"""La cuenta del doctor nace con el doctor (sin correo ni contrasena) y su contrasena se establece con un enlace que genera el personal."""
import hashlib

import pytest
from sqlalchemy import func, select

from app.models import AuditLog, Doctor, User, UserSession
from helpers import PASSWORD, Clock, Session, assert_schema, check_contract, make_users, next_weekday

NUEVA = "mi-contrasena-nueva-1"


def alta(sess, name="Dr. Nuevo", specialty="Cardiologia"):
    r = sess.post("/api/doctors", {"name": name, "specialty": specialty})
    assert r.status_code == 201, r.get_json()
    return r.get_json()


def generar(sess, doctor_id):
    r = sess.post(f"/api/doctors/{doctor_id}/password-link")
    assert r.status_code == 200, r.get_json()
    return r.get_json()


def token_de(url: str) -> str:
    assert "#/contrasena?t=" in url
    return url.split("?t=", 1)[1]


def revisar(client, token, **kw):
    r = client.post("/api/auth/password-link/check", json={"token": token}, **kw)
    check_contract("POST", "/api/auth/password-link/check", r)
    return r


def usar(client, token, password=NUEVA, **kw):
    r = client.post("/api/auth/password-link/use", json={"token": token, "password": password}, **kw)
    check_contract("POST", "/api/auth/password-link/use", r)
    return r


def doctor_login(client, code, password):
    return client.post("/api/auth/doctor-login", json={"doctorCode": code, "password": password})


def cuentas(db, doctor_id):
    with db() as s:
        return list(s.scalars(select(User).where(User.doctor_id == int(doctor_id)).order_by(User.id)))


# ------------------------------------------------------------------ el alta crea la cuenta
def test_dar_de_alta_un_doctor_crea_su_cuenta_sin_correo_ni_contrasena(login, db):
    admin = login("admin")
    d = alta(admin)
    (u,) = cuentas(db, d["id"])
    assert (u.role, u.email, u.password_hash, u.active, u.name) == ("doctor", None, None, True, "Dr. Nuevo")
    with db() as s:
        logs = [a for a in s.scalars(select(AuditLog)) if a.action == "user.create" and a.entity_id == str(u.id)]
    assert len(logs) == 1 and logs[0].data == {"role": "doctor", "doctorId": int(d["id"])}
    listed = [x for x in admin.get("/api/users").get_json()["items"] if x["doctorId"] == d["id"]]
    assert listed == [{"id": str(u.id), "email": None, "name": "Dr. Nuevo", "role": "doctor", "doctorId": d["id"], "active": True,
                       "passwordSet": False}]
    assert_schema("User", listed[0])


def test_recepcion_tambien_da_de_alta_y_la_cuenta_se_crea(login, db):
    d = alta(login("staff"), "Dra. Recepcion")
    assert [(u.role, u.password_hash) for u in cuentas(db, d["id"])] == [("doctor", None)]


def test_el_alta_es_atomica_si_falla_la_cuenta_no_queda_el_doctor(app, db, monkeypatch):
    import app.directory as directory

    def falla(*a, **k):
        raise RuntimeError("falla la cuenta")

    monkeypatch.setattr(directory, "create_doctor_account", falla)
    with pytest.raises(RuntimeError):
        app.extensions["directory"].create_doctor({"name": "Dr. Atomico", "specialty": "X"})
    with db() as s:
        assert s.scalar(select(func.count()).select_from(Doctor).where(Doctor.name == "Dr. Atomico")) == 0


def test_la_cuenta_sin_contrasena_no_entra_no_sale_en_la_lista_y_no_cuenta_intentos(client, login):
    d = alta(login("staff"))
    for pw in ("x", PASSWORD, "otra-clave-larga-1", "y" * 12, "z" * 12, "w" * 12, "v" * 12):
        assert doctor_login(client, d["code"], pw).status_code == 401, pw   # nunca 429: una cuenta sin contrasena no se bloquea
    items = client.get("/api/auth/doctors").get_json()["items"]
    assert d["code"] not in [i["code"] for i in items]


def test_renombrar_al_doctor_renombra_su_cuenta(login, db):
    admin = login("admin")
    d = alta(admin)
    assert admin.patch(f"/api/doctors/{d['id']}", {"name": "Dr. Renombrado"}).status_code == 200
    assert [u.name for u in cuentas(db, d["id"])] == ["Dr. Renombrado"]


def test_desde_usuarios_no_se_crea_un_doctor_y_el_mensaje_dice_que_hacer(login):
    r = login("admin").post("/api/users", {"email": "x@clinica.test", "name": "Un Doctor", "role": "doctor", "doctorId": "3",
                                           "password": "clave-larga-123"})
    assert r.status_code == 422 and "Datos" in r.get_json()["detail"]


# ------------------------------------------------------------------ generar el enlace
def test_el_personal_genera_el_enlace_corto_con_su_vencimiento_y_sin_guardarlo_en_claro(make_app):
    clock = Clock()
    app = make_app(clock=clock)
    make_users(app)
    db = app.extensions["db"].session_factory
    staff = Session(app, "recepcion@clinica.test")
    d = alta(staff)
    j = generar(staff, d["id"])
    assert_schema("PasswordLink", j)
    assert j["url"].startswith("https://clinica.test/doctor/#/contrasena?t=") and len(j["url"]) < 90   # cabe en un mensaje de WhatsApp
    assert j["expiresAtUtc"].startswith("2026-11-12T15:00:00")                                         # 72 h despues de "ahora"
    token = token_de(j["url"])
    with db() as s:
        u = s.scalars(select(User).where(User.doctor_id == int(d["id"]))).one()
        logs = [a for a in s.scalars(select(AuditLog)) if a.action == "user.password_link"]
        todo = str([(a.data, a.entity_id, a.action) for a in s.scalars(select(AuditLog))])
    assert u.setup_token_hash == hashlib.sha256(token.encode()).hexdigest() and token not in (u.setup_token_hash, u.password_hash)
    assert len(logs) == 1 and logs[0].data == {"doctorId": int(d["id"])} and logs[0].actor_user_id is not None
    assert token not in todo                                                                           # el enlace nunca queda en la bitacora


def test_el_administrador_tambien_lo_genera_y_un_doctor_no(login):
    d = alta(login("admin"))
    generar(login("admin"), d["id"])
    r = login("doctor").post(f"/api/doctors/{d['id']}/password-link")
    assert r.status_code == 403
    assert login("staff").post("/api/doctors/9999/password-link").status_code == 404
    assert login("staff").post("/api/doctors/abc/password-link").status_code == 404


def test_un_doctor_anterior_sin_cuenta_la_recibe_al_generar_el_enlace(login, db):
    assert cuentas(db, 5) == []                                      # los doctores del seed no traen cuenta
    generar(login("staff"), 5)
    assert [(u.role, u.email, u.password_hash) for u in cuentas(db, 5)] == [("doctor", None, None)]


def test_con_cuenta_existente_no_se_crea_otra_y_el_enlace_reemplaza_al_anterior(client, login, db):
    staff = login("staff")                                           # el doctor 1 ya tiene su cuenta (con correo y contrasena)
    antes = [u.id for u in cuentas(db, 1)]
    t1 = token_de(generar(staff, 1)["url"])
    t2 = token_de(generar(staff, 1)["url"])
    assert [u.id for u in cuentas(db, 1)] == antes and t1 != t2
    assert revisar(client, t1).status_code == 404                    # el anterior ya no sirve
    assert revisar(client, t2).status_code == 200


def test_con_la_cuenta_desactivada_no_se_genera(login, users):
    admin = login("admin")
    assert admin.patch(f"/api/users/{users['doctor'][2].id}", {"active": False}).status_code == 200
    r = login("staff").post("/api/doctors/1/password-link")
    assert r.status_code == 422 and "desactivada" in r.get_json()["detail"] and "administrador" in r.get_json()["detail"]


def test_sin_direccion_de_la_app_del_doctor_responde_503_y_no_crea_nada(make_app):
    app = make_app(DOCTOR_APP_URL="")
    make_users(app)
    staff = Session(app, "recepcion@clinica.test")
    r = staff.post("/api/doctors/5/password-link")
    assert r.status_code == 503 and r.get_json() == {"error": "no_configurado"}
    with app.extensions["db"].session_factory() as s:
        assert s.scalar(select(func.count()).select_from(User).where(User.doctor_id == 5)) == 0


def test_la_direccion_se_normaliza_con_o_sin_diagonal_final(make_app):
    primera = True
    for base in ("https://clinica.test/doctor", "https://clinica.test/doctor/", "  https://clinica.test/doctor/  "):
        app = make_app(DOCTOR_APP_URL=base)
        if primera:                                                  # las tres apps comparten la misma base: los usuarios se crean una vez
            make_users(app)
            primera = False
        url = generar(Session(app, "recepcion@clinica.test"), 5)["url"]
        assert url.startswith("https://clinica.test/doctor/#/contrasena?t="), base


# ------------------------------------------------------------------ abrir y usar el enlace
def test_la_pagina_del_enlace_dice_de_quien_es_sin_cambiar_nada(client, login, db):
    d = alta(login("staff"), "Dra. Del Enlace")
    token = token_de(generar(login("staff"), d["id"])["url"])
    r = revisar(client, token)
    assert r.status_code == 200 and r.get_json()["doctorCode"] == d["code"] and r.get_json()["doctorName"] == "Dra. Del Enlace"
    assert_schema("PasswordLinkInfo", r.get_json())
    assert revisar(client, token).status_code == 200                 # revisarlo no lo gasta
    assert "Set-Cookie" not in r.headers


@pytest.mark.parametrize("token", ["", "nada", "x" * 32, "y" * 200, None, 5])
def test_un_enlace_que_no_existe_es_el_mismo_404(client, users, token):
    r = revisar(client, token)
    assert r.status_code == 404 and r.get_json() == {"error": "enlace_invalido"}
    r = usar(client, token if isinstance(token, str) and token else "x" * 32)
    assert r.status_code == 404 and r.get_json() == {"error": "enlace_invalido"}


def test_el_doctor_nuevo_establece_su_contrasena_con_el_enlace_y_entra(client, login, db):
    staff = login("staff")
    d = alta(staff)
    token = token_de(generar(staff, d["id"])["url"])
    r = usar(client, token)
    j = r.get_json()
    assert r.status_code == 200 and j["user"]["role"] == "doctor" and j["user"]["doctorId"] == d["id"] and j["user"]["passwordSet"] is True
    assert j["user"]["email"] is None and j["csrfToken"]
    assert_schema("SessionInfo", j)
    cookie = r.headers["Set-Cookie"]
    assert "clinica_session=" in cookie and "HttpOnly" in cookie and "SameSite=Lax" in cookie
    assert client.get("/api/me").get_json()["user"]["doctorId"] == d["id"]               # ya esta dentro
    assert client.get("/api/doctor/hours").get_json()["code"] == d["code"]
    (u,) = cuentas(db, d["id"])
    assert u.password_hash and u.setup_token_hash is None and u.setup_expires_at is None and u.last_login_at is not None
    # y de ahi en adelante entra con su codigo y su contrasena, y sale en la lista de la entrada
    other = client.application.test_client()
    assert doctor_login(other, d["code"], NUEVA).status_code == 200
    assert d["code"] in [i["code"] for i in other.get("/api/auth/doctors").get_json()["items"]]
    with db() as s:
        (log,) = [a for a in s.scalars(select(AuditLog)) if a.action == "auth.password_set"]
    assert log.actor_user_id == u.id and log.data == {"via": "enlace"} and NUEVA not in str(log.data)


def test_el_enlace_es_de_un_solo_uso(client, login):
    staff = login("staff")
    d = alta(staff)
    token = token_de(generar(staff, d["id"])["url"])
    assert usar(client, token).status_code == 200
    other = client.application.test_client()
    assert usar(other, token, "otra-contrasena-larga-2").status_code == 404
    assert revisar(other, token).status_code == 404
    assert doctor_login(other, d["code"], NUEVA).status_code == 200                      # la contrasena sigue siendo la primera
    assert doctor_login(other, d["code"], "otra-contrasena-larga-2").status_code == 401


@pytest.mark.parametrize("password", ["corta", "x" * 129, "", "      "])
def test_una_contrasena_invalida_es_422_y_no_gasta_el_enlace(client, login, password):
    staff = login("staff")
    d = alta(staff)
    token = token_de(generar(staff, d["id"])["url"])
    r = usar(client, token, password)
    assert r.status_code == 422 and r.get_json()["error"] == "validacion"
    assert revisar(client, token).status_code == 200                                    # sigue valiendo
    assert usar(client, token).status_code == 200


def test_cuerpo_invalido_es_422(client, users):
    for body in ({}, {"token": "x" * 32}, {"password": NUEVA}, {"token": 5, "password": NUEVA}, {"token": "x" * 32, "password": None}, []):
        r = client.post("/api/auth/password-link/use", json=body)
        assert r.status_code == 422 and r.get_json()["error"] == "validacion", body


def test_el_enlace_vence_a_las_72_horas(make_app):
    clock = Clock()
    app = make_app(clock=clock)
    make_users(app)
    staff = Session(app, "recepcion@clinica.test")
    d = alta(staff)
    token = token_de(generar(staff, d["id"])["url"])
    c = app.test_client()
    clock.advance(hours=71, minutes=59)
    assert revisar(c, token).status_code == 200
    clock.advance(minutes=1, seconds=1)
    assert revisar(c, token).status_code == 404 and usar(c, token).status_code == 404
    staff = Session(app, "recepcion@clinica.test")                                        # (su sesion tambien caduco: 72 h sin actividad)
    token2 = token_de(generar(staff, d["id"])["url"])                                     # se genera otro y sirve
    assert usar(c, token2).status_code == 200


def test_origin_ajeno_es_403_en_las_dos_rutas_publicas(client, login):
    staff = login("staff")
    d = alta(staff)
    token = token_de(generar(staff, d["id"])["url"])
    for path, body in (("/api/auth/password-link/check", {"token": token}), ("/api/auth/password-link/use", {"token": token, "password": NUEVA})):
        r = client.post(path, json=body, headers={"Origin": "https://evil.example"})
        assert r.status_code == 403 and r.get_json() == {"error": "sin_permiso", "detail": "csrf"}
    assert revisar(client, token).status_code == 200                                      # el enlace sigue intacto


# ------------------------------------------------------------------ recuperar una contrasena olvidada
def test_un_doctor_que_olvido_su_contrasena_pone_otra_con_un_enlace_nuevo(make_app, db):
    clock = Clock()
    app = make_app(clock=clock)
    users = make_users(app)
    staff = Session(app, "recepcion@clinica.test")
    viejo = app.test_client()
    assert doctor_login(viejo, "1001", PASSWORD).status_code == 200                       # el doctor 1 ya tenia contrasena y una sesion abierta
    assert viejo.get("/api/me").status_code == 200
    for _ in range(5):                                                                    # se le olvida: se bloquea
        doctor_login(app.test_client(), "1001", "no-es")
    assert doctor_login(app.test_client(), "1001", PASSWORD).status_code == 429

    token = token_de(generar(staff, 1)["url"])
    nuevo = app.test_client()
    assert usar(nuevo, token).status_code == 200
    assert nuevo.get("/api/me").status_code == 200
    assert viejo.get("/api/me").status_code == 401                                        # la sesion anterior se cerro
    assert doctor_login(app.test_client(), "1001", PASSWORD).status_code == 401           # la contrasena vieja ya no sirve
    assert doctor_login(app.test_client(), "1001", NUEVA).status_code == 200              # y el bloqueo se quito
    with app.extensions["db"].session_factory() as s:
        assert s.scalar(select(func.count()).select_from(UserSession)) >= 2


# ------------------------------------------------------------------ eliminar un doctor con su cuenta recien creada
def test_se_elimina_un_doctor_recien_creado_junto_con_su_cuenta_sin_usar(login, db):
    admin = login("admin")
    d = alta(admin)
    generar(admin, d["id"])                                                               # aun con un enlace pendiente
    assert admin.delete(f"/api/doctors/{d['id']}").status_code == 204
    assert cuentas(db, d["id"]) == []
    with db() as s:
        assert [a.data for a in s.scalars(select(AuditLog)) if a.action == "user.delete"] == [{"doctorId": int(d["id"])}]


def test_con_contrasena_ya_establecida_el_doctor_no_se_elimina(client, login, db):
    admin = login("admin")
    d = alta(admin)
    assert usar(client, token_de(generar(admin, d["id"])["url"])).status_code == 200
    r = admin.delete(f"/api/doctors/{d['id']}")
    assert r.status_code == 409 and r.get_json()["error"] == "doctor_con_usuario" and "Usuarios" in r.get_json()["detail"]
    assert len(cuentas(db, d["id"])) == 1                                                  # nada se borro
    assert admin.patch(f"/api/doctors/{d['id']}", {"active": False}).status_code == 200    # lo que si: darlo de baja


def test_con_citas_no_se_elimina_y_su_cuenta_se_conserva(login, db, agenda):
    admin = login("admin")
    d = alta(admin)
    t = next_weekday(agenda, 2, 11)
    from app.db import iso_utc, to_db
    cita = admin.post("/api/appointments", {"patientName": "Ana Lopez", "phone": "5219981110001", "doctorId": d["id"],
                                            "scheduledAtUtc": iso_utc(to_db(t))})
    assert cita.status_code == 201, cita.get_json()
    r = admin.delete(f"/api/doctors/{d['id']}")
    assert r.status_code == 409 and r.get_json()["error"] == "doctor_con_citas"
    assert len(cuentas(db, d["id"])) == 1
