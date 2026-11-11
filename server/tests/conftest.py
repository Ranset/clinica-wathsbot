"""Fixtures de la suite del servidor.

Cada prueba de datos corre contra SQLite (siempre) y contra MySQL 8 (si esta configurado):

  - `TEST_MYSQL_URL=mysql+pymysql://root:clave@127.0.0.1:33307/clinica_test?charset=utf8mb4`  usa ese servidor, o
  - `TEST_MYSQL_DOCKER=1`  levanta/reutiliza un contenedor mysql:8 (Docker Desktop abierto; igual que scripts/mysql_test_db.sh).

Sin ninguna de las dos, las variantes `[mysql]` se SALTAN (no fallan) con el motivo en el resumen (`-rs`).
OJO: el servidor MySQL de pruebas se VACIA (DROP/CREATE de las tablas); no apuntarlo a una base con datos reales.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import create_app  # noqa: E402
from app.db import make_engine  # noqa: E402
from app.migrate import upgrade  # noqa: E402
from app.models import Base, Room  # noqa: E402
from app.seed import seed  # noqa: E402
from helpers import MAXCONN, TEST_BOT_TOKEN, TEST_WEBHOOK_SECRET, Session, make_users  # noqa: E402

BACKENDS = ["sqlite", pytest.param("mysql", marks=pytest.mark.mysql)]
POOL = 40  # las pruebas de concurrencia lanzan decenas de hilos


def pytest_report_header(config):
    if os.environ.get("TEST_MYSQL_URL") or os.environ.get("TEST_MYSQL_DOCKER") == "1":
        return "MySQL: configurado, las pruebas de datos corren en [sqlite] y [mysql]"
    return "MySQL: NO configurado (TEST_MYSQL_URL / TEST_MYSQL_DOCKER=1): las variantes [mysql] se saltan; solo corre SQLite"


def pytest_configure(config):
    config.addinivalue_line("markers", "mysql: prueba que corre contra MySQL 8 real (se salta si no esta configurado)")


# --------------------------------------------------------------------------- SQLite
@pytest.fixture(scope="session")
def sqlite_template(tmp_path_factory) -> Path:
    """BD SQLite con el esquema de los modelos + seed, creada una vez y copiada por prueba (rapido)."""
    path = tmp_path_factory.mktemp("tpl") / "template.db"
    engine = make_engine("sqlite:///" + path.as_posix())
    Base.metadata.create_all(engine)
    from sqlalchemy.orm import Session
    with Session(engine) as s, s.begin():
        seed(s)
    engine.dispose()  # checkpoint del WAL: el archivo queda autocontenido
    return path


# --------------------------------------------------------------------------- MySQL
def _docker_mysql() -> str:
    """Levanta (o reutiliza) un contenedor mysql:8 desechable y devuelve su URL. Equivale a scripts/mysql_test_db.sh."""
    import time
    docker = shutil.which("docker")
    if not docker:
        pytest.skip("TEST_MYSQL_DOCKER=1 pero no hay `docker` en el PATH")
    name, port, pw = "clinica-mysql-test", int(os.environ.get("TEST_MYSQL_PORT", "33307")), "clinica_test_pw"
    run = lambda *a, **k: subprocess.run([docker, *a], capture_output=True, text=True, timeout=600, **k)
    info = run("ps", "-a", "--format", "{{.Names}}")
    if info.returncode != 0:
        pytest.skip(f"Docker no responde (Docker Desktop abierto?): {info.stderr.strip()[:200]}")
    if name in info.stdout.split():
        run("start", name)
    else:  # sin fsync ni binlog: es desechable y asi las pruebas van rapido
        r = run("run", "-d", "--name", name, "-e", f"MYSQL_ROOT_PASSWORD={pw}", "-e", "MYSQL_DATABASE=clinica_test",
                "-p", f"{port}:3306", "mysql:8", "--character-set-server=utf8mb4", "--collation-server=utf8mb4_0900_ai_ci",
                "--skip-log-bin", "--innodb-flush-log-at-trx-commit=0", "--innodb-doublewrite=OFF")
        assert r.returncode == 0, r.stderr
    for _ in range(90):
        if run("exec", name, "mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", f"-p{pw}", "--silent").returncode == 0:
            break
        time.sleep(2)
    else:
        pytest.fail("MySQL de pruebas no respondio a tiempo")
    return f"mysql+pymysql://root:{pw}@127.0.0.1:{port}/clinica_test?charset=utf8mb4"


@pytest.fixture(scope="session")
def mysql_url():
    url = os.environ.get("TEST_MYSQL_URL")
    if not url and os.environ.get("TEST_MYSQL_DOCKER") == "1":
        url = _docker_mysql()
    if not url:
        pytest.skip("MySQL no configurado: define TEST_MYSQL_URL o TEST_MYSQL_DOCKER=1 (ver scripts/mysql_test_db.sh)")
    # seguro: abajo se hace DROP de TODAS las tablas; solo bases cuyo nombre diga "test" (nunca una base con datos reales)
    dbname = make_url(url).database or ""
    if "test" not in dbname.lower():
        pytest.fail(f"Abortado: la base MySQL '{dbname}' no parece de pruebas (su nombre debe contener 'test'); la suite la VACIA.")
    # esquema limpio construido con las MIGRACIONES (asi tambien se prueba que crean lo mismo que los modelos)
    engine = create_engine(url)
    with engine.begin() as c:
        c.execute(text("SET FOREIGN_KEY_CHECKS=0"))
        for (t,) in c.execute(text("SHOW TABLES")).fetchall():
            c.execute(text(f"DROP TABLE `{t}`"))
        c.execute(text("SET FOREIGN_KEY_CHECKS=1"))
    engine.dispose()
    upgrade(url)
    return url


@pytest.fixture
def mysql_fresh(mysql_url):
    """MySQL vaciado y con el seed puesto."""
    engine = make_engine(mysql_url)
    from sqlalchemy.orm import Session
    with engine.begin() as c:
        for t in reversed(Base.metadata.sorted_tables):
            if c.execute(t.delete()).rowcount:
                # DELETE no reinicia el autoincremento de MySQL (en SQLite cada prueba parte de una copia limpia): sin esto
                # los ids de doctores/consultorios seguirian contando entre pruebas y dejarian de ser 1, 2, 3...
                c.execute(text(f"ALTER TABLE `{t.name}` AUTO_INCREMENT = 1"))
    with Session(engine) as s, s.begin():
        seed(s)
    engine.dispose()
    return mysql_url


# --------------------------------------------------------------------------- app
@pytest.fixture(params=BACKENDS)
def db_url(request, tmp_path):
    if request.param == "sqlite":
        dst = tmp_path / "clinica.db"
        shutil.copyfile(request.getfixturevalue("sqlite_template"), dst)
        return "sqlite:///" + dst.as_posix()
    return request.getfixturevalue("mysql_fresh")


@pytest.fixture
def make_app(db_url):
    """Fabrica de apps sobre la BD de la prueba; `clock` opcional para congelar el "ahora"."""
    apps = []

    # Con limite de conexiones por usuario (MAXCONN) el pool se reduce: `make_engine` permite hasta 2*pool_size conexiones.
    pool = max(1, MAXCONN // 2) if (MAXCONN and db_url.startswith("mysql")) else POOL

    def _make(clock=None, **extra):
        app = create_app({"DATABASE_URL": db_url, "TESTING": True, "POOL_SIZE": pool,
                          "BOT_TOKEN": TEST_BOT_TOKEN, "ZERNIO_WEBHOOK_SECRET": TEST_WEBHOOK_SECRET,
                          "PASSWORD_HASH_METHOD": "pbkdf2:sha256:1000", "AUTH_COOKIE_SECURE": False, **extra},
                         clock=clock)
        apps.append(app)
        return app

    yield _make
    for a in apps:
        a.extensions["db"].engine.dispose()


@pytest.fixture
def app(make_app):
    return make_app()


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def users(app):
    """Los 4 usuarios de prueba: {quien: (correo, contrasena, usuario)}."""
    return make_users(app)


@pytest.fixture
def login(app, users):
    """`login("staff")` -> `Session` con la cookie y el token CSRF de ese usuario."""
    return lambda who: Session(app, users[who][0])


@pytest.fixture
def agenda(app):
    return app.extensions["agenda"]


@pytest.fixture
def avail(app):
    return app.extensions["availability"]


@pytest.fixture
def db(app):
    """Fabrica de sesiones para mirar las tablas directamente: `with db() as s: s.scalars(...)`.
    (Siempre en un `with`: una sesion abierta es una transaccion abierta y retiene bloqueos.)"""
    return app.extensions["db"].session_factory


@pytest.fixture
def rooms(db):
    from sqlalchemy import select
    with db() as s:
        return list(s.scalars(select(Room).order_by(Room.position)))


@pytest.fixture
def clinic(agenda):
    """Horario de la clinica (`Schedule`), como `work_hours`/`all_slots` de scheduler.py."""
    with agenda._read() as repo:
        return repo.clinic_schedule()
