"""Entrada del doctor con su codigo de 4 digitos (sin correo): la lista publica, el login, el bloqueo y la asignacion de codigos."""
import pytest
from sqlalchemy import select

from app.agenda import AgendaError
from app.doctor_codes import next_code
from app.models import AuditLog, Doctor
from helpers import PASSWORD, Clock, assert_schema, check_contract, make_users


def login_doctor(client, code, password=PASSWORD, **kw):
    return client.post("/api/auth/doctor-login", json={"doctorCode": code, "password": password}, **kw)


def lista(client):
    r = client.get("/api/auth/doctors")
    check_contract("GET", "/api/auth/doctors", r)
    return r


# ------------------------------------------------------------------ el codigo de cada doctor
def test_el_seed_da_a_cada_doctor_su_codigo_en_orden_desde_1001(db):
    with db() as s:
        codes = [(d.id, d.code) for d in s.scalars(select(Doctor).order_by(Doctor.id))]
    assert codes == [(i, str(1000 + i)) for i in range(1, 8)]


def test_next_code_es_el_menor_libre_desde_1001():
    assert next_code([]) == "1001"
    assert next_code(["1001", "1002"]) == "1003"
    assert next_code(["1001", "1003"]) == "1002"                  # rellena el hueco de un doctor eliminado
    assert next_code(["9999", "1002"]) == "1001"
    with pytest.raises(AgendaError):                              # 1001 a 9999 todos ocupados
        next_code(str(n) for n in range(1001, 10000))


def test_un_doctor_nuevo_recibe_el_siguiente_codigo_y_todos_lo_ven_en_la_lista_de_doctores(login):
    admin, staff = login("admin"), login("staff")
    r = admin.post("/api/doctors", {"name": "Dr. Nuevo", "specialty": "Cardiologia"})
    assert r.status_code == 201 and r.get_json()["code"] == "1008"
    assert_schema("Doctor", r.get_json())
    codes = {d["name"]: d["code"] for d in staff.get("/api/doctors").get_json()["items"]}
    assert codes["Dr. Nuevo"] == "1008" and len(set(codes.values())) == len(codes) == 8
    assert all(len(c) == 4 and c.isdigit() for c in codes.values())


def test_el_codigo_de_un_doctor_eliminado_se_puede_volver_a_usar_y_nunca_se_repite_uno_vigente(login):
    admin = login("admin")
    nuevo = admin.post("/api/doctors", {"name": "Dr. Temporal", "specialty": "X"}).get_json()
    assert nuevo["code"] == "1008"
    assert admin.delete(f"/api/doctors/{nuevo['id']}").status_code == 204        # nunca tuvo citas ni cuenta
    otro = admin.post("/api/doctors", {"name": "Dr. Otro", "specialty": "Y"}).get_json()
    assert otro["code"] == "1008"
    assert admin.post("/api/doctors", {"name": "Dr. Tercero", "specialty": "Z"}).get_json()["code"] == "1009"


def test_el_codigo_no_se_edita(login):
    admin = login("admin")
    r = admin.patch("/api/doctors/1", {"code": "9999", "specialty": "Coloproctologia"})
    assert r.status_code == 200 and r.get_json()["code"] == "1001" and r.get_json()["specialty"] == "Coloproctologia"


def test_una_carrera_por_el_mismo_codigo_se_corrige_sola(app, login, monkeypatch):
    """Dos altas simultaneas calculan el mismo codigo libre: la segunda choca con el UNIQUE y repite con el siguiente."""
    import app.directory as directory
    real, calls = directory.next_code, []

    def con_choque(used):
        calls.append(1)
        return "1001" if len(calls) == 1 else real(used)               # el primer intento propone uno YA ocupado

    monkeypatch.setattr(directory, "next_code", con_choque)
    r = login("admin").post("/api/doctors", {"name": "Dr. Carrera", "specialty": "X"})
    assert r.status_code == 201 and r.get_json()["code"] == "1008" and len(calls) == 2


