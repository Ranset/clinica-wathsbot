"""Pruebas nuevas del motor SQL: horario propio del doctor, ausencias, estados, atomicidad, antelacion, bloqueos,
privacidad por telefono y almacenamiento en UTC."""
from datetime import datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.agenda import SYSTEM, AgendaError, iso, parse_dt
from app.db import to_db
from app.models import Appointment, AppointmentBlock, AuditLog, Doctor
from helpers import check_integrity, next_weekday, room_block

HOURS_TUE_MORNING = {"tue": [{"start": "10:00", "end": "12:00"}]}


def err(fn, *a, **kw):
    """Codigo de AgendaError que lanza `fn` (o None si no lanza)."""
    try:
        fn(*a, **kw)
    except AgendaError as e:
        return e.code
    return None


def doc(agenda, spec):
    return agenda.find_doctor(spec)


def staff_booking(agenda, spec, start, name="Paciente Mostrador", **kw):
    return agenda.create_booking(start=start, doctor_id=doc(agenda, spec).id, patient_name=name, **kw)


# ------------------------------------------------------------------ horario propio del doctor
def test_horario_propio_del_doctor_limita_ofertas_y_reservas(agenda, avail):
    reuma = doc(agenda, "reumatologia")
    avail.set_doctor_hours(reuma.id, HOURS_TUE_MORNING)
    slots = [parse_dt(h) for h in agenda.free_slots("reumatologia", days=14, limit=40)["horarios"]]
    assert slots and all(s.weekday() == 1 and 10 <= s.hour < 12 for s in slots), slots
    near = [parse_dt(h) for h in agenda.nearest("reumatologia", next_weekday(agenda, 2, 10))["horarios"]]
    assert near and all(s.weekday() == 1 and 10 <= s.hour < 12 for s in near), near
    assert agenda.book("5211", "Ana Lopez", "reumatologia", next_weekday(agenda, 2, 10))["error"] == "doctor_no_disponible"  # miercoles
    assert agenda.book("5211", "Ana Lopez", "reumatologia", next_weekday(agenda, 1, 14))["error"] == "doctor_no_disponible"  # martes tarde
    assert agenda.book("5211", "Ana Lopez", "reumatologia", next_weekday(agenda, 1, 12))["error"] == "doctor_no_disponible"  # fin del intervalo
    assert agenda.book("5211", "Ana Lopez", "reumatologia", next_weekday(agenda, 1, 11, 30))["ok"]
    # los demas doctores siguen con el horario de la clinica
    assert agenda.book("5212", "Beto Ruiz", "proctologia", next_weekday(agenda, 2, 10))["ok"]
    # y el orden de errores: la clinica cerrada gana a "doctor no disponible"
    assert agenda.book("5213", "Carla Diaz", "reumatologia", next_weekday(agenda, 6, 10))["error"] == "fuera_de_horario"


def test_horario_propio_debe_estar_dentro_de_la_clinica(agenda, avail):
    d = doc(agenda, "ginecologia").id
    for weekly in ({"sun": [{"start": "10:00", "end": "12:00"}]},           # domingo: la clinica no abre
                   {"mon": [{"start": "08:00", "end": "12:00"}]},           # antes de abrir
                   {"sat": [{"start": "12:00", "end": "14:00"}]}):          # pasa del cierre del sabado (13:00)
        assert err(avail.set_doctor_hours, d, weekly) == "fuera_de_horario", weekly
    for weekly in ({"mon": [{"start": "10:15", "end": "12:00"}]},            # no alineado a 30 min
                   {"mon": [{"start": "12:00", "end": "10:00"}]},            # fin antes que inicio
                   {"mon": [{"start": "09:00", "end": "11:00"}, {"start": "10:30", "end": "12:00"}]},  # solapados
                   {"xyz": [{"start": "09:00", "end": "10:00"}]},            # dia desconocido
                   {"mon": [{"start": "9", "end": "10:00"}]}):               # hora mal escrita
        assert err(avail.set_doctor_hours, d, weekly) == "validacion", weekly
    assert err(avail.set_doctor_hours, 9999, None) == "no_encontrado"
    # nada de lo rechazado cambio el horario
    assert avail.doctor_weekly(d)[1] is True


def test_horario_con_pausa_admite_varios_intervalos(agenda, avail):
    d = doc(agenda, "ultrasonidos")
    avail.set_doctor_hours(d.id, {"thu": [{"start": "09:00", "end": "11:00"}, {"start": "15:00", "end": "17:00"}]})
    assert agenda.book("5211", "Ana Lopez", "ultrasonidos", next_weekday(agenda, 3, 10))["ok"]
    assert agenda.book("5212", "Beto Ruiz", "ultrasonidos", next_weekday(agenda, 3, 12))["error"] == "doctor_no_disponible"
    assert agenda.book("5213", "Carla Diaz", "ultrasonidos", next_weekday(agenda, 3, 16, 30))["ok"]
    weekly, uses_clinic = avail.doctor_weekly(d.id)
    assert uses_clinic is False and weekly == {"thu": [{"start": "09:00", "end": "11:00"}, {"start": "15:00", "end": "17:00"}]}


