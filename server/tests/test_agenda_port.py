"""Las 23 pruebas de `bot/test_scheduler.py` portadas al motor SQL (misma intencion, mismos nombres).

Cambios respecto al original, todos por el cambio de fuente de datos:
  - `event_id` -> `cita_id`; el backend `Fake` -> la BD (SQLite y, si esta, MySQL).
  - Las 3 que dependian de eventos de Google (evento manual por apellido, dia completo, "paciente Ana vs Dra. Ana")
    se reescriben con bloqueos de consultorio, citas manuales del personal y ausencias.
Las fechas se calculan con el reloj de la agenda (no hay fechas fijas), igual que el original.
"""
import threading
from datetime import datetime, timedelta

from app.agenda import iso, parse_dt
from helpers import next_weekday, room_block


def test_horarios_dentro_de_horario(agenda, clinic):
    r = agenda.free_slots("proctologia", days=14, limit=40)
    assert r["horarios"], r
    for h in r["horarios"]:
        dt = parse_dt(h)
        assert dt.weekday() != 6
        assert dt.hour >= 9 and (dt + agenda.rules.slot).time() <= clinic.work_hours(dt.date())[1]


def test_sinonimos_y_typos(agenda):
    assert agenda.find_doctor("proctogia").name.startswith("Dr. Cervantes")
    assert agenda.find_doctor("Ginecólogo").name.startswith("Dr. Pérez")
    assert agenda.find_doctor("otorrino").specialty == "Otorrinolaringología"
    assert agenda.find_doctor("cardiologia") is None


def test_dos_citas_misma_hora_usan_consultorios_distintos_y_la_tercera_falla(agenda):
    t = next_weekday(agenda, 1, 10)
    r1 = agenda.book("5211", "Ana Lopez", "proctologia", t)
    r2 = agenda.book("5212", "Beto Ruiz", "ginecologia", t)
    r3 = agenda.book("5213", "Carla Diaz", "reumatologia", t)
    assert r1["ok"] and r2["ok"] and {r1["consultorio"], r2["consultorio"]} == {"Consultorio 1", "Consultorio 2"}
    assert r3["error"] == "horario_ocupado"


def test_mismo_doctor_no_puede_estar_en_dos_consultorios(agenda):
    t = next_weekday(agenda, 2, 11)
    assert agenda.book("5211", "Ana Lopez", "proctologia", t)["ok"]
    assert agenda.book("5212", "Beto Ruiz", "proctologia", t)["error"] == "horario_ocupado"


def test_bloqueo_manual_ocupa_consultorio_y_cita_manual_del_personal_ocupa_doctor(agenda, rooms):
    """Reemplaza `evento_manual_del_equipo_bloquea_consultorio_y_doctor` (ya no hay eventos con apellido en el titulo)."""
    t = next_weekday(agenda, 3, 12)
    room_block(agenda, rooms[0], t, notes="Cita Dr. Molina - Juan")
    room_block(agenda, rooms[1], t, notes="Junta")
    assert agenda.book("5211", "Ana Lopez", "ginecologia", t)["error"] == "horario_ocupado"  # ambos consultorios bloqueados
    t2 = t + agenda.rules.slot
    molina = agenda.find_doctor("otorrino")
    agenda.create_booking(start=t2, doctor_id=molina.id, room_id=rooms[1].id, patient_name="Juan Perez", phone="5219")
    assert agenda.book("5212", "Beto Ruiz", "otorrino", t2)["error"] == "horario_ocupado"  # doctor ocupado (cita manual)
    assert agenda.book("5212", "Beto Ruiz", "ginecologia", t2)["ok"]  # otro doctor, consultorio 1 libre


def test_bloqueo_de_dia_completo_bloquea_el_dia(agenda, rooms):
    """Reemplaza `evento_dia_completo_bloquea_el_dia`: un bloqueo en cada consultorio durante todo el horario."""
    d = next_weekday(agenda, 1, 9)
    for room in rooms:
        room_block(agenda, room, d, minutes=9 * 60)  # 09:00-18:00
    assert agenda.book("5211", "Ana Lopez", "proctologia", d.replace(hour=10))["error"] == "horario_ocupado"
    assert all(parse_dt(h).date() != d.date() for h in agenda.free_slots("proctologia", days=10, limit=40)["horarios"])