def test_el_alta_con_un_nombre_repetido_sigue_siendo_422(login):
    r = login("admin").post("/api/doctors", {"name": "Dr. Cervantes Peláez", "specialty": "X"})
    assert r.status_code == 422 and "nombre" in r.get_json()["detail"]


# ------------------------------------------------------------------ la lista publica
def test_la_lista_es_publica_y_trae_solo_codigo_y_nombre_de_quienes_tienen_cuenta(client, users):
    r = lista(client)                                                 # sin sesion
    assert r.status_code == 200 and r.headers["Cache-Control"] == "no-store"
    assert r.get_json() == {"items": [{"code": "1001", "name": "Dr. Cervantes Peláez"},
                                      {"code": "1002", "name": "Dr. Pérez Lago"}]}
    assert_schema("LoginDoctorList", r.get_json())
    texto = r.get_data(as_text=True).lower()
    assert "clinica.test" not in texto and "@" not in texto and "hash" not in texto      # nada del correo ni de la cuenta


def test_sin_cuentas_de_doctor_la_lista_esta_vacia(client):
    assert lista(client).get_json() == {"items": []}


def test_un_doctor_dado_de_baja_deja_de_aparecer_y_ya_no_entra(client, users, login):
    admin = login("admin")
    assert admin.patch(f"/api/users/{users['doctor2'][2].id}", {"active": False}).status_code == 200
    assert [i["code"] for i in lista(client).get_json()["items"]] == ["1001"]
    assert login_doctor(client, "1002").status_code == 401
    assert admin.patch(f"/api/users/{users['doctor2'][2].id}", {"active": True}).status_code == 200
    assert [i["code"] for i in lista(client).get_json()["items"]] == ["1001", "1002"]


def test_un_doctor_con_dos_cuentas_aparece_una_sola_vez(app, client, users):
    app.extensions["auth"].create_user(email="otra@clinica.test", name="Otra cuenta", role="doctor", password=PASSWORD, doctor_id=1)
    assert [i["code"] for i in lista(client).get_json()["items"]] == ["1001", "1002"]


def test_la_lista_sigue_el_orden_por_codigo(app, client, users):
    app.extensions["auth"].create_user(email="d7@clinica.test", name="Siete", role="doctor", password=PASSWORD, doctor_id=7)
    app.extensions["auth"].create_user(email="d3@clinica.test", name="Tres", role="doctor", password=PASSWORD, doctor_id=3)
    assert [i["code"] for i in lista(client).get_json()["items"]] == ["1001", "1002", "1003", "1007"]


# ------------------------------------------------------------------ el login con codigo
def test_login_con_codigo_abre_la_sesion_del_doctor(client, users, db):
    r = login_doctor(client, "1001")
    check_contract("POST", "/api/auth/doctor-login", r)
    j = r.get_json()
    assert r.status_code == 200 and j["user"]["role"] == "doctor" and j["user"]["doctorId"] == "1" and j["csrfToken"]
    assert_schema("SessionInfo", j)
    cookie = r.headers["Set-Cookie"]
    assert "clinica_session=" in cookie and "HttpOnly" in cookie and "SameSite=Lax" in cookie
    me = client.get("/api/me").get_json()
    assert me["user"] == j["user"] and me["csrfToken"] == j["csrfToken"]
    assert client.get("/api/doctor/hours").get_json()["code"] == "1001"            # y es SU agenda
    with db() as s:
        (log,) = [a for a in s.scalars(select(AuditLog)) if a.action == "auth.login"]
    assert log.actor_kind == "user" and log.data == {"via": "codigo"} and "1001" not in str(log.data.get("via"))


def test_el_codigo_admite_espacios_alrededor(client, users):
    assert login_doctor(client, " 1002 ").status_code == 200


