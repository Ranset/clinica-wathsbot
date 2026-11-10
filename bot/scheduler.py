"""Agendador de Wathsbot: logica determinista (el modelo NUNCA toca el calendario).

Recursos que no se pueden duplicar: 2 consultorios y cada doctor.
Un horario se ofrece solo si: el doctor atiende, el doctor no tiene otra cita
(en ningun consultorio) y al menos un consultorio esta libre.
La identidad del paciente es su telefono de WhatsApp (viene del webhook, no del texto).
"""
import json, os, re, threading
from datetime import datetime, timedelta, date, time
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, "agenda_config.json"), encoding="utf-8"))
TZ = ZoneInfo(CFG["timezone"])
SLOT = timedelta(minutes=CFG["slot_minutes"])
LOCK = threading.Lock()


def now():
    return datetime.now(TZ)


def norm(s):
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


def find_doctor(specialty):
    """Devuelve (clave_especialidad, doctor) o None. Acepta sinonimos y errores menores."""
    q = norm(specialty or "")
    for key, d in CFG["doctors"].items():
        names = [key] + d.get("aliases", [])
        if any(norm(n) in q or q in norm(n) for n in names if q):
            return key, d
    return None


def work_hours(day):
    """(apertura, cierre) como time, o None si no se atiende ese dia."""
    h = CFG["hours"].get(str(day.weekday()))
    return (time.fromisoformat(h[0]), time.fromisoformat(h[1])) if h else None


def all_slots(day):
    wh = work_hours(day)
    if not wh:
        return []
    cur = datetime.combine(day, wh[0], TZ)
    end = datetime.combine(day, wh[1], TZ)
    out = []
    while cur + SLOT <= end:
        out.append(cur)
        cur += SLOT
    return out


def overlaps(a_start, a_end, b_start, b_end):
    return a_start < b_end and b_start < a_end