def test_valida_horario_pasado_domingo_y_fuera_de_horario(agenda):
    now = agenda.now()
    assert agenda.book("5211", "Ana Lopez", "proctologia", now - timedelta(hours=3))["error"] == "horario_pasado_o_muy_cercano"
    dom = next_weekday(agenda, 6, 10)
    assert agenda.book("5211", "Ana Lopez", "proctologia", dom)["error"] == "fuera_de_horario"
    assert agenda.book("5211", "Ana Lopez", "proctologia", next_weekday(agenda, 1, 18))["error"] == "fuera_de_horario"
    assert agenda.book("5211", "Ana Lopez", "proctologia", next_weekday(agenda, 5, 12, 30))["ok"]  # ultimo hueco del sabado
    assert agenda.book("5211", "Ana Lopez", "proctologia", next_weekday(agenda, 5, 13))["error"] == "fuera_de_horario"
    assert agenda.book("5211", "Ana Lopez", "proctologia", next_weekday(agenda, 1, 10, 15))["error"] == "fuera_de_horario"  # no alineado
    assert agenda.book("5211", "Ana Lopez", "proctologia", now + timedelta(days=90))["error"] == "fuera_de_rango"


def test_exige_nombre_completo_y_especialidad_valida(agenda):
    t = next_weekday(agenda, 1, 10)
    assert agenda.book("5211", "Ana", "proctologia", t)["error"] == "falta_nombre_completo"
    assert agenda.book("5211", "Ana Lopez", "cardiologia", t)["error"] == "especialidad_no_encontrada"


def test_privacidad_entre_pacientes(agenda):
    t = next_weekday(agenda, 1, 10)
    r = agenda.book("5211", "Ana Lopez", "proctologia", t)
    assert [m["cita_id"] for m in agenda.mine("5211")] == [r["cita_id"]]
    assert agenda.mine("5299") == []
    assert agenda.cancel("5299", r["cita_id"])["error"] == "cita_no_encontrada"
    assert agenda.reschedule("5299", r["cita_id"], t + agenda.rules.slot)["error"] == "cita_no_encontrada"
    assert len(agenda.mine("5211")) == 1


def test_cancelar_libera_el_hueco(agenda):
    t = next_weekday(agenda, 1, 10)
    r = agenda.book("5211", "Ana Lopez", "proctologia", t)
    assert agenda.cancel("5211", r["cita_id"])["ok"]
    assert agenda.mine("5211") == []
    assert agenda.book("5212", "Beto Ruiz", "proctologia", t)["ok"]


def test_reprogramar_mueve_y_no_se_bloquea_a_si_misma(agenda):
    slot = agenda.rules.slot
    t = next_weekday(agenda, 1, 10)
    r = agenda.book("5211", "Ana Lopez", "proctologia", t)
    r2 = agenda.reschedule("5211", r["cita_id"], t + slot)
    assert r2["ok"] and r2["reprogramada_desde"] == iso(t)
    assert r2["cita_id"] == r["cita_id"]  # ahora se conserva el id de la cita
    m = agenda.mine("5211")
    assert len(m) == 1 and m[0]["inicio"] == iso(t + slot)
    # reprogramar a hueco ocupado: la cita original se conserva
    agenda.book("5212", "Beto Ruiz", "proctologia", t + 2 * slot)
    assert agenda.reschedule("5211", m[0]["cita_id"], t + 2 * slot)["error"] == "horario_ocupado"
    assert len(agenda.mine("5211")) == 1 and agenda.mine("5211")[0]["inicio"] == iso(t + slot)