def test_volver_al_horario_de_la_clinica(agenda, avail, clinic):
    d = doc(agenda, "otorrino")
    avail.set_doctor_hours(d.id, HOURS_TUE_MORNING)
    assert agenda.book("5211", "Ana Lopez", "otorrino", next_weekday(agenda, 2, 10))["error"] == "doctor_no_disponible"
    _doctor, affected = avail.set_doctor_hours(d.id, None)
    weekly, uses_clinic = avail.doctor_weekly(d.id)
    assert uses_clinic is True and weekly == clinic.to_weekly() == avail.clinic_weekly() and affected == []
    assert agenda.book("5211", "Ana Lopez", "otorrino", next_weekday(agenda, 2, 10))["ok"]


def test_doctor_sin_ningun_dia_no_atiende(agenda, avail):
    d = doc(agenda, "anestesia")
    avail.set_doctor_hours(d.id, {})
    r = agenda.free_slots("anestesia", days=14)
    assert r["horarios"] == [] and "nota" in r
    assert agenda.book("5211", "Ana Lopez", "anestesia", next_weekday(agenda, 1, 10))["error"] == "doctor_no_disponible"


def test_cambiar_horario_devuelve_citas_afectadas_sin_cancelarlas(agenda, avail):
    wed, tue = next_weekday(agenda, 2, 10), next_weekday(agenda, 1, 10, 30)
    r_wed = agenda.book("5211", "Ana Lopez", "reumatologia", wed)
    r_tue = agenda.book("5212", "Beto Ruiz", "reumatologia", tue)
    _doctor, affected = avail.set_doctor_hours(doc(agenda, "reumatologia").id, HOURS_TUE_MORNING)
    assert [a.id for a in affected] == [int(r_wed["cita_id"])]  # solo la del miercoles queda fuera del nuevo horario
    assert {m["cita_id"] for m in agenda.mine("5211")} == {r_wed["cita_id"]}  # sigue agendada
    assert {m["cita_id"] for m in agenda.mine("5212")} == {r_tue["cita_id"]}
    check_integrity(agenda._sf)


# ------------------------------------------------------------------ ausencias
def test_ausencia_bloquea_ofertas_y_reservas_solo_de_ese_doctor(agenda, avail):
    d = next_weekday(agenda, 2, 9)
    arg = doc(agenda, "reumatologia")
    ab, affected = avail.add_absence(arg.id, d, d + timedelta(days=1), "congreso")
    assert affected == [] and ab.reason == "congreso"
    assert agenda.book("5211", "Ana Lopez", "reumatologia", d.replace(hour=10))["error"] == "doctor_no_disponible"
    assert agenda.book("5211", "Ana Lopez", "reumatologia", d.replace(hour=17, minute=30))["error"] == "doctor_no_disponible"
    assert agenda.book("5212", "Beto Ruiz", "proctologia", d.replace(hour=10))["ok"]  # otro doctor: sin efecto
    assert all(parse_dt(h).date() != d.date() for h in agenda.free_slots("reumatologia", days=14, limit=60)["horarios"])
    near = agenda.nearest("reumatologia", d.replace(hour=12))
    assert near["horarios"] and all(parse_dt(h).date() != d.date() for h in near["horarios"]), near
    assert agenda.book("5211", "Ana Lopez", "reumatologia", d.replace(hour=10) + timedelta(days=1))["ok"]  # al dia siguiente, si


def test_ausencia_parcial_bloquea_solo_las_franjas_solapadas(agenda, avail):
    d = next_weekday(agenda, 3, 9)
    arg = doc(agenda, "reumatologia")
    avail.add_absence(arg.id, d.replace(hour=11), d.replace(hour=12))
    book = lambda h, m=0: agenda.book("5211", "Ana Lopez", "reumatologia", d.replace(hour=h, minute=m))
    assert book(10, 30).get("ok")                                   # termina a las 11:00: no se solapa
    assert book(11)["error"] == "doctor_no_disponible"
    assert book(11, 30)["error"] == "doctor_no_disponible"
    assert book(12).get("ok")                                       # empieza cuando termina la ausencia


def test_ausencia_devuelve_citas_afectadas_y_no_las_cancela(agenda, avail, db):
    t = next_weekday(agenda, 1, 10)
    mine_ = agenda.book("5211", "Ana Lopez", "reumatologia", t)
    otra = agenda.book("5212", "Beto Ruiz", "reumatologia", t + timedelta(days=1))
    otro_doctor = agenda.book("5213", "Carla Diaz", "proctologia", t)
    ab, affected = avail.add_absence(doc(agenda, "reumatologia").id, t - timedelta(hours=1), t + timedelta(hours=2))
    assert [a.id for a in affected] == [int(mine_["cita_id"])]
    assert [m["cita_id"] for m in agenda.mine("5211")] == [mine_["cita_id"]]  # no se cancelo
    assert agenda.mine("5212") and agenda.mine("5213")
    with db() as s:
        assert s.scalar(select(Appointment.status).where(Appointment.id == int(mine_["cita_id"]))) == "agendada"
        assert s.scalar(select(func.count()).select_from(AppointmentBlock)
                        .where(AppointmentBlock.appointment_id == int(mine_["cita_id"]))) == 1
    assert otra["ok"] and otro_doctor["ok"]


