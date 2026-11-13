#!/usr/bin/env python3
"""Wathsbot: receives Zernio message.received webhooks and auto-replies on WhatsApp."""
import hashlib, hmac, json, os, re, sys, threading, time, unicodedata, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import clinic_info

BASE = "https://zernio.com/api/v1"
ZKEY = os.environ["ZERNIO_API_KEY"]
SECRET = os.environ.get("WATHSBOT_WEBHOOK_SECRET", "")
DRY_RUN = os.environ.get("WATHSBOT_DRY_RUN") == "1"
# De donde sale la agenda:
#   "google" (defecto, el bot de antes: Google Calendar via scheduler.py) o
#   "api"    (la API de la clinica: el bot trabaja como un empleado mas; doctores, horarios, citas, interruptor).
BACKEND = os.environ.get("WATHSBOT_BACKEND", "google")
# Por donde llegan los mensajes (solo importa con BACKEND=api):
#   "webhook" (defecto) Zernio -> este proceso (WATHSBOT_PORT); es como ya funciona el bot en produccion.
#   "queue"             Zernio -> servidor de la clinica -> cola; la consulta `poller.py` (no abre puerto).
INGRESS = os.environ.get("WATHSBOT_INGRESS", "webhook")
PORT = int(os.environ.get("WATHSBOT_PORT", "8787"))
# Canales que el bot atiende (por defecto SOLO WhatsApp: activar Messenger/Instagram es una decision explicita).
PLATFORMS = {x.strip() for x in os.environ.get("WATHSBOT_PLATFORMS", "whatsapp").split(",") if x.strip()}
CHANNEL_NAMES = {"whatsapp": "WhatsApp", "facebook": "Messenger de Facebook", "instagram": "Instagram"}
HERE = os.path.dirname(os.path.abspath(__file__))
SYSTEM = open(os.path.join(HERE, "system_prompt.md"), encoding="utf-8").read()
SEEN, GREETED, LOCK = set(), set(), threading.Lock()
_TL = threading.local()  # conversacion en curso y si ya se registro el traspaso en este turno
_CONV_LOCKS = {}  # un candado por conversacion: dos mensajes seguidos del mismo paciente se atienden de uno en uno


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def http(method, url, headers, body=None, timeout=40):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def zernio(method, path, body=None, headers=None):
    h = {"Authorization": f"Bearer {ZKEY}", "Content-Type": "application/json"}
    if headers:
        h.update(headers)
    return http(method, BASE + path, h, body)


def _zernio_send(path, body, key):
    """POST con Idempotency-Key. Si `zernio` fue sustituido por una funcion que no acepta cabeceras (simulaciones de
    prueba antiguas), se llama sin ellas: el contrato (method, path, body) no cambia para quien ya lo usa."""
    try:
        return zernio("POST", path, body, headers={"Idempotency-Key": key})
    except TypeError as e:
        if "headers" not in str(e):
            raise
        return zernio("POST", path, body)


def llm_cli(system, messages):
    """Same Claude subscription as the Hermes chat, via the claude CLI with NO tools."""
    import subprocess, tempfile
    convo = "\n".join(("Paciente: " if m["role"] == "user" else "Wathsbot: ") + m["content"] for m in messages)
    prompt = ("Conversacion hasta ahora:\n" + convo +
              "\n\nEscribe SOLO la siguiente respuesta de Wathsbot (texto a enviar por WhatsApp).")
    with tempfile.TemporaryDirectory() as d:
        r = subprocess.run([os.environ.get("CLAUDE_BIN", "/data/.local/bin/claude"), "-p", "--model", os.environ.get("WATHSBOT_MODEL", "sonnet"),
                            "--tools", "", "--system-prompt", system, prompt],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90, cwd=d)
    out = r.stdout.strip()
    if r.returncode != 0 or not out:
        raise RuntimeError("claude CLI failed: " + (r.stderr or out)[:200])
    return out


def llm(system, messages):
    if os.environ.get("WATHSBOT_LLM", "cli") == "cli":
        return llm_cli(system, messages)
    if os.environ.get("ANTHROPIC_API_KEY"):
        r = http("POST", "https://api.anthropic.com/v1/messages",
                 {"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01",
                  "content-type": "application/json"},
                 {"model": os.environ.get("WATHSBOT_MODEL", "claude-haiku-4-5"), "max_tokens": 400,
                  "system": system, "messages": messages})
        return r["content"][0]["text"].strip()
    if os.environ.get("OPENROUTER_API_KEY"):
        r = http("POST", "https://openrouter.ai/api/v1/chat/completions",
                 {"Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"], "Content-Type": "application/json"},
                 {"model": os.environ.get("WATHSBOT_MODEL", "anthropic/claude-haiku-4.5"), "max_tokens": 400,
                  "messages": [{"role": "system", "content": system}] + messages})
        return r["choices"][0]["message"]["content"].strip()
    raise RuntimeError("No ANTHROPIC_API_KEY or OPENROUTER_API_KEY configured")