def test_concurrencia_nunca_sobrepasa_dos_citas_por_hora(agenda):
    t = next_weekday(agenda, 1, 15)
    specs = ["proctologia", "ginecologia", "reumatologia", "ultrasonidos", "otorrino", "anestesia", "ortopedia"]
    res = []
    th = [threading.Thread(target=lambda i=i: res.append(agenda.book(f"52{i}", f"Paciente Numero{i}", specs[i], t)))
          for i in range(7)]
    [x.start() for x in th]
    [x.join() for x in th]
    assert sum(1 for r in res if r.get("ok")) == 2, res


def test_ofrece_solo_horarios_realmente_libres(agenda, rooms):
    first = agenda.free_slots("proctologia", days=7, limit=1)["horarios"][0]
    t = parse_dt(first)
    for room in rooms:
        room_block(agenda, room, t)
    assert first not in agenda.free_slots("proctologia", days=7, limit=40)["horarios"]


def test_cita_de_otra_paciente_ana_no_bloquea_a_la_reumatologa_pero_su_ausencia_si(agenda, avail, rooms):
    """Reemplaza `paciente_llamada_ana_no_bloquea_a_la_reumatologa`: ya no se deduce el doctor del titulo de un evento;
    el doctor ocupado es el de la cita, y una ausencia lo bloquea a el y a nadie mas."""
    slot = agenda.rules.slot
    t = next_weekday(agenda, 2, 16)
    assert agenda.book("5210", "Ana Lopez", "proctologia", t)["ok"]  # una paciente llamada Ana, con otro doctor
    blk = room_block(agenda, rooms[1], t)
    assert agenda.book("5211", "Beto Ruiz", "reumatologia", t)["error"] == "horario_ocupado"  # sin consultorio libre
    agenda.update_booking(blk.id, status="cancelada")  # se libera el consultorio
    assert agenda.book("5211", "Beto Ruiz", "reumatologia", t)["ok"]  # la paciente "Ana" no bloqueaba a la Dra. Ana
    t2 = t + slot
    arguelles = agenda.find_doctor("reumatologia")
    avail.add_absence(arguelles.id, t2, t2 + slot, "congreso")
    assert agenda.book("5212", "Carla Diaz", "reumatologia", t2)["error"] == "doctor_no_disponible"
    assert agenda.book("5212", "Carla Diaz", "ginecologia", t2)["ok"]


def test_filtro_de_horas_ofrece_la_tarde(agenda):
    r = agenda.free_slots("proctologia", days=7, limit=6, hora_min=12)
    assert r["horarios"] and all(parse_dt(h).hour >= 12 for h in r["horarios"]), r
    r = agenda.free_slots("proctologia", days=7, limit=6, hora_max=10)
    assert r["horarios"] and all(parse_dt(h).hour < 10 for h in r["horarios"]), r
    r = agenda.free_slots("proctologia", days=7, limit=6, hora_min=20)
    assert r["horarios"] == [] and "nota" in r


def test_reparto_variado_de_horas_y_sin_duplicados(agenda):
    r = agenda.free_slots("proctologia", days=7, limit=6)["horarios"]
    assert len(r) == 6 and len(set(r)) == 6, r
    horas = {parse_dt(h).hour for h in r}
    assert len(horas) >= 3, ("poca variedad de horas", r)
    assert len({parse_dt(h).date() for h in r}) <= 3
    tarde = agenda.free_slots("proctologia", days=7, limit=6, hora_min=12)["horarios"]
    assert tarde and all(parse_dt(h).hour >= 12 for h in tarde) and len({parse_dt(h).hour for h in tarde}) >= 2, tarde