class Agenda:
    """backend: objeto con list_events(cal,start,end,private=None), insert(cal,body), delete(cal,id)."""

    def __init__(self, backend):
        self.b = backend
        self.cals = CFG["consultorios"]  # {"Consultorio 1": calId, ...}

    # ---- lectura ----
    def _busy(self, start, end, ignore_id=None):
        """Eventos en el rango, por consultorio."""
        res = {}
        for name, cal in self.cals.items():
            res[name] = [e for e in self.b.list_events(cal, start, end) if e["id"] != ignore_id]
        return res

    def slot_state(self, doctor, start, busy):
        end = start + SLOT
        doc_busy = False
        free = []
        for name, evs in busy.items():
            taken = False
            for e in evs:
                if overlaps(start, end, e["start"], e["end"]):
                    taken = True
                    if e["private"].get("doctor"):
                        if e["private"]["doctor"] == doctor["name"]:
                            doc_busy = True
                    elif re.search(r"\b" + re.escape(norm(doctor["match"])) + r"\b", norm(e["summary"])):
                        doc_busy = True  # evento manual del equipo que menciona al doctor
            if not taken:
                free.append(name)
        return (not doc_busy and bool(free)), free

    def free_slots(self, specialty, from_day=None, days=7, limit=6, hora_min=None, hora_max=None):
        f = find_doctor(specialty)
        if not f:
            return {"error": "especialidad_no_encontrada", "especialidades": [d["label"] for d in CFG["doctors"].values()]}
        _, doc = f
        earliest = now() + timedelta(minutes=CFG["min_notice_minutes"])
        d0 = from_day or earliest.date()
        d0 = max(d0, earliest.date())
        horizon = min(days, CFG["horizon_days"])
        busy = self._busy(datetime.combine(d0, time(0), TZ), datetime.combine(d0 + timedelta(days=horizon), time(0), TZ))
        out = []
        for i in range(horizon):
            for s in all_slots(d0 + timedelta(days=i)):
                if s < earliest:
                    continue
                if hora_min is not None and s.hour + s.minute / 60 < hora_min:
                    continue
                if hora_max is not None and s.hour + s.minute / 60 >= hora_max:
                    continue
                ok, _free = self.slot_state(doc, s, busy)
                if ok:
                    out.append(s)
        # repartir: primeros dias con huecos, y horas variadas dentro de cada dia
        # (manana / mediodia / tarde) en lugar de siempre la primera hora.
        by_day = {}
        for s in out:
            by_day.setdefault(s.date(), []).append(s)
        days_ok = sorted(by_day)[:3]
        fracs = [0.0, 0.5, 0.8, 0.25, 0.65, 0.95]
        picked = []
        n = 0
        while len(picked) < limit and any(by_day[d] for d in days_ok) and n < 60:
            d = days_ok[n % len(days_ok)]
            lst = by_day[d]
            if lst:
                picked.append(lst.pop(int(fracs[n % len(fracs)] * len(lst)) if len(lst) > 1 else 0))
            n += 1
        picked.sort()
        res = {"doctor": doc["name"], "especialidad": doc["label"], "horarios": [iso(s) for s in picked]}
        if not picked:
            res["nota"] = "sin horarios libres con esos criterios en los dias consultados"
        return res

    def nearest(self, specialty, target, limit=3, window_days=7):
        """Huecos libres mas cercanos a la fecha/hora que pidio el paciente.
        Respeta antelacion minima y horizonte maximo. 'exacto' = el horario pedido esta libre."""
        f = find_doctor(specialty)
        if not f:
            return {"error": "especialidad_no_encontrada", "especialidades": [d["label"] for d in CFG["doctors"].values()]}
        _, doc = f
        earliest = now() + timedelta(minutes=CFG["min_notice_minutes"])
        latest = now() + timedelta(days=CFG["horizon_days"])
        res = {"doctor": doc["name"], "especialidad": doc["label"],
               "maximo_agendable": latest.date().isoformat()}
        if target > latest:
            res.update(error="fuera_de_rango", horarios=[],
                       nota=f"solo se agenda hasta {CFG['horizon_days']} dias a futuro")
            return res
        note = None
        if target < earliest:
            note = f"el horario pedido ya paso o requiere {CFG['min_notice_minutes']} min de antelacion; se buscan los primeros disponibles"
            target = earliest
        lo = max(earliest.date(), (target - timedelta(days=window_days)).date())
        hi = min(latest.date(), (target + timedelta(days=window_days)).date())
        busy = self._busy(datetime.combine(lo, time(0), TZ), datetime.combine(hi + timedelta(days=1), time(0), TZ))
        cands = []
        d = lo
        while d <= hi:
            for s in all_slots(d):
                if earliest <= s <= latest and self.slot_state(doc, s, busy)[0]:
                    cands.append(s)
            d += timedelta(days=1)
        cands.sort(key=lambda s: (abs((s - target).total_seconds()), s))
        top = cands[:limit]
        exact = bool(top) and top[0] == target.replace(second=0, microsecond=0)
        top.sort()
        res.update(exacto=exact, horarios=[iso(x) for x in top])
        if note:
            res["nota"] = note
        if not top:
            res["nota"] = "sin horarios libres cerca de esa fecha"
        return res

    # ---- escritura ----
    def book(self, phone, patient_name, specialty, start, ignore_id=None):
        f = find_doctor(specialty)
        if not f:
            return {"error": "especialidad_no_encontrada"}
        _, doc = f
        if not patient_name or len(patient_name.split()) < 2:
            return {"error": "falta_nombre_completo"}
        with LOCK:
            err = self._check_bookable(doc, start, ignore_id)
            if err:
                return err
            busy = self._busy(start, start + SLOT, ignore_id)
            ok, free = self.slot_state(doc, start, busy)
            if not ok:
                return {"error": "horario_ocupado"}
            room = free[0]
            body = {
                "summary": f"{doc['label']} - {patient_name} ({doc['name']})",
                "description": f"Paciente: {patient_name}\nTelefono: +{phone}\nEspecialidad: {doc['label']}\nDoctor: {doc['name']}\nConsultorio: {room}\nAgendada por Wathsbot",
                "start": {"dateTime": start.isoformat(), "timeZone": CFG["timezone"]},
                "end": {"dateTime": (start + SLOT).isoformat(), "timeZone": CFG["timezone"]},
                "extendedProperties": {"private": {"phone": phone, "doctor": doc["name"], "specialty": doc["label"], "patient": patient_name, "room": room, "bot": "wathsbot"}},
            }
            ev = self.b.insert(self.cals[room], body)
            # re-verificacion post-insercion: si otro proceso reservo lo mismo antes, deshacer
            again = self._busy(start, start + SLOT)
            clash = [e for e in again[room] if overlaps(start, start + SLOT, e["start"], e["end"]) and e["id"] != ev["id"] and e["created"] <= ev["created"]]
            if clash:
                self.b.delete(self.cals[room], ev["id"])
                return {"error": "horario_ocupado"}
            return {"ok": True, "event_id": ev["id"], "doctor": doc["name"], "especialidad": doc["label"],
                    "consultorio": room, "inicio": iso(start), "paciente": patient_name}

    def _check_bookable(self, doc, start, ignore_id=None):
        if start.tzinfo is None:
            start = start.replace(tzinfo=TZ)
        if start < now() + timedelta(minutes=CFG["min_notice_minutes"]):
            return {"error": "horario_pasado_o_muy_cercano"}
        if start > now() + timedelta(days=CFG["horizon_days"]):
            return {"error": "fuera_de_rango"}
        if start not in all_slots(start.astimezone(TZ).date()):
            return {"error": "fuera_de_horario"}
        return None

    def mine(self, phone):
        """Citas futuras del paciente (por telefono)."""
        out = []
        for name, cal in self.cals.items():
            for e in self.b.list_events(cal, now(), now() + timedelta(days=CFG["horizon_days"] + 30), private={"phone": phone}):
                if e["private"].get("bot") == "wathsbot":
                    out.append({"event_id": e["id"], "doctor": e["private"].get("doctor"), "especialidad": e["private"].get("specialty"),
                                "consultorio": name, "inicio": iso(e["start"]), "paciente": e["private"].get("patient")})
        return sorted(out, key=lambda x: x["inicio"])

    def _own(self, phone, event_id):
        return next((m for m in self.mine(phone) if m["event_id"] == event_id), None)

    def cancel(self, phone, event_id):
        with LOCK:
            m = self._own(phone, event_id)
            if not m:
                return {"error": "cita_no_encontrada"}
            self.b.delete(self.cals[m["consultorio"]], event_id)
            return {"ok": True, "cancelada": m}

    def reschedule(self, phone, event_id, new_start):
        with LOCK:
            m = self._own(phone, event_id)
        if not m:
            return {"error": "cita_no_encontrada"}
        r = self.book(phone, m["paciente"], m["especialidad"], new_start, ignore_id=event_id)
        if r.get("ok"):
            with LOCK:
                self.b.delete(self.cals[m["consultorio"]], event_id)
            r["reprogramada_desde"] = m["inicio"]
        return r


