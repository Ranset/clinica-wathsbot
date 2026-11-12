"""Datos de la clinica para el prompt del bot, tomados de la API (sin copia local).

`system_prompt.md` conserva el estilo, la ubicacion, las reglas de seguridad y las "skills" (precios). Los
datos que CAMBIAN en la agenda (horario de la clinica, doctores y especialidades) los pone la API: asi, si el
personal cambia un horario o da de baja a un doctor, el bot lo sabe en el siguiente mensaje, sin tocar el bot.

Solo libreria estandar. Texto sin acentos, igual que `system_prompt.md`.
"""
import re

_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
_NAMES = {"mon": "lunes", "tue": "martes", "wed": "miercoles", "thu": "jueves", "fri": "viernes",
          "sat": "sabados", "sun": "domingos"}


def time12(h, m):
    """Hora de 24 h -> texto de 12 h con meridiano, como se la decimos al paciente: (13, 30) -> '1:30 PM'; (0, 5) -> '12:05 AM'."""
    h, m = int(h) % 24, int(m)
    return f"{h % 12 or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def _time(hhmm):
    h, m = str(hhmm).split(":")[:2]
    return time12(h, m)


def _ranges(ranges):
    return " y ".join(f"{_time(r['start'])} a {_time(r['end'])}" for r in ranges)


# --- red de seguridad: horas de 24 h en lo que va a leer el paciente ---------------------------------------------------
# El prompt le pide al modelo hablar en 12 h (AM/PM); si se le escapa un "16:30" o "09:00 hrs" se corrige aqui, sin
# adivinar. Solo se tocan las formas SIN ambiguedad: hora de 13 a 23, hora con cero a la izquierda ("09:30") o con "hrs"
# ("10:00 hrs"). Un "10:00" suelto no se toca (podria ser ya de 12 h). No toca fechas ISO ("2026-11-12T10:00").
_NOT_AFTER = r"(?<![\w:.])"
_NOT_BEFORE = r"(?![\d:])"
_SUFFIX = r"(?:\s*(?:hrs?\b\.?|horas?\b))?"
_HOUR24 = re.compile(_NOT_AFTER + r"(0\d|1[3-9]|2[0-3]):([0-5]\d)" + _NOT_BEFORE + r"(?!\s*[ap]\.?\s?m\b)" + _SUFFIX, re.I)
_HOUR_HRS = re.compile(_NOT_AFTER + r"(1?\d):([0-5]\d)" + _NOT_BEFORE + r"\s*hrs?\b\.?", re.I)


# una fecha-hora ISO completa ("2026-11-12T16:30-05:00") se deja intacta, desfase incluido ("-05:00" no es una hora)
_ISO = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)")


def to_12h(text):
    """Pasa a 12 h con meridiano las horas de 24 h inequivocas de un texto para el paciente (ver arriba)."""
    if not text:
        return text
    sub = lambda m: time12(m.group(1), m.group(2))
    parts = _ISO.split(text)  # con un grupo de captura: los tramos pares son texto, los impares son fechas ISO
    return "".join(p if i % 2 else _HOUR_HRS.sub(sub, _HOUR24.sub(sub, p)) for i, p in enumerate(parts))


def _day_list(days):
    """['mon','tue','wed','thu','fri'] -> 'lunes a viernes'; ['mon','wed'] -> 'lunes y miercoles'."""
    idx = sorted(_DAYS.index(d) for d in days)
    runs, cur = [], [idx[0]]
    for i in idx[1:]:
        if i == cur[-1] + 1:
            cur.append(i)
        else:
            runs.append(cur)
            cur = [i]
    runs.append(cur)
    parts = []
    for r in runs:
        names = [_NAMES[_DAYS[i]] for i in r]
        parts.append(names[0] if len(r) == 1 else f"{names[0]} y {names[1]}" if len(r) == 2 else f"{names[0]} a {names[-1]}")
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " y " + parts[-1]


def summarize_hours(weekly):
    """Horario semanal ({'mon': [{'start','end'}], ...}) -> 'lunes a viernes 9:00 AM a 6:00 PM, sabados 9:00 AM a 1:00 PM'
    (12 h con meridiano; los datos de la API vienen en 24 h). Vacio o sin dias abiertos -> ''."""
    by_key, order = {}, []
    for d in _DAYS:
        rs = (weekly or {}).get(d) or []
        if not rs:
            continue
        key = _ranges(rs)
        if key not in by_key:
            by_key[key] = []
            order.append(key)
        by_key[key].append(d)
    return ", ".join(f"{_day_list(by_key[k])} {k}" for k in order)


def _specialty(d):
    return (d.get("specialty") or "").strip().lower()


def compose_system(base, cfg):
    """Sustituye en `base` (el system_prompt.md) las lineas "Horario" y "Especialidades y doctores" por los datos
    VIGENTES de `cfg` (respuesta de GET /api/bot/config). Si `cfg` no trae `clinicHours` (servidor viejo) deja el
    texto como esta."""
    if not isinstance(cfg, dict):
        return base
    out = base
    hours = summarize_hours(cfg.get("clinicHours"))
    if "clinicHours" in cfg:
        line = ("- Horario: " + hours + ". No hay atencion los demas dias.") if hours else \
               "- Horario: no disponible por ahora; di que un miembro del equipo lo confirmara."
        special = []
        for d in cfg.get("doctors") or []:
            if d.get("usesClinicHours") is False and d.get("weeklyHours"):
                special.append(f"{d['name']}: {summarize_hours(d['weeklyHours'])}")
        if special:
            line += " Horarios propios de algunos doctores (prevalecen sobre el general): " + "; ".join(special) + "."
        out = _replace_line(out, r"^- Horario:.*$", line)
    docs = cfg.get("doctors")
    if isinstance(docs, list):
        if docs:
            items = ", ".join(f"{_specialty(d)} ({d['name']})" for d in docs)
            line = f"- Especialidades y doctores: {items}. No ofrezcas otras especialidades."
        else:
            line = ("- Especialidades y doctores: por ahora no hay doctores disponibles por este medio; "
                    "di que un miembro del equipo se pondra en contacto.")
        out = _replace_line(out, r"^- Especialidades y doctores:.*$", line)
    return out.replace("## Datos de referencia (ejemplo de prueba)", "## Datos de referencia (vigentes, de la agenda de la clinica)")


def _replace_line(text, pattern, line):
    new, n = re.subn(pattern, lambda _m: line, text, count=1, flags=re.M)
    return new if n else text.rstrip("\n") + "\n" + line + "\n"
