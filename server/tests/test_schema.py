"""Esquema (migraciones vs modelos), seed, app factory, CLI y ajustes."""
import re
from datetime import time
from pathlib import Path

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import CheckConstraint, create_engine, func, inspect, select

from app import create_app
from app.config import load_config
from app.migrate import downgrade, upgrade
from app.models import AuditLog, Base, ClinicHours, Doctor, Room, Setting
from app.seed import load_agenda_config, seed
from app.settings import get_bot_settings, set_bot_active

TABLAS = {"users", "doctors", "rooms", "clinic_hours", "doctor_hours", "doctor_absences", "appointments",
          "appointment_blocks", "settings", "webhook_events", "audit_log", "attention_cases", "sessions", "schedule_change_requests", "push_subscriptions"}


def diff_with_models(url):
    engine = create_engine(url)
    try:
        with engine.connect() as c:
            ctx = MigrationContext.configure(c, opts={"compare_type": True})
            return compare_metadata(ctx, Base.metadata)
    finally:
        engine.dispose()


# ------------------------------------------------------------------ migraciones
def test_migracion_corre_en_limpio_y_coincide_con_los_modelos(tmp_path):
    url = "sqlite:///" + (tmp_path / "limpia.db").as_posix()
    upgrade(url)
    engine = create_engine(url)
    assert TABLAS <= set(inspect(engine).get_table_names())
    engine.dispose()
    assert diff_with_models(url) == []
    downgrade(url)                         # y vuelve a base sin dejar tablas
    engine = create_engine(url)
    assert set(inspect(engine).get_table_names()) == {"alembic_version"}
    engine.dispose()
    upgrade(url)                           # sube otra vez
    assert diff_with_models(url) == []


def test_migracion_0004_agrega_el_color_del_doctor_sin_tocar_los_datos_y_se_deshace(tmp_path):
    """Una base que ya tenia doctores (en 0003) sube a 0004 con `color` NULL (automatico) y todo lo demas intacto."""
    from sqlalchemy import text
    url = "sqlite:///" + (tmp_path / "vieja.db").as_posix()
    upgrade(url, "0003")
    engine = create_engine(url)
    assert "color" not in {c["name"] for c in inspect(engine).get_columns("doctors")}
    with engine.begin() as c:
        c.execute(text("INSERT INTO doctors (name, specialty, aliases, active, uses_clinic_hours, created_at) "
                       "VALUES ('Dr. Existente', 'Proctologia', '[\"colon\"]', 1, 1, '2026-11-10 10:00:00')"))
    engine.dispose()

    upgrade(url)
    engine = create_engine(url)
    cols = {c["name"]: c for c in inspect(engine).get_columns("doctors")}
    assert "color" in cols and cols["color"]["nullable"] is True
    with engine.connect() as c:
        row = c.execute(text("SELECT name, specialty, active, color FROM doctors")).one()
    engine.dispose()
    assert tuple(row) == ("Dr. Existente", "Proctologia", 1, None)
    assert diff_with_models(url) == []

    downgrade(url, "0003")                  # volver atras quita la columna y conserva al doctor
    engine = create_engine(url)
    assert "color" not in {c["name"] for c in inspect(engine).get_columns("doctors")}
    with engine.connect() as c:
        assert c.execute(text("SELECT name FROM doctors")).scalar_one() == "Dr. Existente"
    engine.dispose()