def test_borrar_ausencia_devuelve_el_hueco_y_valida(agenda, avail):
    t = next_weekday(agenda, 1, 10)
    arg, gine = doc(agenda, "reumatologia"), doc(agenda, "ginecologia")
    ab, _ = avail.add_absence(arg.id, t, t + timedelta(hours=1))
    assert agenda.book("5211", "Ana Lopez", "reumatologia", t)["error"] == "doctor_no_disponible"
    assert err(avail.delete_absence, gine.id, ab.id) == "no_encontrado"   # la ausencia es de otro doctor
    assert err(avail.delete_absence, arg.id, 9999) == "no_encontrado"
    avail.delete_absence(arg.id, ab.id)
    assert agenda.book("5211", "Ana Lopez", "reumatologia", t)["ok"]
    assert avail.list_absences(arg.id) == []
    assert err(avail.add_absence, arg.id, t, t) == "validacion"
    assert err(avail.add_absence, arg.id, t + timedelta(hours=1), t) == "validacion"
    assert err(avail.add_absence, 9999, t, t + timedelta(hours=1)) == "no_encontrado"
    assert err(avail.add_absence, arg.id, t, t + timedelta(hours=1), "x" * 201) == "validacion"


def test_horario_de_la_clinica_editable_y_valida(agenda, avail):
    avail.set_clinic_hours({"mon": [{"start": "10:00", "end": "14:00"}]})
    assert agenda.book("5211", "Ana Lopez", "proctologia", next_weekday(agenda, 0, 9))["error"] == "fuera_de_horario"
    assert agenda.book("5211", "Ana Lopez", "proctologia", next_weekday(agenda, 0, 10))["ok"]
    assert agenda.book("5212", "Beto Ruiz", "proctologia", next_weekday(agenda, 1, 10))["error"] == "fuera_de_horario"
    assert err(avail.set_clinic_hours, {"mon": [{"start": "10:10", "end": "14:00"}]}) == "validacion"
    assert avail.clinic_weekly() == {"mon": [{"start": "10:00", "end": "14:00"}]}  # lo invalido no cambio nada


# ------------------------------------------------------------------ estados
def test_transiciones_de_estado(agenda, db):
    t = next_weekday(agenda, 1, 10)
    a = staff_booking(agenda, "proctologia", t)
    upd = lambda st: agenda.update_booking(a.id, status=st)
    assert upd("realizada").status == "realizada"
    assert upd("no_show").status == "no_show"          # correccion realizada <-> no_show
    assert upd("realizada").status == "realizada"
    assert err(upd, "cancelada") == "transicion_invalida"   # una cita realizada no se cancela
    assert err(upd, "agendada") == "transicion_invalida"
    assert upd("realizada").status == "realizada"      # mismo estado: sin cambio
    assert err(agenda.update_booking, a.id, status="inventado") == "validacion"
    assert err(agenda.update_booking, 9999, status="realizada") == "no_encontrado"
    # realizada / no_show conservan el hueco ocupado
    with db() as s:
        assert s.scalar(select(func.count()).select_from(AppointmentBlock).where(AppointmentBlock.appointment_id == a.id)) == 1
    b = staff_booking(agenda, "ginecologia", t)
    assert agenda.update_booking(b.id, status="cancelada").status == "cancelada"
    assert b.id and err(agenda.update_booking, b.id, status="agendada") == "transicion_invalida"   # terminal
    assert err(agenda.update_booking, b.id, status="realizada") == "transicion_invalida"
    assert err(agenda.update_booking, b.id, start=t + timedelta(hours=1)) == "transicion_invalida"
    with db() as s:  # cancelar libero el hueco
        assert s.scalar(select(func.count()).select_from(AppointmentBlock).where(AppointmentBlock.appointment_id == b.id)) == 0
        assert s.get(Appointment, b.id).cancelled_at is not None
    assert agenda.book("5211", "Ana Lopez", "ginecologia", t)["ok"]
    check_integrity(agenda._sf)


def test_el_paciente_no_toca_citas_que_ya_no_estan_agendadas_ni_bloqueos(agenda, rooms):
    t = next_weekday(agenda, 1, 10)
    done = staff_booking(agenda, "proctologia", t, phone="5211")
    agenda.update_booking(done.id, status="realizada")
    assert agenda.mine("5211") == []
    assert agenda.cancel("5211", done.id)["error"] == "cita_no_encontrada"
    assert agenda.reschedule("5211", done.id, t + timedelta(hours=1))["error"] == "cita_no_encontrada"
    blk = room_block(agenda, rooms[0], t + timedelta(hours=2))
    assert agenda.cancel("5211", blk.id)["error"] == "cita_no_encontrada"
    assert agenda.cancel("5211", "no-es-un-id")["error"] == "cita_no_encontrada"
    assert agenda.cancel("5211", 99999)["error"] == "cita_no_encontrada"