def test_el_correo_sigue_sirviendo_para_el_login_de_siempre(client, users):
    r = client.post("/api/auth/login", json={"email": "dr.cervantes@clinica.test", "password": PASSWORD})
    assert r.status_code == 200 and r.get_json()["user"]["doctorId"] == "1"


@pytest.mark.parametrize("code,password", [
    ("1001", "mala"),                       # contrasena equivocada
    ("1001", PASSWORD + "x"),
    ("1005", PASSWORD),                     # doctor SIN cuenta
    ("9999", PASSWORD),                     # codigo que no existe
    ("abcd", PASSWORD), ("123", PASSWORD), ("12345", PASSWORD), ("1 01", PASSWORD), ("0001", PASSWORD),     # no es un codigo
])
def test_las_credenciales_malas_dan_el_mismo_401_sin_cookie(client, users, code, password):
    r = login_doctor(client, code, password)
    check_contract("POST", "/api/auth/doctor-login", r)
    assert r.status_code == 401 and r.get_json() == {"error": "credenciales_invalidas"}
    assert "Set-Cookie" not in r.headers


def test_la_contrasena_de_otro_usuario_no_sirve(app, client, users):
    """La contrasena es de la cuenta ligada al codigo: ni la de otro doctor ni la del personal abren esa sesion."""
    auth = app.extensions["auth"]
    auth.update_user(users["doctor2"][2].id, {"password": "contrasena-de-la-dra-2"})
    auth.update_user(users["staff"][2].id, {"password": "contrasena-del-personal"})
    assert login_doctor(client, "1001", "contrasena-de-la-dra-2").status_code == 401
    assert login_doctor(client, "1001", "contrasena-del-personal").status_code == 401
    assert login_doctor(client, "1002", "contrasena-de-la-dra-2").status_code == 200


@pytest.mark.parametrize("body", [{}, {"doctorCode": "1001"}, {"password": "x"}, {"doctorCode": 1001, "password": "x"},
                                  {"doctorCode": "  ", "password": "x"}, {"doctorCode": "1001", "password": None}, []])
def test_cuerpo_invalido_es_422(client, users, body):
    r = client.post("/api/auth/doctor-login", json=body)
    check_contract("POST", "/api/auth/doctor-login", r)
    assert r.status_code == 422 and r.get_json()["error"] == "validacion"


def test_origin_ajeno_es_403(client, users):
    r = login_doctor(client, "1001", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and r.get_json() == {"error": "sin_permiso", "detail": "csrf"}
    assert login_doctor(client, "1001", headers={"Origin": "http://localhost"}).status_code == 200


def test_cinco_contrasenas_malas_bloquean_la_cuenta_tambien_para_el_correo(make_app):
    """El contador es de la CUENTA: entrar por codigo o por correo suma igual, y el bloqueo vale para las dos entradas."""
    clock = Clock()
    app = make_app(clock=clock)
    make_users(app)
    c = app.test_client()
    for _ in range(4):
        assert login_doctor(c, "1001", "mala").status_code == 401
    r = login_doctor(c, "1001", "mala")
    check_contract("POST", "/api/auth/doctor-login", r)
    assert r.status_code == 429 and r.get_json() == {"error": "demasiados_intentos"} and r.headers["Retry-After"] == "900"
    assert login_doctor(c, "1001").status_code == 429                                                  # ni con la buena
    assert c.post("/api/auth/login", json={"email": "dr.cervantes@clinica.test", "password": PASSWORD}).status_code == 429
    assert login_doctor(c, "1002").status_code == 200                                                  # otro doctor no se afecta
    clock.advance(minutes=15, seconds=1)
    assert login_doctor(c, "1001").status_code == 200


def test_un_codigo_que_no_existe_no_bloquea_a_nadie(client, users):
    for _ in range(8):
        assert login_doctor(client, "9999", "mala").status_code == 401
    assert login_doctor(client, "1001").status_code == 200