def test_reglas_de_tiempo_60_dias_y_1_hora(agenda, clinic):
    tz, slot = agenda.rules.tz, agenda.rules.slot
    assert agenda.rules.horizon_days == 60 and agenda.rules.min_notice_minutes == 60
    now = agenda.now()
    # hueco valido dentro de horario pero con menos de 1 hora de antelacion
    base = now + timedelta(minutes=40)
    cercanos = [s for s in clinic.all_slots(base.date()) if now <= s < now + timedelta(minutes=59)]
    if cercanos:
        assert agenda.book("5211", "Ana Lopez", "proctologia", cercanos[0])["error"] == "horario_pasado_o_muy_cercano"
    # 59 dias: permitido; 61 dias: rechazado
    d = now.date() + timedelta(days=59)
    while clinic.work_hours(d) is None:
        d -= timedelta(days=1)
    ok = datetime.combine(d, clinic.work_hours(d)[0], tz)
    assert agenda.book("5211", "Ana Lopez", "proctologia", ok)["ok"], "59 dias debe poder"
    d = now.date() + timedelta(days=62)
    while clinic.work_hours(d) is None:
        d += timedelta(days=1)
    lejos = datetime.combine(d, clinic.work_hours(d)[0], tz)
    assert agenda.book("5212", "Beto Ruiz", "proctologia", lejos)["error"] == "fuera_de_rango"
    # las listas nunca devuelven mas alla de 60 dias ni antes de 1 hora
    for h in agenda.free_slots("proctologia", days=90, limit=500)["horarios"]:
        dt = parse_dt(h)
        assert agenda.now() + timedelta(minutes=59) < dt <= agenda.now() + timedelta(days=60)
    # reprogramar tambien respeta el limite
    r = agenda.book("5213", "Carla Diaz", "ginecologia", next_weekday(agenda, 1, 10))
    assert agenda.reschedule("5213", r["cita_id"], lejos)["error"] == "fuera_de_rango"
    assert len(agenda.mine("5213")) == 1


def test_cercanos_horario_libre_es_exacto(agenda):
    t = next_weekday(agenda, 3, 16)
    r = agenda.nearest("proctologia", t)
    assert r["exacto"] is True and iso(t) in r["horarios"] and len(r["horarios"]) == 3, r


def test_cercanos_ocupado_propone_los_mas_proximos(agenda, rooms):
    t = next_weekday(agenda, 3, 16)
    for room in rooms:  # sin consultorio a las 16:00
        room_block(agenda, room, t)
    r = agenda.nearest("proctologia", t)
    assert r["exacto"] is False and iso(t) not in r["horarios"], r
    got = sorted(abs((parse_dt(h) - t).total_seconds()) for h in r["horarios"])
    assert got == [1800, 1800, 3600], got  # 15:30, 16:30 y 15:00/17:00


def test_cercanos_dia_lleno_salta_a_dias_vecinos(agenda, rooms):
    t = next_weekday(agenda, 3, 12)
    for room in rooms:
        room_block(agenda, room, t.replace(hour=9), minutes=9 * 60)
    r = agenda.nearest("proctologia", t)
    assert r["horarios"] and all(parse_dt(h).date() != t.date() for h in r["horarios"]), r


def test_cercanos_domingo_y_fuera_de_horario_dan_el_mas_cercano_valido(agenda):
    dom = next_weekday(agenda, 6, 11)
    r = agenda.nearest("proctologia", dom)
    assert r["exacto"] is False and r["horarios"] and all(parse_dt(h).weekday() != 6 for h in r["horarios"]), r
    noche = next_weekday(agenda, 2, 21)
    r = agenda.nearest("proctologia", noche)
    assert all(parse_dt(h).hour <= 17 or parse_dt(h).date() != noche.date() for h in r["horarios"]) and r["horarios"][0], r


def test_cercanos_respeta_limites_y_pasado(agenda):
    r = agenda.nearest("proctologia", agenda.now() + timedelta(days=90))
    assert r["error"] == "fuera_de_rango" and r["horarios"] == []
    r = agenda.nearest("proctologia", agenda.now() - timedelta(days=3))
    assert r["horarios"] and "nota" in r and all(parse_dt(h) > agenda.now() + timedelta(minutes=59) for h in r["horarios"]), r
    assert agenda.nearest("cardiologia", next_weekday(agenda, 1, 10))["error"] == "especialidad_no_encontrada"


def test_cercanos_ocupado_por_doctor_ocupado_en_otro_consultorio(agenda):
    t = next_weekday(agenda, 3, 10)
    agenda.book("5211", "Ana Lopez", "proctologia", t)  # el doctor ya esta ocupado a esa hora
    r = agenda.nearest("proctologia", t)
    assert r["exacto"] is False and iso(t) not in r["horarios"], r