def history(conv_id, account_id):
    """Best-effort recent history as alternating user/assistant messages."""
    try:
        r = zernio("GET", f"/inbox/conversations/{conv_id}/messages?accountId={account_id}&limit=12&sortOrder=desc")
        items = r.get("messages") or r.get("data") or []
        out = []
        for m in reversed(items):
            t = m.get("text") or m.get("message")
            if not t:
                continue
            role = "user" if m.get("direction") == "incoming" else "assistant"
            if out and out[-1]["role"] == role:
                out[-1]["content"] += "\n" + t
            else:
                out.append({"role": role, "content": t})
        return out
    except Exception as e:
        log("history unavailable:", e)
        return []


import api_client


def _tapped_button(m):
    """Messenger/Instagram: tocar 'Comenzar', un ice breaker o una respuesta rapida llega SIN texto pero con metadata."""
    md = m.get("metadata") or {}
    return any(md.get(k) for k in ("postbackPayload", "quickReplyPayload", "interactiveId")) and not (m.get("attachments") or [])


def _should_handle(ev):
    """Filtro de entrada del webhook: solo mensajes entrantes de los canales activados y que nadie mas atiende."""
    if ev.get("event") != "message.received" or ev.get("test"):
        return False
    m = ev.get("message") or {}
    if m.get("platform") not in PLATFORMS or m.get("direction") != "incoming":
        return False
    if (m.get("metadata") or {}).get("standby"):
        return False
    return True


def _prepare(ev):
    """Evento de Zernio -> (texto, conversacion, cuenta, telefono, historial, primer_mensaje)."""
    m, acc = ev["message"], ev["account"]
    text = m.get("text") or ""
    if not text.strip():
        text = ("[el usuario toco un boton de la pagina (por ejemplo, Comenzar)]" if _tapped_button(m)
                else "[el paciente envio un archivo o contenido sin texto]")
    conv_id, account_id = m["conversationId"], acc["accountId"] if "accountId" in acc else acc.get("id")
    msgs = history(conv_id, account_id)
    if not msgs or msgs[-1]["role"] != "user" or text not in msgs[-1]["content"]:
        msgs.append({"role": "user", "content": text})
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    with LOCK:
        first = conv_id not in GREETED and len(msgs) <= 1
        GREETED.add(conv_id)
    # Identidad = valor + CANAL (telefono en WhatsApp; id de Meta en Messenger/Instagram). Un `str` normal es WhatsApp.
    phone = api_client.Ident(str((m.get("sender") or {}).get("id") or "").strip(), m.get("platform") or "whatsapp")
    return text, conv_id, account_id, phone, msgs, first


def answer(msgs, phone, first=False):
    """Nucleo del bot: historial (termina con el mensaje del paciente) -> texto a enviar. NO envia nada.
    Con BACKEND=api toma doctores, horarios y limites de la API en CADA mensaje (si no responde lanza ApiUnavailable:
    nunca se contesta con datos viejos)."""
    ctx = _prompt_ctx() if BACKEND == "api" else None
    sys_prompt = clinic_info.compose_system(SYSTEM, ctx.API) if ctx else SYSTEM
    if first:
        sys_prompt += "\n\nEste es el PRIMER mensaje de la conversacion: aclara que eres un asistente automatico."
    if agenda_enabled() and (phone.isdigit() if api_client.canal_of(phone) == "whatsapp" else bool(phone)):
        return run_agent(sys_prompt, msgs, phone, ctx=ctx)
    sys_prompt += "\n\nResponde unicamente con el texto del mensaje a enviar."
    return llm(sys_prompt, msgs)


RETRY_SLEEP = 2  # segundos entre intentos de envio (x numero de intento)


def deliver(conv_id, account_id, reply, ev_id=None):
    """Envia la respuesta por Zernio. True si Zernio la acepto. Reintenta 2 veces los fallos de red/5xx/429 con la MISMA
    Idempotency-Key (Zernio no reintenta solo y un envio no es idempotente: asi un reintento nunca duplica el mensaje).
    Un 4xx (salvo 429) no se reintenta: no cambiara."""
    if DRY_RUN:
        return True
    key = hashlib.sha256(f"{ev_id}|{conv_id}|{reply}".encode()).hexdigest()[:48]
    last = "?"
    for attempt in range(1, 4):
        try:
            _zernio_send(f"/inbox/conversations/{conv_id}/messages", {"accountId": account_id, "message": reply}, key)
            return True
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if 400 <= e.code < 500 and e.code != 429:
                break
        except Exception as e:
            last = type(e).__name__
        if attempt < 3:
            time.sleep(RETRY_SLEEP * attempt)
    log(f"ENVIO FALLO conv={conv_id} ({last}): el paciente NO recibio la respuesta")
    return False


