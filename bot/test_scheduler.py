import sys, os, itertools, threading
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from datetime import datetime, timedelta
import scheduler as S
from scheduler import Agenda, TZ, SLOT

_ids = itertools.count(1)


class Fake:
    def __init__(self):
        self.ev = {c: [] for c in S.CFG["consultorios"].values()}

    def list_events(self, cal, start, end, private=None):
        out = []
        for e in self.ev[cal]:
            if not S.overlaps(start, end, e["start"], e["end"]):
                continue
            if private and any(e["private"].get(k) != v for k, v in private.items()):
                continue
            out.append(dict(e))
        return out

    def insert(self, cal, body):
        n = next(_ids)
        e = {"id": f"e{n}", "summary": body["summary"], "start": S.parse_dt(body["start"]["dateTime"]),
             "end": S.parse_dt(body["end"]["dateTime"]), "private": body["extendedProperties"]["private"], "created": f"{n:06d}"}
        self.ev[cal].append(e)
        return {"id": e["id"], "created": e["created"]}

    def delete(self, cal, eid):
        self.ev[cal] = [e for e in self.ev[cal] if e["id"] != eid]

    def manual(self, cal, summary, start, end=None):
        n = next(_ids)
        self.ev[cal].append({"id": f"m{n}", "summary": summary, "start": start, "end": end or start + SLOT, "private": {}, "created": f"{n:06d}"})


def next_weekday(wd, hour, minute=0, weeks=1):
    d = S.now().date() + timedelta(days=7 * weeks)
    d += timedelta(days=(wd - d.weekday()) % 7)
    return datetime(d.year, d.month, d.day, hour, minute, tzinfo=TZ)


C1, C2 = list(S.CFG["consultorios"].values())
tests = []


def test(f):
    tests.append(f)
    return f


@test
def horarios_dentro_de_horario():
    a = Agenda(Fake())
    r = a.free_slots("proctologia", days=14, limit=40)
    assert r["horarios"], r
    for h in r["horarios"]:
        dt = S.parse_dt(h)
        assert dt.weekday() != 6
        assert dt.hour >= 9 and (dt + SLOT).time() <= (S.work_hours(dt.date())[1])


@test
def sinonimos_y_typos():
    assert S.find_doctor("proctogia")[1]["name"].startswith("Dr. Cervantes")
    assert S.find_doctor("Ginecólogo")[1]["name"].startswith("Dr. Pérez")
    assert S.find_doctor("otorrino")[1]["label"] == "Otorrinolaringología"
    assert S.find_doctor("cardiologia") is None


@test
def dos_citas_misma_hora_usan_consultorios_distintos_y_la_tercera_falla():
    a = Agenda(Fake()); t = next_weekday(1, 10)
    r1 = a.book("5211", "Ana Lopez", "proctologia", t)
    r2 = a.book("5212", "Beto Ruiz", "ginecologia", t)
    r3 = a.book("5213", "Carla Diaz", "reumatologia", t)
    assert r1["ok"] and r2["ok"] and {r1["consultorio"], r2["consultorio"]} == {"Consultorio 1", "Consultorio 2"}
    assert r3["error"] == "horario_ocupado"


@test
def mismo_doctor_no_puede_estar_en_dos_consultorios():
    a = Agenda(Fake()); t = next_weekday(2, 11)
    assert a.book("5211", "Ana Lopez", "proctologia", t)["ok"]
    assert a.book("5212", "Beto Ruiz", "proctologia", t)["error"] == "horario_ocupado"


@test
def evento_manual_del_equipo_bloquea_consultorio_y_doctor():
    f = Fake(); a = Agenda(f); t = next_weekday(3, 12)
    f.manual(C1, "Cita Dr. Molina - Juan", t)
    f.manual(C2, "Junta", t)
    assert a.book("5211", "Ana Lopez", "ginecologia", t)["error"] == "horario_ocupado"  # ambos consultorios ocupados
    t2 = t + SLOT
    f.manual(C2, "Consulta con Molina", t2)
    assert a.book("5212", "Beto Ruiz", "otorrino", t2)["error"] == "horario_ocupado"  # doctor ocupado por evento manual
    assert a.book("5212", "Beto Ruiz", "ginecologia", t2)["ok"]