@pytest.mark.mysql
def test_migracion_en_mysql_coincide_con_los_modelos(mysql_url):
    assert diff_with_models(mysql_url) == []
    engine = create_engine(mysql_url)
    insp = inspect(engine)
    uniques = {u["name"]: u["column_names"] for u in insp.get_unique_constraints("appointment_blocks")}
    assert uniques == {"uq_block_doctor_slot": ["doctor_id", "slot_start"], "uq_block_room_slot": ["room_id", "slot_start"]}
    with engine.connect() as c:
        from sqlalchemy import text
        tablas = c.execute(text("SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES "
                                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> 'alembic_version'")).all()
    dialecto = engine.dialect.name
    engine.dispose()
    # Las tablas deben ser utf8mb4 AUNQUE la base nazca en utf8mb3 (la que crea la pestana Databases de PythonAnywhere):
    # el juego de caracteres por defecto de la BASE no lo controla el codigo, el de las TABLAS si (lo fija la migracion).
    assert dialecto == "mysql" and len(tablas) >= len(TABLAS), tablas
    assert [t for t, col in tablas if not str(col).startswith("utf8mb4")] == [], tablas


def test_el_unique_de_huecos_esta_en_el_modelo():
    t = Base.metadata.tables["appointment_blocks"]
    cols = {frozenset(c.name for c in u.columns) for u in t.constraints if u.__class__.__name__ == "UniqueConstraint"}
    assert cols == {frozenset({"doctor_id", "slot_start"}), frozenset({"room_id", "slot_start"})}


# ------------------------------------------------------------------ seed
def test_seed_deja_7_doctores_2_consultorios_y_el_horario(db):
    with db() as s:
        doctors = list(s.scalars(select(Doctor).order_by(Doctor.id)))
        rooms = list(s.scalars(select(Room).order_by(Room.position)))
        hours = {h.weekday: (h.start_time, h.end_time) for h in s.scalars(select(ClinicHours))}
        bot = s.get(Setting, "bot_active")
    assert [d.name for d in doctors] == ["Dr. Cervantes Peláez", "Dr. Pérez Lago", "Dra. Bordas Rodríguez",
                                         "Dr. Gustavo Torrealba", "Dr. Molina López", "Dra. Geydi",
                                         "Dra. Ana del Carmen Argüelles"]
    assert [d.specialty for d in doctors] == ["Proctología", "Ginecología", "Ortopedia y Traumatología", "Ultrasonidos",
                                              "Otorrinolaringología", "Anestesiología", "Reumatología"]
    assert all(d.active and d.uses_clinic_hours for d in doctors)
    assert doctors[3].aliases == ["ultrasonido", "usg", "ecografia"] and doctors[0].aliases == ["proctologo", "proctogia"]
    assert [r.name for r in rooms] == ["Consultorio 1", "Consultorio 2"]
    assert hours == {**{wd: (time(9, 0), time(18, 0)) for wd in range(5)}, 5: (time(9, 0), time(13, 0))}   # L-V 9-18, sab 9-13
    assert bot is not None and bot.value is False          # el bot nace APAGADO


def test_seed_es_idempotente_y_respeta_las_ediciones(app, db):
    cfg = load_agenda_config()
    with db() as s, s.begin():
        assert seed(s, cfg) == {"rooms": 0, "doctors": 0, "clinic_hours": 0, "settings": 0}
    app.extensions["availability"].set_clinic_hours({"mon": [{"start": "10:00", "end": "12:00"}]})
    with db() as s, s.begin():
        s.get(Setting, "bot_active").value = True
        seed(s, cfg)                                       # no pisa ni el horario editado ni el interruptor
    with db() as s:
        assert s.scalar(select(func.count()).select_from(ClinicHours)) == 1
        assert s.scalar(select(func.count()).select_from(Doctor)) == 7
        assert s.get(Setting, "bot_active").value is True


def test_seed_coincide_con_agenda_config_del_bot(db):
    cfg = load_agenda_config()
    with db() as s:
        by_name = {d.name: d for d in s.scalars(select(Doctor))}
    assert len(cfg["doctors"]) == 7 == len(by_name)
    for d in cfg["doctors"].values():
        assert by_name[d["name"]].specialty == d["label"] and by_name[d["name"]].aliases == d.get("aliases", [])


# ------------------------------------------------------------------ CLI de punta a punta
def test_cli_upgrade_db_y_seed_en_una_bd_vacia(tmp_path):
    url = "sqlite:///" + (tmp_path / "nueva.db").as_posix()
    app = create_app({"DATABASE_URL": url})
    try:
        runner = app.test_cli_runner()
        r = runner.invoke(args=["upgrade-db"])
        assert r.exit_code == 0, r.output
        r = runner.invoke(args=["seed"])
        assert r.exit_code == 0 and "doctors=7" in r.output and "rooms=2" in r.output and "clinic_hours=6" in r.output, r.output
        r = runner.invoke(args=["seed"])
        assert r.exit_code == 0 and "doctors=0" in r.output and "rooms=0" in r.output, r.output
        with app.extensions["db"].session_factory() as s:
            assert s.scalar(select(func.count()).select_from(Doctor)) == 7
            assert s.scalar(select(func.count()).select_from(Room)) == 2
        # y el motor funciona sobre esa BD recien migrada y sembrada
        ag = app.extensions["agenda"]
        assert ag.free_slots("proctologia")["horarios"]
    finally:
        app.extensions["db"].engine.dispose()


# ------------------------------------------------------------------ app factory
def test_health(app):
    r = app.test_client().get("/api/health")
    assert r.status_code == 200 and r.get_json() == {"status": "ok"}


def test_config_por_entorno_y_prioridades(tmp_path):
    cfg = load_config(environ={})
    assert cfg["TIMEZONE"] == "America/Cancun" and cfg["MIN_NOTICE_MINUTES"] == 60 and cfg["HORIZON_DAYS"] == 60
    assert cfg["DATABASE_URL"].startswith("sqlite:///")
    env = {"DATABASE_URL": "mysql+pymysql://u:p@h/db?charset=utf8mb4", "HORIZON_DAYS": "30", "TIMEZONE": "America/Mexico_City"}
    cfg = load_config(environ=env)
    assert cfg["DATABASE_URL"].startswith("mysql+pymysql://") and cfg["HORIZON_DAYS"] == 30
    assert load_config({"HORIZON_DAYS": 10}, environ=env)["HORIZON_DAYS"] == 10      # el diccionario manda sobre el entorno
    app = create_app({"DATABASE_URL": "sqlite:///" + (tmp_path / "c.db").as_posix(), "HORIZON_DAYS": 45, "MIN_NOTICE_MINUTES": 90})
    try:
        rules = app.extensions["rules"]
        assert rules.horizon_days == 45 and rules.min_notice_minutes == 90 and str(rules.tz) == "America/Cancun"
        assert app.extensions["agenda"].rules is rules
    finally:
        app.extensions["db"].engine.dispose()


# ------------------------------------------------------------------ interruptor del bot
def test_interruptor_del_bot(db):
    with db() as s:
        st = get_bot_settings(s)
        assert st.active is False and st.updated_by is None
    with db() as s, s.begin():
        on = set_bot_active(s, True)
        assert on.active is True and on.updated_at is not None
    with db() as s:
        assert get_bot_settings(s).active is True
    with db() as s, s.begin():
        assert set_bot_active(s, False).active is False
    with db() as s:
        assert get_bot_settings(s).active is False
        acts = [(a.action, a.data) for a in s.scalars(select(AuditLog).order_by(AuditLog.id))]
    assert acts == [("bot.set_active", {"active": True}), ("bot.set_active", {"active": False})]


def test_los_check_no_usan_funciones_matematicas_de_sqlite():
    """Regresion hallada en PythonAnywhere (Python 3.10): `MOD()` existe en MySQL y en el SQLite de Windows, pero NO en el
    SQLite de esa cuenta (sin funciones matematicas) -> `no such function: MOD` al crear las tablas. Usar `%` y operadores."""
    prohibidas = re.compile(r"\b(MOD|CEIL|CEILING|FLOOR|POWER|POW|SQRT|LOG|LN|EXP|ROUND_HALF)\s*\(", re.I)
    textos = [(t.name, str(c.sqltext)) for t in Base.metadata.tables.values()
              for c in t.constraints if isinstance(c, CheckConstraint)]
    assert textos, "esperaba al menos un CHECK en el modelo"
    malos = [(t, s) for t, s in textos if prohibidas.search(s)]
    assert not malos, f"CHECK con funciones que SQLite puede no tener: {malos}"
    migracion = (Path(__file__).resolve().parents[1] / "migrations" / "versions" / "0001_esquema_inicial.py").read_text(encoding="utf-8")
    assert not prohibidas.search(migracion)


def test_nombre_de_paciente_con_emoji_se_guarda_tal_cual(agenda, db):
    """WhatsApp trae emojis en los nombres. Si la tabla fuera utf8mb3 (por defecto en la base de PythonAnywhere) MySQL
    rechazaria el INSERT ('Incorrect string value') y la reserva fallaria."""
    from app.models import Appointment
    from helpers import next_weekday
    nombre = "María López 😀"
    r = agenda.book("5219991234567", nombre, "proctologia", next_weekday(agenda, 1, 10))
    assert r["ok"], r
    with db() as s:
        assert s.scalars(select(Appointment.patient_name)).one() == nombre
