"""Concurrencia real: muchos hilos / procesos a la misma hora. La BD (UNIQUE de `appointment_blocks`) decide.

Corre contra SQLite (archivo, escrituras en serie con BEGIN IMMEDIATE) y contra MySQL 8 si esta configurado
(ver conftest.py): ahi es la prueba que de verdad importa (InnoDB, varias conexiones, interbloqueos).
"""
import multiprocessing as mp
import threading
import time
from datetime import timedelta

from sqlalchemy import func, select

from app import create_app
from app.agenda import iso, parse_dt
from app.models import Appointment, AppointmentBlock
from helpers import MAXCONN, check_integrity, next_weekday

SPECS = ["proctologia", "ginecologia", "reumatologia", "ultrasonidos", "otorrino", "anestesia", "ortopedia"]


def run_together(n, fn):
    """Lanza `n` hilos a la vez (barrera) y devuelve sus resultados; si alguno revienta, la prueba falla."""
    barrier, out, boom = threading.Barrier(n), [None] * n, []

    def worker(i):
        try:
            barrier.wait(timeout=30)
            out[i] = fn(i)
        except BaseException as e:  # noqa: BLE001
            boom.append(e)
    th = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    [t.start() for t in th]
    [t.join(timeout=120) for t in th]
    assert not boom, boom
    return out


def count(db, model):
    with db() as s:
        return s.scalar(select(func.count()).select_from(model))


def test_20_reservas_simultaneas_a_la_misma_hora_dan_exactamente_2(agenda, db):
    t = next_weekday(agenda, 1, 15)
    res = run_together(20, lambda i: agenda.book(f"52199900{i:02d}", f"Paciente Numero{i}", SPECS[i % 7], t))
    oks = [r for r in res if r.get("ok")]
    assert len(oks) == 2, res
    assert {r["consultorio"] for r in oks} == {"Consultorio 1", "Consultorio 2"}
    assert len({r["doctor"] for r in oks}) == 2
    assert all(r["error"] == "horario_ocupado" for r in res if not r.get("ok")), res
    assert count(db, AppointmentBlock) == 2 and count(db, Appointment) == 2   # los perdedores no dejaron rastro
    check_integrity(agenda._sf)
    assert agenda.retries == 0, "la carrera normal no debe depender de reintentos por interbloqueo"


def test_mismo_doctor_a_la_misma_hora_solo_una_reserva(agenda, db):
    t = next_weekday(agenda, 2, 11)
    res = run_together(12, lambda i: agenda.book(f"52199900{i:02d}", f"Paciente Numero{i}", "proctologia", t))
    assert sum(1 for r in res if r.get("ok")) == 1, res
    assert all(r["error"] == "horario_ocupado" for r in res if not r.get("ok"))
    assert count(db, AppointmentBlock) == 1
    check_integrity(agenda._sf)
    assert agenda.retries == 0


def test_reservas_a_horas_distintas_no_se_estorban(agenda, db):
    base = next_weekday(agenda, 3, 9)
    res = run_together(14, lambda i: agenda.book(f"52199900{i:02d}", f"Paciente Numero{i}", SPECS[i % 7],
                                                   base + timedelta(minutes=30 * (i // 2))))
    assert all(r.get("ok") for r in res), res            # 2 por hora, 7 horas distintas: todas caben
    assert count(db, AppointmentBlock) == 14
    check_integrity(agenda._sf)


def test_reprogramaciones_simultaneas_al_mismo_hueco(agenda):
    """7 pacientes (7 doctores) quieren el mismo hueco libre: caben 2; los demas conservan su cita original."""
    t_old = next_weekday(agenda, 1, 9)
    t_new = next_weekday(agenda, 2, 16)
    booked = [agenda.book(f"52199900{i:02d}", f"Paciente Numero{i}", SPECS[i], t_old + timedelta(minutes=30 * i))
              for i in range(7)]
    assert all(b["ok"] for b in booked)
    res = run_together(7, lambda i: agenda.reschedule(f"52199900{i:02d}", booked[i]["cita_id"], t_new))
    assert sum(1 for r in res if r.get("ok")) == 2, res
    assert all(r["error"] == "horario_ocupado" for r in res if not r.get("ok"))
    for i, r in enumerate(res):
        (m,) = agenda.mine(f"52199900{i:02d}")
        assert m["cita_id"] == booked[i]["cita_id"]                                 # ninguna se perdio ni se duplico
        assert m["inicio"] == (iso(t_new) if r.get("ok") else booked[i]["inicio"])
    check_integrity(agenda._sf)


def test_reservar_y_cancelar_a_la_vez(agenda, db):
    """Dos citas llenan los consultorios; una se cancela mientras otros 8 intentan entrar a ese hueco."""
    t = next_weekday(agenda, 4, 10)
    a = agenda.book("5210000001", "Primera Paciente", "proctologia", t)
    b = agenda.book("5210000002", "Segunda Paciente", "ginecologia", t)
    assert a["ok"] and b["ok"]

    def job(i):
        if i == 0:
            return agenda.cancel("5210000001", a["cita_id"])
        return agenda.book(f"52199900{i:02d}", f"Paciente Numero{i}", SPECS[2 + i % 5], t)
    res = run_together(9, job)
    assert res[0]["ok"]
    assert sum(1 for r in res[1:] if r.get("ok")) <= 1          # a lo sumo uno entra al hueco liberado
    assert agenda.mine("5210000002")                               # la otra cita sigue ahi
    with db() as s:
        assert s.scalar(select(func.count()).select_from(AppointmentBlock)) <= 2
    check_integrity(agenda._sf)


# ------------------------------------------------------------------ procesos distintos (cada uno con su app y su pool)
def _proceso(url, phone, spec, inicio, t0, q):
    app = create_app({"DATABASE_URL": url, "TESTING": True})
    ag = app.extensions["agenda"]
    while time.time() < t0:
        time.sleep(0.005)
    q.put(ag.book(phone, f"Paciente Proceso{phone[-2:]}", spec, parse_dt(inicio)))
    app.extensions["db"].engine.dispose()


def test_varios_procesos_a_la_misma_hora_dan_exactamente_2(app, agenda, db, db_url):
    """Sin memoria compartida (adios `threading.Lock`): 6 procesos del SO compiten por el mismo hueco.
    Con limite de conexiones por usuario (MAXCONN, p. ej. 3 en PythonAnywhere gratis) corren min(6, MAXCONN) procesos,
    minimo 3 (con 2 no habria perdedor), y pytest suelta sus conexiones antes: cada proceso usa 1."""
    t = next_weekday(agenda, 1, 17)
    n = 6
    if MAXCONN and db_url.startswith("mysql"):
        n = max(3, min(6, MAXCONN))
        app.extensions["db"].engine.dispose()
    ctx = mp.get_context("spawn")
    q = ctx.Queue()
    t0 = time.time() + 6          # tiempo para que cada proceso importe la app antes de disparar
    procs = [ctx.Process(target=_proceso, args=(db_url, f"52199900{i:02d}", SPECS[i], iso(t), t0, q)) for i in range(n)]
    [p.start() for p in procs]
    res = [q.get(timeout=120) for _ in procs]
    [p.join(timeout=60) for p in procs]
    assert all(p.exitcode == 0 for p in procs)
    assert sum(1 for r in res if r.get("ok")) == 2, res
    assert all(r["error"] == "horario_ocupado" for r in res if not r.get("ok")), res
    assert count(db, AppointmentBlock) == 2
    check_integrity(agenda._sf)