@test
def evento_dia_completo_bloquea_el_dia():
    f = Fake(); a = Agenda(f); d = next_weekday(1, 9)
    for c in (C1, C2):
        f.manual(c, "Dia festivo", d.replace(hour=0), d.replace(hour=0) + timedelta(days=1))
    assert a.book("5211", "Ana Lopez", "proctologia", d.replace(hour=10))["error"] == "horario_ocupado"
    assert all(S.parse_dt(h).date() != d.date() for h in a.free_slots("proctologia", days=10, limit=40)["horarios"])


@test
def valida_horario_pasado_domingo_y_fuera_de_horario():
    a = Agenda(Fake())
    assert a.book("5211", "Ana Lopez", "proctologia", S.now() - timedelta(hours=3))["error"] == "horario_pasado_o_muy_cercano"
    dom = next_weekday(6, 10)
    assert a.book("5211", "Ana Lopez", "proctologia", dom)["error"] == "fuera_de_horario"
    assert a.book("5211", "Ana Lopez", "proctologia", next_weekday(1, 18))["error"] == "fuera_de_horario"
    assert a.book("5211", "Ana Lopez", "proctologia", next_weekday(5, 12, 30))["ok"]  # ultimo hueco del sabado 12:30-13:00
    assert a.book("5211", "Ana Lopez", "proctologia", next_weekday(5, 13))["error"] == "fuera_de_horario"
    assert a.book("5211", "Ana Lopez", "proctologia", next_weekday(1, 10, 15))["error"] == "fuera_de_horario"  # no alineado a 30 min
    assert a.book("5211", "Ana Lopez", "proctologia", S.now() + timedelta(days=90))["error"] == "fuera_de_rango"


@test
def exige_nombre_completo_y_especialidad_valida():
    a = Agenda(Fake()); t = next_weekday(1, 10)
    assert a.book("5211", "Ana", "proctologia", t)["error"] == "falta_nombre_completo"
    assert a.book("5211", "Ana Lopez", "cardiologia", t)["error"] == "especialidad_no_encontrada"


@test
def privacidad_entre_pacientes():
    a = Agenda(Fake()); t = next_weekday(1, 10)
    r = a.book("5211", "Ana Lopez", "proctologia", t)
    assert [m["event_id"] for m in a.mine("5211")] == [r["event_id"]]
    assert a.mine("5299") == []
    assert a.cancel("5299", r["event_id"])["error"] == "cita_no_encontrada"
    assert a.reschedule("5299", r["event_id"], t + SLOT)["error"] == "cita_no_encontrada"
    assert len(a.mine("5211")) == 1


@test
def cancelar_libera_el_hueco():
    a = Agenda(Fake()); t = next_weekday(1, 10)
    r = a.book("5211", "Ana Lopez", "proctologia", t)
    assert a.cancel("5211", r["event_id"])["ok"]
    assert a.mine("5211") == []
    assert a.book("5212", "Beto Ruiz", "proctologia", t)["ok"]


@test
def reprogramar_mueve_y_no_se_bloquea_a_si_misma():
    a = Agenda(Fake()); t = next_weekday(1, 10)
    r = a.book("5211", "Ana Lopez", "proctologia", t)
    r2 = a.reschedule("5211", r["event_id"], t + SLOT)
    assert r2["ok"] and r2["reprogramada_desde"] == S.iso(t)
    m = a.mine("5211")
    assert len(m) == 1 and m[0]["inicio"] == S.iso(t + SLOT)
    # reprogramar a hueco ocupado: la cita original se conserva
    a.book("5212", "Beto Ruiz", "proctologia", t + 2 * SLOT)
    assert a.reschedule("5211", m[0]["event_id"], t + 2 * SLOT)["error"] == "horario_ocupado"
    assert len(a.mine("5211")) == 1 and a.mine("5211")[0]["inicio"] == S.iso(t + SLOT)