def iso(dt):
    return dt.astimezone(TZ).isoformat(timespec="minutes")


def parse_dt(s):
    dt = datetime.fromisoformat(s)
    return dt.replace(tzinfo=TZ) if dt.tzinfo is None else dt.astimezone(TZ)


# ---------- backend real (Google Calendar) ----------
class GoogleBackend:
    def __init__(self):
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build
        d = json.load(open(os.environ.get("GOOGLE_TOKEN_PATH", "/data/profiles/wathsbot/google_token.json")))
        self.creds = Credentials(**{k: d[k] for k in ("token", "refresh_token", "token_uri", "client_id", "client_secret")}, scopes=d["scopes"])
        self.creds.refresh(Request())
        self.svc = build("calendar", "v3", credentials=self.creds, cache_discovery=False)

    def list_events(self, cal, start, end, private=None):
        kw = dict(calendarId=cal, timeMin=start.isoformat(), timeMax=end.isoformat(), singleEvents=True, orderBy="startTime", maxResults=250)
        if private:
            kw["privateExtendedProperty"] = [f"{k}={v}" for k, v in private.items()]
        out = []
        for e in self.svc.events().list(**kw).execute().get("items", []):
            if e.get("status") == "cancelled":
                continue
            s, en = e["start"], e["end"]
            if "dateTime" in s:
                st, et = parse_dt(s["dateTime"]), parse_dt(en["dateTime"])
            else:  # evento de dia completo: bloquea el dia
                st = datetime.combine(date.fromisoformat(s["date"]), time(0), TZ)
                et = datetime.combine(date.fromisoformat(en["date"]), time(0), TZ)
            out.append({"id": e["id"], "summary": e.get("summary", ""), "start": st, "end": et,
                        "private": (e.get("extendedProperties") or {}).get("private", {}), "created": e.get("created", "")})
        return out

    def insert(self, cal, body):
        e = self.svc.events().insert(calendarId=cal, body=body).execute()
        return {"id": e["id"], "created": e.get("created", "")}

    def delete(self, cal, event_id):
        self.svc.events().delete(calendarId=cal, eventId=event_id).execute()