def test_transiciones_de_un_bloqueo(agenda, rooms):
    blk = room_block(agenda, rooms[0], next_weekday(agenda, 1, 10))
    assert err(agenda.update_booking, blk.id, status="realizada") == "transicion_invalida"
    assert err(agenda.update_booking, blk.id, status="no_show") == "transicion_invalida"
    assert agenda.update_booking(blk.id, status="cancelada").status == "cancelada"


# ------------------------------------------------------------------ atomicidad
def _blocks_of(db, appt_id):
    with db() as s:
        return [(b.room_id, b.doctor_id, b.slot_start) for b in
                s.scalars(select(AppointmentBlock).where(AppointmentBlock.appointment_id == appt_id)
                          .order_by(AppointmentBlock.slot_start))]


def test_reprogramar_a_hueco_ocupado_deja_todo_intacto(agenda, db, rooms):
    slot = agenda.rules.slot
    t = next_weekday(agenda, 1, 10)
    r = agenda.book("5211", "Ana Lopez", "proctologia", t)
    aid = int(r["cita_id"])
    before = _blocks_of(db, aid)
    for room in rooms:  # ambos consultorios bloqueados a las 11:00
        room_block(agenda, room, t + 2 * slot)
    assert agenda.reschedule("5211", r["cita_id"], t + 2 * slot)["error"] == "horario_ocupado"
    assert _blocks_of(db, aid) == before
    with db() as s:
        a = s.get(Appointment, aid)
        assert a.status == "agendada" and a.start_utc == before[0][2]
        assert s.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "appointment.move")) == 0
    # tambien si lo rechazan las reglas (fuera de horario, ausencia, antelacion)
    assert agenda.reschedule("5211", r["cita_id"], next_weekday(agenda, 6, 10))["error"] == "fuera_de_horario"
    assert agenda.reschedule("5211", r["cita_id"], agenda.now() - timedelta(hours=1))["error"] == "horario_pasado_o_muy_cercano"
    assert _blocks_of(db, aid) == before
    check_integrity(agenda._sf)


def test_reprogramar_es_atomico_si_algo_revienta_a_mitad(agenda, db, monkeypatch):
    """Simula un fallo DESPUES de liberar los huecos viejos y antes de reservar los nuevos: nada debe cambiar."""
    t = next_weekday(agenda, 1, 10)
    r = agenda.book("5211", "Ana Lopez", "proctologia", t)
    aid = int(r["cita_id"])
    before = _blocks_of(db, aid)

    def boom(*a, **k):
        raise RuntimeError("fallo simulado")
    monkeypatch.setattr(type(agenda), "_place", boom)
    with pytest.raises(RuntimeError):
        agenda.reschedule("5211", r["cita_id"], t + timedelta(hours=1))
    monkeypatch.undo()
    assert _blocks_of(db, aid) == before          # los huecos viejos siguen ahi
    assert agenda.mine("5211")[0]["inicio"] == iso(t)
    assert agenda.book("5212", "Beto Ruiz", "proctologia", t)["error"] == "horario_ocupado"   # y siguen ocupando
    check_integrity(agenda._sf)


def test_reservar_que_falla_no_deja_citas_ni_huecos_a_medias(agenda, db, rooms):
    t = next_weekday(agenda, 1, 10)
    for room in rooms:
        room_block(agenda, room, t)
    with db() as s:
        n = s.scalar(select(func.count()).select_from(Appointment))
    assert agenda.book("5211", "Ana Lopez", "proctologia", t)["error"] == "horario_ocupado"
    assert err(staff_booking, agenda, "proctologia", t) == "horario_ocupado"
    with db() as s:
        assert s.scalar(select(func.count()).select_from(Appointment)) == n
    check_integrity(agenda._sf)


def test_reprogramar_al_mismo_horario_y_mover_una_cita_larga_solapada(agenda):
    slot = agenda.rules.slot
    t = next_weekday(agenda, 1, 10)
    r = agenda.book("5211", "Ana Lopez", "proctologia", t)
    r2 = agenda.reschedule("5211", r["cita_id"], t)               # mismo horario: no choca consigo misma
    assert r2["ok"] and r2["inicio"] == iso(t)
    larga = staff_booking(agenda, "ginecologia", t, duration_minutes=60)          # 10:00-11:00
    moved = agenda.update_booking(larga.id, start=t + slot)                     # 10:30-11:30 solapa con su propio hueco
    assert moved.start_utc == to_db(t + slot) and moved.duration_minutes == 60
    check_integrity(agenda._sf)
    assert agenda.book("5212", "Beto Ruiz", "ginecologia", t)["ok"]     # 10:00 quedo libre para ese doctor
    assert agenda.book("5213", "Carla Diaz", "ginecologia", t + 2 * slot)["error"] == "horario_ocupado"  # 11:00 sigue ocupado


# ------------------------------------------------------------------ antelacion y rangos (reloj congelado)
FIXED = datetime(2026, 11, 16, 10, 0)  # lunes 10:00, hora de Cancun


@pytest.fixture
def frozen(make_app):
    from zoneinfo import ZoneInfo
    tz = ZoneInfo("America/Cancun")
    now = FIXED.replace(tzinfo=tz)
    app = make_app(clock=lambda: now)
    return app.extensions["agenda"], app.extensions["availability"], now