def _report_delivery_failure(conv_id, phone):
    """La respuesta no llego al paciente: que una persona lo sepa (antes solo quedaba una linea en el log)."""
    if BACKEND != "api":
        return
    try:
        _do_handoff(get_agenda(), conv_id, phone, "otro",
                    f"No se pudo enviar la respuesta del bot por {CHANNEL_NAMES.get(api_client.canal_of(phone), 'el chat')} (Zernio): el paciente no la recibio", tag="envio")
    except Exception as e:
        log(f"conv={conv_id} tampoco se pudo avisar del envio fallido: {e!r}")


def handle(ev):
    """Atiende un mensaje y lo envia. Lo usa `poller.py` (que ya revisa el interruptor y maneja los fallos de la API)."""
    text, conv_id, account_id, phone, msgs, first = _prepare(ev)
    reply = answer(msgs, phone, first)
    log(f"conv={conv_id} IN: {text[:80]!r} -> OUT: {reply[:120]!r}")
    deliver(conv_id, account_id, reply)
    return reply


def _norm(t):
    return "".join(c for c in unicodedata.normalize("NFD", str(t).lower()) if unicodedata.category(c) != "Mn")


# El paciente pide a una persona / la respuesta promete que el equipo lo contactara. Si eso pasa y NO se registro el
# traspaso en "Atencion", el codigo lo registra: prometer un aviso que nadie hizo es peor que no prometerlo.
HUMAN_RE = re.compile(r"((?<!ser )humano|humana|persona real|hablar con (una |un )?(persona|alguien|asesor|asesora|encargad|recepcion|agente)|"
                      r"(pasame|comunicame|ponme|transfiereme|conectame) con|con alguien del (equipo|personal)|"
                      r"asesor(a)? humano|recepcionista|personal de la clinica|con un agente)")
PROMISE_RE = re.compile(r"(voy a avisar|avisare|te aviso|notificare|voy a notificar|canalizare|voy a canalizar|"
                        r"(se|te) pondra(n)? en contacto|se comunicara|un miembro del equipo se|el equipo se)")
NO_NOTIFY = ("Intente avisar a un miembro del equipo, pero no pude registrar tu solicitud en este momento. "
             "Por favor vuelve a escribirme en unos minutos.")
HANDOFF_REASONS = ("pidio_persona", "fuera_de_alcance", "otro")


HANDOFF_DEDUP_S = int(os.environ.get("WATHSBOT_HANDOFF_DEDUP_S", "900"))
_HANDOFF_SEEN = {}  # (conversacion, causa) -> instante del ultimo registro EXITOSO
_HLOCK = threading.Lock()


def _now():
    return time.time()


def _do_handoff(ag, conv_id, phone, reason, detail="", tag=None):
    """Registra el caso en Atencion de la clinica. True solo si la API lo acepto (o ya hay uno reciente de la misma causa:
    sin esto, cada mensaje de un paciente con el bot en problemas abria otro caso identico)."""
    key = (id(ag), str(conv_id), tag or reason)  # por instancia de agenda: dos agendas distintas no comparten avisos
    with _HLOCK:
        t = _HANDOFF_SEEN.get(key)
        if t is not None and _now() - t < HANDOFF_DEDUP_S:
            _TL.handed = True
            log(f"HANDOFF conv={conv_id} causa={tag or reason}: ya hay un aviso reciente, no lo duplico")
            return True
    try:
        if api_client.canal_of(phone) == "whatsapp":
            ag.handoff(conv_id, reason, telefono=phone or None, detail=(detail or None))
        else:  # Messenger/Instagram: sin telefono; la API guarda canal + id para que el personal conteste desde el inbox
            ag.handoff(conv_id, reason, detail=(detail or None), canal=api_client.canal_of(phone), contacto_id=str(phone))
        with _HLOCK:
            _HANDOFF_SEEN[key] = _now()
            for k in [k for k, v in _HANDOFF_SEEN.items() if _now() - v >= HANDOFF_DEDUP_S]:
                del _HANDOFF_SEEN[k]
        _TL.handed = True
        log(f"HANDOFF conv={conv_id} motivo={reason} REGISTRADO")
        return True
    except Exception as e:
        _TL.tried = True
        log(f"HANDOFF conv={conv_id} motivo={reason} FALLO: {e!r}")
        return False


