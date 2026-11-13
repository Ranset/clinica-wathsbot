"""Autenticacion: login, cookie de sesion, CSRF/Origin, caducidad, bloqueo por intentos y comandos de usuario."""
import hashlib

import pytest
from sqlalchemy import select

from app.auth import MIN_PASSWORD, check_password_policy
from app.agenda import AgendaError
from app.config import load_config
from app.models import AuditLog, User, UserSession
from helpers import ACCOUNTS, PASSWORD, Clock, Session, assert_schema


def post_login(client, email, password, **kw):
    return client.post("/api/auth/login", json={"email": email, "password": password}, **kw)


# ------------------------------------------------------------------ login y cookie
def test_login_correcto_devuelve_usuario_y_csrf_y_pone_la_cookie(client, users):
    r = post_login(client, "recepcion@clinica.test", PASSWORD)
    j = r.get_json()
    assert r.status_code == 200 and j["user"]["role"] == "staff" and j["user"]["doctorId"] is None and j["csrfToken"]
    assert_schema("SessionInfo", j)
    cookie = r.headers["Set-Cookie"]
    assert "clinica_session=" in cookie and "HttpOnly" in cookie and "SameSite=Lax" in cookie and "Path=/" in cookie
    assert set(j["user"]) == {"id", "email", "name", "role", "doctorId", "active", "passwordSet"} and "hash" not in str(j).lower()
    me = client.get("/api/me").get_json()
    assert me["user"] == j["user"] and me["csrfToken"] == j["csrfToken"]          # el token CSRF es estable en la sesion


def test_el_correo_no_distingue_mayusculas_ni_espacios(client, users):
    assert post_login(client, "  RECEPCION@Clinica.Test ", PASSWORD).status_code == 200


def test_la_cookie_es_secure_por_defecto_en_produccion(make_app, users):
    assert load_config({"DATABASE_URL": "sqlite://"})["AUTH_COOKIE_SECURE"] is True
    c = make_app(AUTH_COOKIE_SECURE=True).test_client()
    r = post_login(c, "recepcion@clinica.test", PASSWORD, base_url="https://localhost")
    assert r.status_code == 200 and "Secure" in r.headers["Set-Cookie"]


def test_en_la_bd_solo_queda_el_hash_del_token(client, users, db):
    r = post_login(client, "recepcion@clinica.test", PASSWORD)
    token = client.get_cookie("clinica_session").value
    with db() as s:
        (row,) = s.scalars(select(UserSession)).all()
    assert row.token_hash == hashlib.sha256(token.encode()).hexdigest() and token not in (row.token_hash, row.csrf_token)
    assert r.get_json()["csrfToken"] == row.csrf_token


def test_las_contrasenas_no_se_guardan_en_claro(users, db):
    with db() as s:
        hashes = [u.password_hash for u in s.scalars(select(User))]
    assert len(hashes) == 4 and all(PASSWORD not in h and h.startswith(("scrypt:", "pbkdf2:")) for h in hashes)
    assert len(set(hashes)) == 4                                                    # con sal: ni dos iguales


@pytest.mark.parametrize("email,password", [("recepcion@clinica.test", "mala"), ("nadie@clinica.test", PASSWORD),
                                            ("RECEPCION@clinica.test", PASSWORD + "x")])
def test_credenciales_malas_dan_el_mismo_401(client, users, email, password):
    r = post_login(client, email, password)
    assert r.status_code == 401 and r.get_json() == {"error": "credenciales_invalidas"}
    assert "Set-Cookie" not in r.headers


def test_un_usuario_inactivo_no_entra_y_no_se_distingue(app, client, users, login):
    admin = login("admin")
    assert admin.patch(f"/api/users/{users['staff'][2].id}", {"active": False}).status_code == 200
    r = post_login(client, "recepcion@clinica.test", PASSWORD)
    assert r.status_code == 401 and r.get_json() == {"error": "credenciales_invalidas"}


@pytest.mark.parametrize("body", [{}, {"email": "a@b.co"}, {"password": "x"}, {"email": 5, "password": "x"},
                                  {"email": "a@b.co", "password": None}, {"email": "  ", "password": "x"}, []])
def test_login_con_cuerpo_invalido_es_422(client, users, body):
    r = client.post("/api/auth/login", json=body)
    assert r.status_code == 422 and r.get_json()["error"] == "validacion"