def test_antelacion_minima_y_horizonte_con_reloj_congelado(frozen):
    agenda, _avail, now = frozen
    assert agenda.now() == now and now.weekday() == 0
    assert agenda.book("5211", "Ana Lopez", "proctologia", now + timedelta(minutes=30))["error"] == "horario_pasado_o_muy_cercano"
    assert agenda.book("5211", "Ana Lopez", "proctologia", now + timedelta(minutes=60))["ok"]            # justo 60 min: permitido
    d60 = now + timedelta(days=60)                                                                         # viernes 10:00
    assert d60.weekday() == 4 and agenda.book("5212", "Beto Ruiz", "proctologia", d60)["ok"]               # justo 60 dias: permitido
    assert agenda.book("5213", "Carla Diaz", "proctologia", d60 + timedelta(minutes=30))["error"] == "fuera_de_rango"
    assert all(now + timedelta(minutes=60) <= parse_dt(h) <= d60
               for h in agenda.free_slots("proctologia", days=90, limit=500)["horarios"])


def test_allow_short_notice_solo_omite_la_antelacion(frozen):
    agenda, avail, now = frozen
    doc_id = doc(agenda, "reumatologia").id
    mk = lambda start, **kw: agenda.create_booking(start=start, doctor_id=doc_id, patient_name="Cliente Mostrador",
                                                   allow_short_notice=True, **kw)
    assert err(agenda.create_booking, start=now + timedelta(minutes=30), doctor_id=doc_id,
               patient_name="Cliente Mostrador") == "horario_pasado_o_muy_cercano"          # sin la bandera: regla normal
    assert mk(now + timedelta(minutes=30)).start_utc is not None                               # con la bandera: cita de mostrador
    # lo demas se sigue exigiendo
    assert err(mk, now - timedelta(minutes=30)) == "horario_pasado_o_muy_cercano"           # el pasado no se agenda
    assert err(mk, now + timedelta(days=60, minutes=30)) == "fuera_de_rango"                  # horizonte
    assert err(mk, now.replace(hour=18)) == "fuera_de_horario"                                # clinica cerrada
    assert err(mk, now + timedelta(minutes=45)) == "fuera_de_horario"                         # no alineado a 30 min
    avail.add_absence(doc_id, now + timedelta(hours=2), now + timedelta(hours=3))
    assert err(mk, now + timedelta(hours=2)) == "doctor_no_disponible"                       # ausencia
    assert err(mk, now + timedelta(minutes=30)) == "horario_ocupado"                          # ya ocupado
    # reprogramar con la bandera (PATCH del personal) tambien omite solo la antelacion
    a = staff_booking(agenda, "proctologia", now + timedelta(days=2))
    moved = agenda.update_booking(a.id, start=now + timedelta(minutes=30), allow_short_notice=True)
    assert moved.start_utc == to_db(now + timedelta(minutes=30))
    b = staff_booking(agenda, "ginecologia", now + timedelta(days=2))
    assert err(agenda.update_booking, b.id, start=now + timedelta(minutes=30)) == "horario_pasado_o_muy_cercano"
    check_integrity(agenda._sf)


def test_free_slots_con_from_day_lejano_no_pasa_del_horizonte(frozen):
    agenda, _avail, now = frozen
    r = agenda.free_slots("proctologia", from_day=(now + timedelta(days=55)).date(), days=30, limit=60)
    assert r["horarios"] and all(parse_dt(h) <= now + timedelta(days=60) for h in r["horarios"]), r


# ------------------------------------------------------------------ bloqueos de consultorio
def test_bloqueos_de_consultorio(agenda, rooms, db):
    t = next_weekday(agenda, 1, 10)
    assert err(agenda.create_booking, kind="block", start=t) == "validacion"                                  # sin consultorio
    assert err(agenda.create_booking, kind="block", start=t, room_id=rooms[0].id, doctor_id=1) == "validacion"  # con doctor
    assert err(agenda.create_booking, kind="block", start=t, room_id=rooms[0].id, duration_minutes=45) == "validacion"
    assert err(agenda.create_booking, kind="block", start=t, room_id=rooms[0].id, duration_minutes=0) == "validacion"
    assert err(agenda.create_booking, kind="block", start=t, room_id=9999) == "validacion"
    assert err(agenda.create_booking, kind="block", start=t.replace(minute=15), room_id=rooms[0].id) == "fuera_de_horario"
    assert err(agenda.create_booking, kind="block", start=t - timedelta(days=30), room_id=rooms[0].id) == "horario_pasado_o_muy_cercano"
    assert err(agenda.create_booking, kind="otro", start=t, room_id=rooms[0].id) == "validacion"
    blk = room_block(agenda, rooms[0], t, minutes=60, notes="Mantenimiento de aire")
    assert blk.kind == "block" and blk.doctor_id is None and blk.patient_name is None and blk.phone is None
    assert blk.notes == "Mantenimiento de aire" and blk.duration_minutes == 60
    assert [b[1] for b in _blocks_of(db, blk.id)] == [None, None]                  # doctor_id NULL en ambos huecos
    # fuera del horario de pacientes tambien se puede bloquear (a diferencia de una cita)
    assert room_block(agenda, rooms[1], next_weekday(agenda, 6, 10)).kind == "block"
    # el bloqueo solo ocupa su consultorio: la reserva cae en el otro
    assert agenda.book("5211", "Ana Lopez", "proctologia", t)["consultorio"] == "Consultorio 2"
    # un bloqueo no puede pisar una cita existente
    assert err(room_block, agenda, rooms[1], t) == "horario_ocupado"
    # en otro consultorio y misma hora, dos bloqueos conviven (doctor NULL no choca consigo mismo)
    assert room_block(agenda, rooms[1], t + timedelta(hours=3)).id and room_block(agenda, rooms[0], t + timedelta(hours=3)).id
    # un bloqueo se mueve dentro de SU consultorio
    moved = agenda.update_booking(blk.id, start=t + timedelta(hours=5))
    assert moved.room_id == rooms[0].id and moved.kind == "block"
    # los pacientes nunca ven bloqueos
    assert agenda.mine("5211")[0]["cita_id"] != str(blk.id)
    agenda.update_booking(blk.id, status="cancelada")
    check_integrity(agenda._sf)