@test
def concurrencia_nunca_sobrepasa_dos_citas_por_hora():
    f = Fake(); a = Agenda(f); t = next_weekday(1, 15)
    specs = ["proctologia", "ginecologia", "reumatologia", "ultrasonidos", "otorrino", "anestesia", "ortopedia"]
    res = []
    th = [threading.Thread(target=lambda i=i: res.append(a.book(f"52{i}", f"Paciente Numero{i}", specs[i], t))) for i in range(7)]
    [x.start() for x in th]; [x.join() for x in th]
    assert sum(1 for r in res if r.get("ok")) == 2, res


@test
def ofrece_solo_horarios_realmente_libres():
    f = Fake(); a = Agenda(f)
    first = a.free_slots("proctologia", days=7, limit=1)["horarios"][0]
    t = S.parse_dt(first)
    f.manual(C1, "x", t); f.manual(C2, "y", t)
    assert first not in a.free_slots("proctologia", days=7, limit=40)["horarios"]


@test
def paciente_llamada_ana_no_bloquea_a_la_reumatologa():
    f = Fake(); a = Agenda(f); t = next_weekday(2, 16)
    f.manual(C1, "Cita Ana Lopez (chequeo)", t)   # menciona "Ana" pero no a la doctora
    f.manual(C2, "Cita Mariana Ruiz", t)
    # ambos consultorios ocupados -> sin consultorio; liberamos uno y debe poder agendar reumatologia
    f.ev[C2].clear()
    assert a.book("5211", "Beto Ruiz", "reumatologia", t)["ok"]
    t2 = t + SLOT
    f.manual(C1, "Consulta Dra. Arguelles - Juan", t2)  # evento manual que SI nombra a la doctora
    assert a.book("5212", "Carla Diaz", "reumatologia", t2)["error"] == "horario_ocupado"
    assert a.book("5212", "Carla Diaz", "ginecologia", t2)["ok"]


@test
def filtro_de_horas_ofrece_la_tarde():
    a = Agenda(Fake())
    r = a.free_slots("proctologia", days=7, limit=6, hora_min=12)
    assert r["horarios"] and all(S.parse_dt(h).hour >= 12 for h in r["horarios"]), r
    r = a.free_slots("proctologia", days=7, limit=6, hora_max=10)
    assert r["horarios"] and all(S.parse_dt(h).hour < 10 for h in r["horarios"]), r
    r = a.free_slots("proctologia", days=7, limit=6, hora_min=20)
    assert r["horarios"] == [] and "nota" in r


@test
def reparto_variado_de_horas_y_sin_duplicados():
    a = Agenda(Fake())
    r = a.free_slots("proctologia", days=7, limit=6)["horarios"]
    assert len(r) == 6 and len(set(r)) == 6, r
    horas = {S.parse_dt(h).hour for h in r}
    assert len(horas) >= 3, ("poca variedad de horas", r)
    assert len({S.parse_dt(h).date() for h in r}) <= 3
    tarde = a.free_slots("proctologia", days=7, limit=6, hora_min=12)["horarios"]
    assert tarde and all(S.parse_dt(h).hour >= 12 for h in tarde) and len({S.parse_dt(h).hour for h in tarde}) >= 2, tarde


@test
def reglas_de_tiempo_60_dias_y_1_hora():
    assert S.CFG["horizon_days"] == 60 and S.CFG["min_notice_minutes"] == 60
    a = Agenda(Fake())
    # hueco valido dentro de horario pero con menos de 1 hora de antelacion
    base = S.now() + timedelta(minutes=40)
    s30 = next(s for s in S.all_slots(base.date()) if s >= S.now() and s < S.now() + timedelta(minutes=59)) if any(
        S.now() <= s < S.now() + timedelta(minutes=59) for s in S.all_slots(base.date())) else None
    if s30:
        assert a.book("5211", "Ana Lopez", "proctologia", s30)["error"] == "horario_pasado_o_muy_cercano"
    # 59 dias: permitido; 61 dias: rechazado
    d59 = next_weekday(1, 10, weeks=0)  # se ajusta abajo
    d = S.now().date() + timedelta(days=59)
    while S.work_hours(d) is None: d -= timedelta(days=1)
    ok = datetime.combine(d, S.work_hours(d)[0], TZ)
    assert a.book("5211", "Ana Lopez", "proctologia", ok)["ok"], "59 dias debe poder"
    d = S.now().date() + timedelta(days=62)
    while S.work_hours(d) is None: d += timedelta(days=1)
    assert a.book("5212", "Beto Ruiz", "proctologia", datetime.combine(d, S.work_hours(d)[0], TZ))["error"] == "fuera_de_rango"
    # las listas nunca devuelven mas alla de 60 dias ni antes de 1 hora
    for h in a.free_slots("proctologia", days=90, limit=500)["horarios"]:
        dt = S.parse_dt(h); assert S.now() + timedelta(minutes=59) < dt <= S.now() + timedelta(days=60)
    # reprogramar tambien respeta el limite
    r = a.book("5213", "Carla Diaz", "ginecologia", next_weekday(1, 10))
    assert a.reschedule("5213", r["event_id"], datetime.combine(d, S.work_hours(d)[0], TZ))["error"] == "fuera_de_rango"
    assert len(a.mine("5213")) == 1