def _ensure_handoff(ag, conv_id, phone, msgs, reply):
    """Red de seguridad. Devuelve el texto a enviar (el mismo, o un aviso honesto si no se pudo registrar)."""
    if getattr(_TL, "handed", False):
        return reply
    if getattr(_TL, "tried", False):
        # la accion ya se intento y fallo: el modelo vio el error. Solo se corrige si aun asi promete un aviso.
        return NO_NOTIFY if PROMISE_RE.search(_norm(reply)) else reply
    last_user = next((m["content"] for m in reversed(msgs)
                      if m["role"] == "user" and not str(m["content"]).startswith("RESULTADO")), "")
    by_user = bool(HUMAN_RE.search(_norm(last_user)))
    by_reply = bool(PROMISE_RE.search(_norm(reply)))
    if not (by_user or by_reply):
        return reply
    reason = "pidio_persona" if by_user else "fuera_de_alcance"
    if _do_handoff(ag, conv_id, phone, reason, "Registrado por el codigo del bot (el modelo no uso la accion)"):
        return reply
    return NO_NOTIFY


MEDIA_OK = ("Recibi tu mensaje, pero por este medio no puedo ver fotos, audios ni archivos. Ya avise a un miembro del equipo "
            "para que lo revise y se ponga en contacto contigo. Mientras tanto, si quieres, te ayudo a agendar una cita o con "
            "informacion de horarios y ubicacion.")
MEDIA_FAIL = ("Recibi tu mensaje, pero por este medio no puedo ver fotos, audios ni archivos, y no pude avisar al equipo en este "
              "momento. Por favor escribe tu consulta en texto o vuelve a intentarlo en unos minutos.")


def media_info(m):
    """None si es un mensaje de texto normal. Si trae adjuntos o no trae texto: {kinds, has_text} (o {ignore} si es solo un sticker)."""
    atts = m.get("attachments") or []
    has_text = bool((m.get("text") or "").strip())
    kinds = []
    for a in atts:
        t = str((a or {}).get("type") or "archivo")
        if t not in kinds:
            kinds.append(t)
    if not atts and (has_text or _tapped_button(m)):
        return None
    if not atts:
        return {"kinds": ["contenido sin texto"], "has_text": False}
    if kinds and set(kinds) <= {"sticker", "share"} and not has_text:
        return {"kinds": kinds, "has_text": False, "ignore": True}
    return {"kinds": kinds, "has_text": has_text}


def reply_for(msgs, phone, conv_id, first=False, media=None):
    """Decision completa del bot para un mensaje -> texto a enviar, o None si NO debe contestar.
    Con BACKEND=api: (1) consulta el interruptor en la API (apagado -> None: atiende una persona);
    (2) si la API no responde NO ofrece horarios de memoria: envia FALLBACK; (3) si termina en FALLBACK
    avisa a una persona (traspaso) para que no se pierda el caso."""
    if BACKEND != "api":
        return answer(msgs, phone, first)
    import api_client
    ag = get_agenda()
    reason = "otro"
    _TL.conv_id, _TL.handed, _TL.tried = conv_id, False, False
    canal = api_client.canal_of(phone)
    _TL.platform = canal
    try:
        if not (ag.bot_active() if canal == "whatsapp" else ag.bot_active(canal)):  # un interruptor por canal
            log(f"conv={conv_id} interruptor del bot APAGADO para {canal}: no contesto")
            return None
        if media:
            if media.get("ignore"):
                log(f"conv={conv_id} solo un sticker: no contesto ni aviso")
                return None
            kinds = ", ".join(media["kinds"])
            ok = _do_handoff(ag, conv_id, phone, "otro", f"El paciente envio: {kinds}. El bot no puede ver archivos.", tag="adjunto")
            if not media["has_text"]:
                log(f"conv={conv_id} mensaje sin texto ({kinds}): aviso a una persona {'OK' if ok else 'FALLO'}; el modelo no interviene")
                return MEDIA_OK if ok else MEDIA_FAIL
            note = ("\n[Sistema: el paciente tambien envio " + kinds + ", que no puedes ver. " +
                    ("Un miembro del equipo ya fue avisado y lo revisara: dilo brevemente." if ok else
                     "NO se pudo avisar al equipo: dile que no pudiste registrarlo y que vuelva a escribir en unos minutos.") + "]")
            msgs = msgs[:-1] + [dict(msgs[-1], content=msgs[-1]["content"] + note)]
        reply = answer(msgs, phone, first)
    except api_client.ApiUnavailable as e:
        log(f"conv={conv_id} la API de la clinica no responde ({e}): paso el caso a una persona")
        reply = FALLBACK
    except Exception as e:  # el modelo fallo (CLI caido, tiempo agotado...): mejor avisar que quedarse callado
        log(f"conv={conv_id} fallo el modelo: {e!r}: paso el caso a una persona")
        reply, reason = FALLBACK, "modelo_fallo"
    if reply == FALLBACK:
        if not _TL.handed:
            _do_handoff(ag, conv_id, phone, reason, "El bot envio el mensaje de respaldo", tag="respaldo")
        return reply
    return _ensure_handoff(ag, conv_id, phone, msgs, reply)