def test_lista_de_citas_con_filtros(agenda, rooms):
    t = next_weekday(agenda, 1, 10)
    a = staff_booking(agenda, "proctologia", t)
    b = staff_booking(agenda, "ginecologia", t + timedelta(hours=1), duration_minutes=60)
    blk = room_block(agenda, rooms[1], t)
    c = staff_booking(agenda, "proctologia", t + timedelta(days=1))
    agenda.update_booking(c.id, status="cancelada")
    rng = lambda **kw: [x.id for x in agenda.list_bookings(t - timedelta(hours=1), t + timedelta(hours=3), **kw)]
    assert sorted(rng()) == sorted([a.id, b.id, blk.id])
    assert rng(doctor_id=doc(agenda, "proctologia").id) == [a.id]
    assert rng(room_id=rooms[1].id) == [blk.id]
    assert [x.id for x in agenda.list_bookings(t, t + timedelta(days=2), status="cancelada")] == [c.id]
    # una cita de 60 min que EMPEZO antes del rango pero sigue en curso dentro de el, se incluye
    assert b.id in [x.id for x in agenda.list_bookings(t + timedelta(hours=1, minutes=30), t + timedelta(hours=2))]
    assert b.id not in [x.id for x in agenda.list_bookings(t + timedelta(hours=2), t + timedelta(hours=3))]
    got = {x.id: x for x in agenda.list_bookings(t, t + timedelta(hours=3))}
    assert got[b.id].doctor.specialty == "Ginecología" and got[b.id].room.name in ("Consultorio 1", "Consultorio 2")


# ------------------------------------------------------------------ altas manuales y ediciones
def test_validaciones_de_alta_manual(agenda, rooms):
    t = next_weekday(agenda, 2, 10)
    gine = doc(agenda, "ginecologia").id
    mk = lambda **kw: agenda.create_booking(**{"start": t, "doctor_id": gine, "patient_name": "Ana Lopez", **kw})
    assert err(mk, doctor_id=None) == "validacion"
    assert err(mk, doctor_id=9999) == "validacion"
    assert err(mk, patient_name="Ana") == "falta_nombre_completo"
    assert err(mk, patient_name=None) == "falta_nombre_completo"
    assert err(mk, phone="telefono") == "validacion"
    assert err(mk, duration_minutes=45) == "validacion"
    assert err(mk, duration_minutes=24 * 60 + 30) == "validacion"
    assert err(mk, notes="x" * 501) == "validacion"
    assert err(mk, source="otro") == "validacion"
    assert err(mk, room_id=9999) == "validacion"
    assert err(mk, room_id="abc") == "validacion"
    assert err(mk, start=t.replace(hour=17, minute=30), duration_minutes=60) == "fuera_de_horario"   # cruza el cierre
    ok = mk(duration_minutes=60, notes="  primera vez  ", phone="5219990001")
    assert ok.duration_minutes == 60 and ok.notes == "primera vez" and ok.source == "manual" and ok.phone == "5219990001"
    assert err(mk, doctor_id=doc(agenda, "reumatologia").id, start=t + timedelta(minutes=30), room_id=ok.room_id) == "horario_ocupado"   # consultorio explicito ocupado
    other = mk(doctor_id=doc(agenda, "reumatologia").id, start=t + timedelta(minutes=30), room_id=rooms[1].id if ok.room_id == rooms[0].id else rooms[0].id)
    assert other.room_id != ok.room_id
    assert err(mk, start=t + timedelta(minutes=30)) == "horario_ocupado"          # mismo doctor, 2o hueco de la cita larga
    check_integrity(agenda._sf)