def test_login_con_origin_ajeno_es_403(client, users):
    r = post_login(client, "recepcion@clinica.test", PASSWORD, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and r.get_json() == {"error": "sin_permiso", "detail": "csrf"}
    assert post_login(client, "recepcion@clinica.test", PASSWORD, headers={"Origin": "http://localhost"}).status_code == 200


def test_el_login_queda_en_la_bitacora_sin_datos_personales(client, users, db):
    post_login(client, "recepcion@clinica.test", PASSWORD)
    with db() as s:
        logins = [a for a in s.scalars(select(AuditLog)) if a.action == "auth.login"]
    assert len(logins) == 1 and logins[0].actor_kind == "user" and "recepcion" not in str(logins[0].data)


# ------------------------------------------------------------------ bloqueo por intentos
def test_cinco_contrasenas_malas_bloquean_15_minutos_y_vuelve_a_entrar_despues(make_app):
    clock = Clock()
    app = make_app(clock=clock)
    from helpers import make_users
    make_users(app)
    c = app.test_client()
    for i in range(4):
        assert post_login(c, "recepcion@clinica.test", "mala").status_code == 401
    r = post_login(c, "recepcion@clinica.test", "mala")                          # la 5.a ya bloquea
    assert r.status_code == 429 and r.get_json() == {"error": "demasiados_intentos"} and r.headers["Retry-After"] == "900"
    assert post_login(c, "recepcion@clinica.test", PASSWORD).status_code == 429   # ni con la contrasena correcta
    clock.advance(minutes=14, seconds=50)
    assert post_login(c, "recepcion@clinica.test", PASSWORD).status_code == 429
    clock.advance(seconds=20)
    assert post_login(c, "recepcion@clinica.test", PASSWORD).status_code == 200  # el bloqueo vencio
    assert post_login(c, "recepcion@clinica.test", "mala").status_code == 401    # y el contador empezo de cero


def test_los_fallos_se_acumulan_aunque_se_rechace_y_un_acierto_los_reinicia(client, users, db):
    for _ in range(3):
        post_login(client, "recepcion@clinica.test", "mala")
    with db() as s:
        assert s.scalars(select(User).where(User.email == "recepcion@clinica.test")).one().failed_logins == 3   # se confirmo
    assert post_login(client, "recepcion@clinica.test", PASSWORD).status_code == 200
    for _ in range(4):
        assert post_login(client, "recepcion@clinica.test", "mala").status_code == 401                        # 4 mas: sin bloqueo
    with db() as s:
        assert s.scalars(select(User).where(User.email == "recepcion@clinica.test")).one().failed_logins == 4


def test_bloquear_a_un_usuario_no_afecta_a_otro(client, users):
    for _ in range(5):
        post_login(client, "recepcion@clinica.test", "mala")
    assert post_login(client, "admin@clinica.test", PASSWORD).status_code == 200


# ------------------------------------------------------------------ CSRF y Origin
def test_escrituras_exigen_el_token_csrf_de_la_sesion(login):
    s = login("staff")
    for headers in ({}, {"X-CSRF-Token": ""}, {"X-CSRF-Token": "no-es-el-token"}, {"X-CSRF-Token": s.csrf + "x"}):
        r = s.client.post("/api/attention/1/resolve", json={}, headers=headers)
        assert r.status_code == 403 and r.get_json() == {"error": "sin_permiso", "detail": "csrf"}, headers
    assert s.post("/api/attention/1/resolve").status_code == 404           # con el token correcto llega a la ruta
    assert s.get("/api/me").status_code == 200                              # y una lectura no lo necesita


def test_el_token_csrf_de_otra_sesion_no_sirve(app, users):
    a, b = Session(app, users["staff"][0]), Session(app, users["staff"][0])
    assert a.csrf != b.csrf
    r = a.client.post("/api/attention/1/resolve", json={}, headers={"X-CSRF-Token": b.csrf})
    assert r.status_code == 403


def test_origin_ajeno_se_rechaza_aunque_el_token_sea_correcto(login):
    s = login("staff")
    r = s.client.post("/api/attention/1/resolve", json={}, headers={"X-CSRF-Token": s.csrf, "Origin": "https://evil.example"})
    assert r.status_code == 403 and r.get_json()["detail"] == "csrf"
    r = s.client.post("/api/attention/1/resolve", json={}, headers={"X-CSRF-Token": s.csrf, "Origin": "null"})
    assert r.status_code == 403
    r = s.client.post("/api/attention/1/resolve", json={}, headers={"X-CSRF-Token": s.csrf, "Origin": "http://localhost"})
    assert r.status_code == 404                                              # mismo sitio: pasa a la ruta


# ------------------------------------------------------------------ cierre y caducidad
def test_logout_cierra_la_sesion(login, client):
    s = login("staff")
    r = s.post("/api/auth/logout")
    assert r.status_code == 204 and "clinica_session=;" in r.headers["Set-Cookie"].replace(" ", "")
    assert s.get("/api/me").status_code == 401
    assert s.client.post("/api/auth/logout", headers={"X-CSRF-Token": s.csrf}).status_code == 401


def test_logout_sin_csrf_es_403(login):
    s = login("staff")
    assert s.client.post("/api/auth/logout", json={}).status_code == 403
    assert s.get("/api/me").status_code == 200                              # no se cerro


def test_una_cookie_robada_no_sirve_tras_cerrar_sesion(app, users):
    s = Session(app, users["staff"][0])
    token = s.client.get_cookie("clinica_session").value
    s.post("/api/auth/logout")
    ladron = app.test_client()
    ladron.set_cookie("clinica_session", token)
    assert ladron.get("/api/me").status_code == 401


@pytest.mark.parametrize("cookie", ["", "x", "a" * 500, "token-inventado-que-no-existe-12345678"])
def test_cookies_invalidas_son_401_y_se_borran(client, users, cookie):
    client.set_cookie("clinica_session", cookie)
    r = client.get("/api/me")
    assert r.status_code == 401 and r.get_json() == {"error": "no_autenticado"}


def test_una_sesion_sin_actividad_caduca_a_las_8_horas_y_la_cookie_se_borra(make_app):
    clock = Clock()
    app = make_app(clock=clock)
    from helpers import make_users
    make_users(app)
    s = Session(app, "recepcion@clinica.test")
    clock.advance(hours=7, minutes=50)
    assert s.get("/api/me").status_code == 200                                # con actividad sigue
    clock.advance(hours=7, minutes=50)
    assert s.get("/api/me").status_code == 200                                # (la actividad la renovo)
    clock.advance(hours=8, minutes=1)                                         # 8 h sin tocar nada
    r = s.get("/api/me")
    assert r.status_code == 401 and "clinica_session=;" in r.headers["Set-Cookie"].replace(" ", "")


def test_la_sesion_caduca_a_los_7_dias_aunque_haya_actividad(make_app):
    clock = Clock()
    app = make_app(clock=clock)
    from helpers import make_users
    make_users(app)
    s = Session(app, "recepcion@clinica.test")
    for _ in range(27):                                                       # 6 h, 27 veces = 6 dias y 18 h
        clock.advance(hours=6)
        assert s.get("/api/me").status_code == 200
    clock.advance(hours=6)                                                    # llega a los 7 dias
    assert s.get("/api/me").status_code == 401


def test_una_sesion_caducada_se_borra_de_la_bd(make_app, db):
    clock = Clock()
    app = make_app(clock=clock)
    from helpers import make_users
    make_users(app)
    s = Session(app, "recepcion@clinica.test")
    clock.advance(hours=9)
    s.get("/api/me")
    with app.extensions["db"].session_factory() as ses:
        assert ses.scalars(select(UserSession)).all() == []


# ------------------------------------------------------------------ politica de contrasenas
@pytest.mark.parametrize("pw", ["", "corta", "x" * 9, "y" * 129, None, 123456789012])
def test_contrasenas_fuera_de_politica(pw):
    with pytest.raises(AgendaError) as e:
        check_password_policy(pw)
    assert e.value.code == "validacion"


def test_la_contrasena_no_puede_ser_el_correo():
    with pytest.raises(AgendaError):
        check_password_policy("recepcion@clinica.test", "recepcion@clinica.test")
    assert check_password_policy("x" * MIN_PASSWORD) == "x" * MIN_PASSWORD


# ------------------------------------------------------------------ comandos de usuario
def test_create_user_crea_el_primer_administrador_sin_pasar_la_clave_por_argumento(app):
    runner = app.test_cli_runner()
    r = runner.invoke(args=["create-user", "--email", "primera@clinica.test", "--name", "Primera Admin", "--role", "admin"],
                      input="clave-muy-larga-1\nclave-muy-larga-1\n")
    assert r.exit_code == 0 and "usuario creado" in r.output and "clave-muy-larga-1" not in r.output
    assert Session(app, "primera@clinica.test", "clave-muy-larga-1").user["role"] == "admin"


def test_create_user_rechaza_clave_corta_y_correo_repetido(app, users):
    runner = app.test_cli_runner()
    r = runner.invoke(args=["create-user", "--email", "otra@clinica.test", "--name", "Otra Persona"], input="corta\ncorta\n")
    assert r.exit_code != 0 and "contrasena" in r.output
    r = runner.invoke(args=["create-user", "--email", "admin@clinica.test", "--name", "Repetido"],
                      input="clave-muy-larga-1\nclave-muy-larga-1\n")
    assert r.exit_code != 0 and "correo" in r.output


def test_set_password_recupera_el_acceso_y_desbloquea(app, users, client):
    for _ in range(5):
        post_login(client, "recepcion@clinica.test", "mala")
    assert post_login(client, "recepcion@clinica.test", PASSWORD).status_code == 429
    r = app.test_cli_runner().invoke(args=["set-password", "--email", "recepcion@clinica.test"],
                                     input="nueva-clave-larga-2\nnueva-clave-larga-2\n")
    assert r.exit_code == 0 and "actualizada" in r.output
    assert post_login(client, "recepcion@clinica.test", PASSWORD).status_code == 401
    assert post_login(client, "recepcion@clinica.test", "nueva-clave-larga-2").status_code == 200
    r = app.test_cli_runner().invoke(args=["set-password", "--email", "nadie@clinica.test"], input="clave-muy-larga-1\nclave-muy-larga-1\n")
    assert r.exit_code != 0


def test_cuentas_de_prueba_listas(users):
    assert set(users) == set(ACCOUNTS)