def handle_direct(ev):
    """Zernio -> este proceso (webhook directo): contesta con las reglas de `reply_for`."""
    text, conv_id, account_id, phone, msgs, first = _prepare(ev)
    with LOCK:
        lock = _CONV_LOCKS.setdefault(conv_id, threading.Lock())
    with lock:
        reply = reply_for(msgs, phone, conv_id, first, media=media_info(ev["message"]))
    if reply is None:
        return None
    log(f"conv={conv_id} IN: {text[:80]!r} -> OUT: {reply[:120]!r}")
    if not deliver(conv_id, account_id, reply, ev.get("id")):
        _report_delivery_failure(conv_id, phone)
    return reply


# ---------------- agenda: el modelo propone, el codigo ejecuta ----------------
_AGENDA = None
FALLBACK = "Disculpa, tuve un problema para revisar la agenda. Un miembro del equipo se pondra en contacto contigo para ayudarte con tu cita."


def agenda_enabled():
    if BACKEND == "api":
        return True  # el interruptor del bot y la disponibilidad de la API los controla poller.py
    import scheduler
    return not any("PENDIENTE" in c for c in scheduler.CFG["consultorios"].values())


def get_agenda():
    global _AGENDA
    if _AGENDA is None:
        if BACKEND == "api":
            import api_client
            _AGENDA = api_client.ApiAgenda()
        else:
            import scheduler
            _AGENDA = scheduler.Agenda(scheduler.GoogleBackend())
    return _AGENDA


def _prompt_ctx():
    """Doctores y limites para el prompt: de la API (sin copia: si cae, lanza ApiUnavailable) o de scheduler.py.
    Devuelve algo con `.CFG` y `.now()` para no tocar el texto del prompt; con la API ademas `.API` (la respuesta
    cruda de /api/bot/config: horarios y doctores vigentes)."""
    if BACKEND != "api":
        import scheduler
        return scheduler
    from datetime import datetime
    from types import SimpleNamespace
    from zoneinfo import ZoneInfo
    c = get_agenda().config()
    tz = ZoneInfo(c["timezone"])
    cfg = {"timezone": c["timezone"], "slot_minutes": c["slotMinutes"], "min_notice_minutes": c["minNoticeMinutes"],
           "horizon_days": c["horizonDays"],
           # por nombre (no por especialidad): dos doctores de la misma especialidad no se pisan
           "doctors": {d["name"]: {"label": d["specialty"], "name": d["name"]} for d in c["doctors"]}}
    return SimpleNamespace(CFG=cfg, now=lambda: datetime.now(tz), API=c)