def test_update_booking_notas_consultorio_y_conflictos(agenda, rooms):
    slot = agenda.rules.slot
    t = next_weekday(agenda, 3, 10)
    a = staff_booking(agenda, "proctologia", t, notes="uno")
    assert agenda.update_booking(a.id, notes="dos").notes == "dos"
    assert agenda.update_booking(a.id, notes=None).notes is None
    assert agenda.update_booking(a.id).notes is None                           # sin cambios
    assert err(agenda.update_booking, a.id, notes="x" * 501) == "validacion"
    other_room = rooms[1] if a.room_id == rooms[0].id else rooms[0]
    assert agenda.update_booking(a.id, room_id=other_room.id).room_id == other_room.id    # solo consultorio, mismo horario
    assert err(agenda.update_booking, a.id, room_id=9999) == "validacion"
    assert err(agenda.update_booking, a.id, status="realizada", start=t + slot) == "validacion"   # estado + mover no se combinan
    b = staff_booking(agenda, "ginecologia", t + slot)
    c = staff_booking(agenda, "reumatologia", t + slot)                         # ambos consultorios ocupados a las 10:30
    assert err(agenda.update_booking, a.id, start=t + slot) == "horario_ocupado"
    assert agenda.get_booking(a.id).start_utc == a.start_utc                    # intacta
    assert b.id != c.id and agenda.get_booking(99999) is None
    check_integrity(agenda._sf)


def test_citas_del_personal_con_telefono_las_ve_y_cancela_el_paciente(agenda):
    t = next_weekday(agenda, 1, 10)
    a = staff_booking(agenda, "proctologia", t, phone="5219990001")
    assert [m["cita_id"] for m in agenda.mine("5219990001")] == [str(a.id)]
    assert agenda.cancel("5219990001", a.id)["ok"]
    assert agenda.mine("5219990001") == []


def test_telefono_vacio_no_es_dueno_de_las_citas_de_mostrador_sin_telefono(agenda):
    t = next_weekday(agenda, 1, 10)
    a = staff_booking(agenda, "proctologia", t)            # sin telefono: phone IS NULL
    assert a.phone is None
    for nobody in (None, "", "   "):
        assert agenda.mine(nobody) == []
        assert agenda.cancel(nobody, a.id)["error"] == "cita_no_encontrada"
        assert agenda.reschedule(nobody, a.id, t + timedelta(hours=1))["error"] == "cita_no_encontrada"
    assert agenda.get_booking(a.id).status == "agendada"
    assert agenda.book(None, "Ana Lopez", "proctologia", t + timedelta(hours=2))["error"] == "validacion"
    assert agenda.book("", "Ana Lopez", "proctologia", t + timedelta(hours=2))["error"] == "validacion"


def test_doctor_inactivo_no_se_ofrece_ni_se_reserva(agenda, db, avail):
    t = next_weekday(agenda, 1, 10)
    r = agenda.book("5211", "Ana Lopez", "ortopedia", t)
    with db() as s, s.begin():
        s.get(Doctor, doc(agenda, "ortopedia").id).active = False
    assert agenda.find_doctor("ortopedia") is None
    e = agenda.book("5212", "Beto Ruiz", "ortopedia", t + timedelta(hours=1))
    assert e["error"] == "especialidad_no_encontrada" and "Ortopedia y Traumatología" not in e["especialidades"]
    assert len(e["especialidades"]) == 6
    assert agenda.reschedule("5211", r["cita_id"], t + timedelta(hours=1))["error"] == "doctor_no_disponible"   # su cita no se puede mover
    assert agenda.cancel("5211", r["cita_id"])["ok"]                                                           # pero si cancelar


# ------------------------------------------------------------------ almacenamiento y auditoria
def test_parse_dt_acepta_los_formatos_del_contrato():
    """`IsoLocalInput`: con/sin desfase, con/sin segundos y 'Z'. En Python 3.10 `fromisoformat` no entiende la 'Z'."""
    from app.agenda.util import _DEFAULT_TZ
    for s in ("2026-11-12T13:30", "2026-11-12T13:30:00", "2026-11-12T13:30-05:00", "2026-11-12T18:30Z",
              "2026-11-12T18:30:00Z", "2026-11-12T18:30:00+00:00", " 2026-11-12T18:30z "):
        dt = parse_dt(s)
        assert (dt.hour, dt.minute) == (13, 30) and dt.utcoffset() == timedelta(hours=-5), s
        assert dt.tzinfo is _DEFAULT_TZ or str(dt.tzinfo) == "America/Cancun"


def test_la_hora_se_guarda_en_utc_ingenuo(agenda, db):
    t = next_weekday(agenda, 1, 10)                      # 10:00 en Cancun (UTC-5)
    r = agenda.book("5211", "Ana Lopez", "proctologia", t)
    with db() as s:
        a = s.get(Appointment, int(r["cita_id"]))
        assert a.start_utc == datetime(t.year, t.month, t.day, 15, 0) and a.start_utc.tzinfo is None
        assert s.scalar(select(AppointmentBlock.slot_start).where(AppointmentBlock.appointment_id == a.id)) == a.start_utc
    assert r["inicio"] == iso(t) and r["inicio"].endswith("-05:00")
    # un instante con otra zona (UTC) se normaliza: 15:00Z es el mismo hueco
    assert agenda.book("5212", "Beto Ruiz", "proctologia", parse_dt(f"{t:%Y-%m-%d}T15:00:00+00:00"))["error"] == "horario_ocupado"
    # y un valor sin desfase se toma como hora de Cancun
    assert agenda.book("5212", "Beto Ruiz", "proctologia", parse_dt(f"{t:%Y-%m-%d}T10:00"))["error"] == "horario_ocupado"