@test
def cercanos_horario_libre_es_exacto():
    a = Agenda(Fake()); t = next_weekday(3, 16)
    r = a.nearest("proctologia", t)
    assert r["exacto"] is True and S.iso(t) in r["horarios"] and len(r["horarios"]) == 3, r


@test
def cercanos_ocupado_propone_los_mas_proximos():
    f = Fake(); a = Agenda(f); t = next_weekday(3, 16)
    f.manual(C1, "x", t); f.manual(C2, "y", t)          # sin consultorio a las 16:00
    r = a.nearest("proctologia", t)
    assert r["exacto"] is False and S.iso(t) not in r["horarios"], r
    got = sorted(abs((S.parse_dt(h) - t).total_seconds()) for h in r["horarios"])
    assert got == [1800, 1800, 3600], got               # 15:30, 16:30 y 15:00/17:00


@test
def cercanos_dia_lleno_salta_a_dias_vecinos():
    f = Fake(); a = Agenda(f); t = next_weekday(3, 12)
    for c in (C1, C2):
        f.manual(c, "lleno", datetime(t.year, t.month, t.day, 0, tzinfo=TZ), datetime(t.year, t.month, t.day, 0, tzinfo=TZ) + timedelta(days=1))
    r = a.nearest("proctologia", t)
    assert r["horarios"] and all(S.parse_dt(h).date() != t.date() for h in r["horarios"]), r


@test
def cercanos_domingo_y_fuera_de_horario_dan_el_mas_cercano_valido():
    a = Agenda(Fake()); dom = next_weekday(6, 11)
    r = a.nearest("proctologia", dom)
    assert r["exacto"] is False and r["horarios"] and all(S.parse_dt(h).weekday() != 6 for h in r["horarios"]), r
    noche = next_weekday(2, 21)
    r = a.nearest("proctologia", noche)
    assert all(S.parse_dt(h).hour <= 17 or S.parse_dt(h).date() != noche.date() for h in r["horarios"]) and r["horarios"][0] , r


@test
def cercanos_respeta_limites_y_pasado():
    a = Agenda(Fake())
    r = a.nearest("proctologia", S.now() + timedelta(days=90))
    assert r["error"] == "fuera_de_rango" and r["horarios"] == []
    r = a.nearest("proctologia", S.now() - timedelta(days=3))
    assert r["horarios"] and "nota" in r and all(S.parse_dt(h) > S.now() + timedelta(minutes=59) for h in r["horarios"]), r
    assert a.nearest("cardiologia", next_weekday(1, 10))["error"] == "especialidad_no_encontrada"


@test
def cercanos_ocupado_por_doctor_ocupado_en_otro_consultorio():
    f = Fake(); a = Agenda(f); t = next_weekday(3, 10)
    a.book("5211", "Ana Lopez", "proctologia", t)       # el doctor ya esta ocupado a esa hora
    r = a.nearest("proctologia", t)
    assert r["exacto"] is False and S.iso(t) not in r["horarios"], r


if __name__ == "__main__":
    bad = 0
    for t in tests:
        try:
            t(); print("OK  ", t.__name__)
        except Exception as e:
            bad += 1; print("FAIL", t.__name__, "->", repr(e)[:300])
    print(f"\n{len(tests) - bad}/{len(tests)} pruebas pasaron")
    sys.exit(1 if bad else 0)