def agenda_prompt(S=None):
    S = S or _prompt_ctx()
    docs = "\n".join(f"- {d['label']}: {d['name']}" for d in S.CFG["doctors"].values())
    n = S.now()
    dias = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"]
    return f"""

## AGENDA AUTOMATICA (esta seccion tiene prioridad sobre "Ayudar a agendar")
Ahora puedes agendar, consultar, reprogramar y cancelar citas TU MISMO usando acciones. Hoy es {dias[n.weekday()]} {n.date().isoformat()}, hora local {clinic_info.time12(n.hour, n.minute)} (zona {S.CFG['timezone']}). Citas de {S.CFG['slot_minutes']} minutos.
Doctores:
{docs}

FORMATO DE SALIDA (obligatorio): responde SIEMPRE un unico objeto JSON y nada mas:
{{"reply": "texto para el paciente o null", "action": null o {{"name": ...}}}}
Acciones (una por turno):
- {{"name":"horarios","especialidad":"...","desde":"AAAA-MM-DD","hora_min":13,"hora_max":18,"dias":7}}  -> consulta huecos libres reales. desde, hora_min, hora_max (numeros de hora local en 24 h: 13 = 1:00 PM) y dias son opcionales. Por defecto devuelve pocos horarios, solo los primeros de cada dia: NO es la lista completa.
- {{"name":"agendar","especialidad":"...","nombre":"Nombre Apellido","inicio":"AAAA-MM-DDTHH:MM"}}
- {{"name":"cercanos","especialidad":"...","fecha_hora":"AAAA-MM-DDTHH:MM"}}  -> cuando el paciente pide un dia y hora concretos: devuelve "exacto" (true si ese horario esta libre) y los 3 huecos libres mas cercanos
- {{"name":"mis_citas"}}
- {{"name":"cancelar","event_id":"..."}}
- {{"name":"reprogramar","event_id":"...","inicio":"AAAA-MM-DDTHH:MM"}}
- {{"name":"pasar_a_persona","motivo":"pidio_persona","detalle":"resumen breve sin datos medicos"}}  -> registra el caso en la bandeja de Atencion del equipo (motivo: pidio_persona | fuera_de_alcance | otro)
Si usas una accion, pon reply en null: veras el RESULTADO y entonces redactas la respuesta final con action null.

REGLAS DE AGENDA (obligatorias):
0. FLUJO PARA AGENDAR: primero pregunta al paciente que dia y horario le acomoda (no le des una lista de entrada). Con un dia y hora concretos usa "cercanos": si "exacto" es true, propon ese horario y pide confirmacion; si es false, di que ese horario no esta libre y ofrece los horarios que devolvio (los mas cercanos). Si el paciente dice "cualquier dia", "lo mas pronto" o no sabe, usa "horarios" y ofrece 2 o 3. Si la peticion es ambigua (ej. "la proxima semana", "en la tarde") pregunta un dia concreto o usa "horarios" con el rango, sin suponer una hora exacta.
0b. LIMITES: solo se agenda con al menos {S.CFG['min_notice_minutes']} minutos de antelacion y hasta {S.CFG['horizon_days']} dias a futuro (hasta el {(n + __import__('datetime').timedelta(days=S.CFG['horizon_days'])).date().isoformat()}). Nunca prometas ni intentes agendar fuera de ese rango; explica el limite con amabilidad y ofrece una fecha valida.
1. NUNCA inventes ni supongas horarios: ofrece solo los que devuelva "horarios". Ofrece 2 o 3 y espera que el paciente elija uno.
1b. Si el paciente pide una preferencia (tarde, despues del mediodia, manana temprano, otro dia, un dia concreto, una hora concreta), VUELVE A CONSULTAR "horarios" con hora_min/hora_max/desde que correspondan. NUNCA digas que no hay disponibilidad sin haberlo consultado con ese criterio: la lista anterior es solo una muestra parcial. "Mediodia/tarde" = hora_min 12; "manana" (parte del dia) = hora_max 12. Si el resultado trae "nota" o horarios vacios, entonces si dilo y ofrece ampliar (otros dias).
2. Solo ejecuta "agendar" cuando tengas: especialidad, nombre completo y un horario que el paciente eligio de forma explicita. Si falta algo, pregunta. Si ofreciste varios horarios y el paciente responde solo "si", "ese", "confirmo" o "el primero que dijiste" sin que quede claro cual, NO agendes: pregunta cual de los horarios ofrecidos prefiere (repitelos). Nunca elijas tu por el paciente.
3. Para cancelar o reprogramar, usa primero "mis_citas" y confirma con el paciente cual cita es. Solo existen las citas del propio paciente; nunca hables de citas de otras personas.
4. Tras agendar, confirma doctor, especialidad, dia, hora (en 12 h con AM/PM, regla 7) y consultorio EXACTAMENTE como los devuelve el RESULTADO. Si el RESULTADO es un error, explica sin tecnicismos y ofrece otro horario (consulta "horarios" de nuevo).
5. No guardes ni pidas sintomas o motivos medicos; solo nombre, especialidad y horario.
6. Si la especialidad no esta en la lista, di que no la ofrecemos por este medio y que el equipo confirmara. Si la agenda falla, di que el equipo se pondra en contacto.
7. HORAS EN 12 H: todo lo que le escribas al paciente (dias y horas) va en espanol natural y con hora de 12 h con AM/PM, ej. "martes 11 de noviembre a las 10:00 AM", "jueves 13 a las 4:30 PM" (12:00 PM es el mediodia). NUNCA uses formato ISO ni de 24 h con el paciente (nada de "16:30" ni "16:30 hrs"). Solo las acciones usan 24 h (inicio, fecha_hora, hora_min, hora_max): conviertes tu; si el RESULTADO trae 13:30, se lo dices como 1:30 PM. Si el paciente da una hora sin AM/PM ("a las 4", "a las 10"), deducela por el horario de atencion (la clinica no atiende de madrugada ni de noche: "a las 4" es 4:00 PM y "a las 10" es 10:00 AM); si aun asi es ambigua, preguntale si AM o PM. Al confirmar un horario, repite siempre la hora con AM/PM.
8. TRASPASO A UNA PERSONA: si el paciente pide hablar con una persona, o no puedes ayudarlo (queja, algo fuera de alcance, un precio que no tienes) y vas a decir que el equipo lo contactara, PRIMERO usa la accion "pasar_a_persona". Solo di que avisaste al equipo si el RESULTADO es ok. Si es un error, dile que no pudiste registrar su solicitud y que vuelva a escribir en unos minutos. NUNCA prometas "voy a avisar" sin haber usado esa accion. En "detalle" no pongas sintomas ni datos medicos.
9. NUNCA afirmes que el paciente tiene una cita (ni su fecha, hora o doctor) sin haber usado "mis_citas" en ESTE turno. Lo dicho antes en el chat puede estar desactualizado: la unica fuente de verdad es el RESULTADO de "mis_citas".
"""