def test_unique_de_la_bd_impide_el_doble_uso(agenda, db, rooms):
    """La exclusion mutua es de la BD, no del codigo: insertar directo tambien choca."""
    t = next_weekday(agenda, 1, 10)
    r = agenda.book("5211", "Ana Lopez", "proctologia", t)
    with db() as s:
        a = s.get(Appointment, int(r["cita_id"]))
        blk = s.scalar(select(AppointmentBlock).where(AppointmentBlock.appointment_id == a.id))
        other_room = next(x for x in rooms if x.id != blk.room_id)
        s2_doctor = doc(agenda, "ginecologia").id

    def insert(doctor_id, room_id, slot):
        with db() as s:
            try:
                with s.begin():
                    s.add(AppointmentBlock(appointment_id=a.id, doctor_id=doctor_id, room_id=room_id, slot_start=slot))
                return "ok"
            except IntegrityError:
                return "choca"
    assert insert(blk.doctor_id, other_room.id, blk.slot_start) == "choca"        # mismo doctor, misma hora
    assert insert(s2_doctor, blk.room_id, blk.slot_start) == "choca"              # mismo consultorio, misma hora
    assert insert(s2_doctor, other_room.id, blk.slot_start) == "ok"               # otro doctor y otro consultorio
    assert insert(None, rooms[0].id, blk.slot_start + timedelta(hours=9)) == "ok"
    assert insert(None, rooms[1].id, blk.slot_start + timedelta(hours=9)) == "ok"  # dos NULL de doctor no chocan
    assert insert(None, rooms[1].id, blk.slot_start + timedelta(hours=9)) == "choca"   # pero el consultorio si


def test_auditoria_de_cambios_sin_datos_personales(agenda, rooms, db):
    t = next_weekday(agenda, 1, 10)
    r = agenda.book("5211", "Ana Lopez", "proctologia", t)
    agenda.reschedule("5211", r["cita_id"], t + timedelta(hours=1))
    agenda.cancel("5211", r["cita_id"])
    staff = agenda.create_booking(start=t, doctor_id=doc(agenda, "ginecologia").id, patient_name="Beto Ruiz", phone="5212",
                                  actor=SYSTEM)
    with db() as s:
        rows = list(s.scalars(select(AuditLog).order_by(AuditLog.id)))
    assert [x.action for x in rows] == ["appointment.create", "appointment.move", "appointment.cancel", "appointment.create"]
    assert [x.actor_kind for x in rows] == ["bot", "bot", "bot", "system"]
    assert all(x.entity_type == "appointment" for x in rows) and rows[-1].entity_id == str(staff.id)
    dump = " ".join(str(x.data) for x in rows)
    assert "Ana" not in dump and "5211" not in dump and "Beto" not in dump        # sin nombres ni telefonos
    assert rows[1].data["from"] == iso(t) and rows[1].data["to"] == iso(t + timedelta(hours=1))


# ------------------------------------------------------------------ el UNIQUE es la red de seguridad
def test_la_bd_decide_cuando_la_precomprobacion_se_equivoca(agenda, rooms, db, monkeypatch):
    """Simula una carrera perdida: la lectura previa dice 'todo libre' (como si otro proceso hubiera reservado justo
    despues de leer). Los UNIQUE de `appointment_blocks` deben rechazar el intento, el SAVEPOINT descartar solo ese
    intento y la reserva caer en el siguiente consultorio libre, sin dejar rastro de los intentos fallidos."""
    t = next_weekday(agenda, 1, 10)
    room_block(agenda, rooms[0], t)                                           # consultorio 1 realmente ocupado
    monkeypatch.setattr(type(agenda), "_free_rooms", lambda self, repo, doctor, candidates, slots_u: list(candidates))
    r = agenda.book("5211", "Ana Lopez", "proctologia", t)
    assert r["ok"] and r["consultorio"] == "Consultorio 2"                    # choco en el 1 (UNIQUE de consultorio), entro al 2
    with db() as s:
        assert s.get(Appointment, int(r["cita_id"])).room_id == rooms[1].id  # la cita quedo en el consultorio donde SI entro
    # ahora no queda consultorio libre: la BD rechaza aunque la pre-comprobacion diga que si
    assert agenda.book("5212", "Beto Ruiz", "ginecologia", t)["error"] == "horario_ocupado"
    # y el doctor ya esta ocupado (UNIQUE de doctor), aunque haya consultorio
    agenda.update_booking(int(room_block(agenda, rooms[0], t + agenda.rules.slot * 4).id), status="cancelada")
    assert agenda.book("5213", "Carla Diaz", "proctologia", t)["error"] == "horario_ocupado"
    with db() as s:
        assert s.scalar(select(func.count()).select_from(AppointmentBlock)) == 2        # solo el bloqueo y la cita de Ana
        assert s.scalar(select(func.count()).select_from(Appointment).where(Appointment.status == "agendada")) == 2
    check_integrity(agenda._sf)