AGENDA_ACTIONS = ("horarios", "cercanos", "agendar", "mis_citas", "cancelar", "reprogramar")


def run_action(act, phone):
    if act.get("name") in AGENDA_ACTIONS and not phone:
        log(f"ACTION {act.get('name')} BLOQUEADA: sin identidad del remitente")
        return {"error": "sin_identidad", "detalle": "No se pudo identificar a la persona. Usa pasar_a_persona."}
    if BACKEND == "api":
        import api_client as S  # solo se usa S.parse_dt
    else:
        import scheduler as S
    ag = get_agenda()
    n = act.get("name")
    if n == "horarios":
        d = None
        if act.get("desde"):
            d = S.parse_dt(act["desde"] + ("T00:00" if len(act["desde"]) == 10 else "")).date()
        def hr(x):
            try:
                return float(x)
            except Exception:
                return None
        return ag.free_slots(act.get("especialidad", ""), from_day=d, hora_min=hr(act.get("hora_min")), hora_max=hr(act.get("hora_max")),
                             days=int(act.get("dias") or 7), limit=6)
    if n == "cercanos":
        return ag.nearest(act.get("especialidad", ""), S.parse_dt(act["fecha_hora"]))
    if n == "agendar":
        extra = {}
        if api_client.canal_of(phone) != "whatsapp":
            tc = re.sub(r"[\s().+-]", "", str(act.get("telefono_contacto") or ""))
            if not (tc.isdigit() and 8 <= len(tc) <= 15):
                return {"ok": False, "error": "falta_telefono", "detalle": "Pide a la persona un telefono de contacto valido (8 a 15 digitos) y vuelve a intentar agendar con telefono_contacto."}
            extra["telefono_contacto"] = tc
        return ag.book(phone, (act.get("nombre") or "").strip(), act.get("especialidad", ""), S.parse_dt(act["inicio"]), **extra)
    if n == "mis_citas":
        return {"citas": ag.mine(phone)}
    if n == "cancelar":
        return ag.cancel(phone, act.get("event_id", ""))
    if n == "reprogramar":
        return ag.reschedule(phone, act.get("event_id", ""), S.parse_dt(act["inicio"]))
    if n == "pasar_a_persona":
        if BACKEND != "api":
            return {"error": "no_disponible"}
        reason = act.get("motivo") if act.get("motivo") in HANDOFF_REASONS else "otro"
        ok = _do_handoff(ag, getattr(_TL, "conv_id", None), phone, reason, str(act.get("detalle") or "")[:300])
        return {"ok": True} if ok else {"error": "no_se_pudo_avisar"}
    return {"error": "accion_desconocida"}


def parse_model_json(s):
    a, b = s.find("{"), s.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        return json.loads(s[a:b + 1])
    except Exception:
        return None


def channel_prompt(canal):
    """Solo Messenger/Instagram: la agenda es la misma que en WhatsApp; cambia como se identifica a la persona."""
    if canal == "whatsapp":
        return ""
    name = CHANNEL_NAMES.get(canal, canal)
    return f"""
## CANAL: {name} (aplica a TODO lo anterior; lo que diga el texto base sobre WhatsApp se refiere ahora a {name})
Atiendes por {name}: tienes las MISMAS funciones que en WhatsApp (agendar, consultar, reprogramar, cancelar, precios, traspaso a una persona).
- No conoces el telefono de la persona. Para AGENDAR pide, ademas de nombre, especialidad y horario, un telefono de contacto (con lada) y mandalo en la accion agendar como "telefono_contacto": {{"name":"agendar", ..., "telefono_contacto":"9981234567"}}. Sin el, no agendes.
- Las citas que consultes, cambies o canceles son solo las de esta misma cuenta de {name}. Si la persona dice que agendo antes desde otro medio (WhatsApp, telefono), no las veras: dile que el equipo lo revisara y usa pasar_a_persona.
- Cuando se pase a una persona, el equipo respondera por este mismo chat de {name}: dilo asi, sin pedir que escriba a otro lado.
- No menciones WhatsApp ni mandes a la persona a otro canal.
"""


def run_agent(sys_prompt, msgs, phone, max_steps=4, ctx=None):
    sys_prompt += agenda_prompt(ctx) + channel_prompt(api_client.canal_of(phone))
    msgs = list(msgs)
    for _ in range(max_steps):
        raw = llm(sys_prompt, msgs)
        data = parse_model_json(raw)
        if data is None:
            # el modelo respondio texto plano: es seguro enviarlo solo si no parece JSON
            return clinic_info.to_12h(raw) if not raw.lstrip().startswith(("{", "[")) else FALLBACK
        act = data.get("action")
        if not act:
            # lo que lee el paciente va en 12 h con AM/PM: si al modelo se le escapo una hora de 24 h, se corrige
            return clinic_info.to_12h((data.get("reply") or "").strip()) or FALLBACK
        try:
            res = run_action(act, phone)
        except Exception as e:
            log("action error:", repr(e))
            res = {"error": "agenda_no_disponible"}
        log(f"ACTION {act.get('name')} -> {json.dumps(res, ensure_ascii=False)[:160]}")
        msgs.append({"role": "assistant", "content": json.dumps(data, ensure_ascii=False)})
        msgs.append({"role": "user", "content": "RESULTADO (sistema, no es el paciente): " + json.dumps(res, ensure_ascii=False)})
    return FALLBACK


def valid_sig(raw, headers):
    if not SECRET:
        return False
    want = hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    for k, v in headers.items():
        if "signature" in k.lower() or k.lower() in ("x-zernio-secret", "x-webhook-secret"):
            if hmac.compare_digest(v.replace("sha256=", "").strip().lower(), want):
                return True
    return False


class H(BaseHTTPRequestHandler):
    def _send(self, code, body=b"ok"):
        self.send_response(code); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        self._send(200, b'{"status":"ok"}')

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if not valid_sig(raw, dict(self.headers)):
            log("REJECTED bad/missing signature; headers:", [k for k in self.headers.keys()])
            return self._send(401, b"bad signature")
        self._send(200)
        try:
            ev = json.loads(raw)
            if ev.get("test"):
                log("test event received OK")
                return
            if not _should_handle(ev):
                return
            with LOCK:
                if ev["id"] in SEEN:
                    return
                SEEN.add(ev["id"])
            threading.Thread(target=self._safe, args=(ev,), daemon=True).start()
        except Exception as e:
            log("error parsing:", e)

    def _safe(self, ev):
        try:
            handle_direct(ev)
        except Exception as e:
            log("handler error:", repr(e))

    def log_message(self, *a):
        pass


def startup_report():
    """Una linea que dice con que agenda trabaja el bot (y si la API responde AHORA). No tumba el arranque."""
    if BACKEND != "api":
        return "agenda=Google Calendar (scheduler.py)"
    import api_client
    try:
        ag = get_agenda()
        cfg = ag.config()
        sw = " ".join(f"{c}={'ACTIVO' if (ag.bot_active() if c == 'whatsapp' else ag.bot_active(c)) else 'apagado'}"
                      for c in ("whatsapp", "facebook", "instagram") if c in PLATFORMS)
        active = "ACTIVO" in sw
        return (f"agenda=API {ag.base} OK | bot por canal: {sw}{'' if active else ' | bot APAGADO (no contestara)'} | "
                f"{len(cfg['doctors'])} doctores | horario: {clinic_info.summarize_hours(cfg.get('clinicHours')) or '?'}")
    except api_client.ApiUnavailable as e:
        return f"agenda=API NO RESPONDE ({e}): hasta que responda el bot enviara el mensaje de respaldo"


if __name__ == "__main__":
    if BACKEND == "api" and INGRESS == "queue":
        sys.exit("Con WATHSBOT_INGRESS=queue el bot NO recibe webhooks (los recibe el servidor de la clinica y los "
                 "encola): ejecuta `python poller.py`.")
    log(f"Wathsbot listening on :{PORT} dry_run={DRY_RUN} secret={'set' if SECRET else 'MISSING'} "
        f"backend={BACKEND} ingress={'webhook' if BACKEND != 'api' else INGRESS}")
    log(startup_report())
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
