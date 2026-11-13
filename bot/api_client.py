"""Cliente de la API de la clinica para el bot (F5). Solo libreria estandar.

`ApiAgenda` expone la MISMA interfaz que `scheduler.Agenda` (free_slots, nearest, book, mine, cancel,
reschedule) para que `server.run_action` no cambie, y ademas la cola de eventos y el interruptor del bot.
Contrato: `docs/openapi.yaml` (secciones `bot` y `webhook`).

Reglas que este modulo impone:
- Los errores de NEGOCIO que trae el contrato (404/409/422 con `{"error": "<codigo>"}`) se devuelven como
  diccionario, igual que hoy `scheduler.py`, para que el modelo los explique al paciente.
- Cualquier otra cosa (red, timeout, 5xx, 401/403/429, cuerpo que no es JSON) lanza `ApiUnavailable`: el
  bot NO inventa horarios ni usa copias; `run_action` lo convierte en `agenda_no_disponible`.
- Para no cambiar el prompt del modelo, las citas se devuelven tambien con la clave heredada `event_id`
  (= `cita_id` del contrato). Se podra quitar cuando se retire `scheduler.py`.

Entorno: CLINICA_API_URL (p. ej. https://clinica.ejemplo.com), CLINICA_BOT_TOKEN (nunca se imprime),
CLINICA_API_TIMEOUT (segundos, 10 por defecto).
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from zoneinfo import ZoneInfo

TZ = ZoneInfo(os.environ.get("TIMEZONE", "America/Cancun"))


CHANNELS = ("whatsapp", "facebook", "instagram")


class Ident(str):
    """Quien escribe: el valor (telefono en WhatsApp; id de Meta en Messenger/Instagram) MAS el canal.
    Un `str` normal es siempre WhatsApp, asi todo el codigo y las pruebas que ya existian siguen igual."""
    canal = "whatsapp"

    def __new__(cls, value, canal="whatsapp"):
        o = super().__new__(cls, value)
        o.canal = canal
        return o


def canal_of(ident):
    return getattr(ident, "canal", "whatsapp")


def _who(ident):
    """Parametros de identidad para la API. WhatsApp: EXACTAMENTE lo de siempre (`telefono`). Otros canales: `canal` +
    `contacto_id`. Nunca se manda un id de Meta como si fuera un telefono."""
    c = canal_of(ident)
    if c == "whatsapp":
        return {"telefono": str(ident)}
    return {"canal": c, "contacto_id": str(ident)}


class ApiUnavailable(Exception):
    """La API no se pudo usar (red, 5xx, credenciales, respuesta inesperada). `status` es el HTTP si lo hubo."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def parse_dt(s):
    """'AAAA-MM-DDTHH:MM' (sin desfase = hora de Cancun) -> datetime con zona. Igual que scheduler.parse_dt."""
    dt = datetime.fromisoformat(s)
    return dt.replace(tzinfo=TZ) if dt.tzinfo is None else dt.astimezone(TZ)


def _iso(dt):
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return dt.astimezone(TZ).isoformat(timespec="minutes")


def _legacy(cita):
    """Cita del contrato -> cita con la clave heredada `event_id` que usa el prompt del bot."""
    out = dict(cita)
    out["event_id"] = out.get("cita_id")
    return out


class ApiAgenda:
    def __init__(self, base_url=None, token=None, timeout=None):
        self.base = (base_url or os.environ.get("CLINICA_API_URL", "")).rstrip("/")
        self._token = token or os.environ.get("CLINICA_BOT_TOKEN", "")
        if not self.base or not self._token:
            raise ApiUnavailable("falta CLINICA_API_URL o CLINICA_BOT_TOKEN")
        self.timeout = float(timeout or os.environ.get("CLINICA_API_TIMEOUT", "10"))

    def __repr__(self):  # nunca mostrar el token
        return f"ApiAgenda({self.base!r})"

    # ---------------------------------------------------------------- transporte
    def _call(self, method, path, params=None, body=None, retry_get=True):
        """-> (status, dict). Devuelve el cuerpo JSON de 2xx y de 4xx de negocio; lanza ApiUnavailable si no."""
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Authorization": "Bearer " + self._token, "Accept": "application/json",
                   "User-Agent": "wathsbot-api-client"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        attempts = 2 if (method == "GET" and retry_get) else 1  # solo las lecturas se reintentan
        last = None
        for _ in range(attempts):
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    return r.status, self._json(r.read(), r.status)
            except urllib.error.HTTPError as e:
                raw = e.read()
                if e.code in (404, 409, 422):
                    body_json = self._json(raw, e.code)
                    if isinstance(body_json, dict) and body_json.get("error"):
                        return e.code, body_json
                raise ApiUnavailable(f"{method} {path} -> HTTP {e.code}", e.code)
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                last = ApiUnavailable(f"{method} {path} -> {type(e).__name__}: {e}")
        raise last

    @staticmethod
    def _json(raw, status):
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except ValueError:
            raise ApiUnavailable(f"respuesta no JSON (HTTP {status})", status)

    # ---------------------------------------------- misma interfaz que scheduler.Agenda
    def free_slots(self, specialty, from_day=None, days=7, limit=6, hora_min=None, hora_max=None):
        """Accion `horarios`. `limit` lo fija el servidor (6): se acepta para ser intercambiable."""
        _, r = self._call("GET", "/api/bot/availability", {
            "especialidad": specialty, "desde": from_day.isoformat() if isinstance(from_day, date) else None,
            "hora_min": hora_min, "hora_max": hora_max, "dias": days})
        return r

    def nearest(self, specialty, target, limit=3, window_days=7):
        """Accion `cercanos`. `limit` y `window_days` los fija el servidor."""
        _, r = self._call("GET", "/api/bot/nearest", {"especialidad": specialty, "fecha_hora": _iso(target)})
        return r

    def book(self, phone, patient_name, specialty, start, ignore_id=None, telefono_contacto=None):
        """Accion `agendar`. (`ignore_id` solo existia para reprogramar en scheduler.py; aqui es atomico en el servidor.)
        `telefono_contacto` (opcional, solo canales distintos de WhatsApp): para que el equipo pueda llamar al paciente."""
        body = dict(_who(phone), nombre=patient_name, especialidad=specialty, inicio=_iso(start))
        if telefono_contacto and canal_of(phone) != "whatsapp":
            body["telefono_contacto"] = str(telefono_contacto)
        _, r = self._call("POST", "/api/bot/appointments", body=body)
        return _legacy(r) if r.get("ok") else r

    def mine(self, phone):
        """Accion `mis_citas`: lista de citas futuras de ese telefono."""
        _, r = self._call("GET", "/api/bot/appointments", _who(phone))
        if "citas" not in r:
            raise ApiUnavailable("respuesta inesperada de mis_citas: " + str(r)[:120])
        return [_legacy(c) for c in r["citas"]]

    def cancel(self, phone, event_id):
        """Accion `cancelar`."""
        _, r = self._call("POST", f"/api/bot/appointments/{urllib.parse.quote(str(event_id), safe='')}/cancel",
                          body=_who(phone))
        if r.get("ok") and isinstance(r.get("cancelada"), dict):
            r = dict(r, cancelada=_legacy(r["cancelada"]))
        return r

    def reschedule(self, phone, event_id, new_start):
        """Accion `reprogramar`: atomica en el servidor; si falla, la cita original se conserva."""
        _, r = self._call("POST", f"/api/bot/appointments/{urllib.parse.quote(str(event_id), safe='')}/reschedule",
                          body=dict(_who(phone), inicio=_iso(new_start)))
        return _legacy(r) if r.get("ok") else r

    # ------------------------------------------------------------- configuracion e interruptor
    def config(self):
        """Doctores activos y limites (para `agenda_prompt`). Sin copia: si la API cae, lanza ApiUnavailable."""
        return self._call("GET", "/api/bot/config")[1]

    def bot_active(self, canal="whatsapp"):
        """Interruptor del personal, UNO POR CANAL (`channels: {whatsapp, facebook, instagram}`). Cualquier fallo lanza
        ApiUnavailable (nunca se asume 'activo'). Compatibilidad: una API vieja solo trae `active` (= WhatsApp); para
        cualquier otro canal que la API no mencione la respuesta es False: el bot NO contesta por canales que su API no conoce."""
        r = self._call("GET", "/api/bot/status")[1]
        ch = r.get("channels")
        if isinstance(ch, dict) and canal in ch:
            if not isinstance(ch[canal], bool):
                raise ApiUnavailable("respuesta inesperada de /api/bot/status: " + str(r)[:120])
            return ch[canal]
        if canal == "whatsapp":
            if not isinstance(r.get("active"), bool):
                raise ApiUnavailable("respuesta inesperada de /api/bot/status: " + str(r)[:120])
            return r["active"]
        return False

    # ------------------------------------------------------------------ cola de eventos
    def claim(self, limit=5, lease_seconds=120):
        """Reclama eventos pendientes: [{id, zernioEventId, payload, attempts, ...}]."""
        _, r = self._call("POST", "/api/bot/events/claim", body={"limit": limit, "leaseSeconds": lease_seconds})
        if not isinstance(r.get("events"), list):
            raise ApiUnavailable("respuesta inesperada de claim: " + str(r)[:120])
        return r["events"]

    def ack(self, event_id, outcome):
        """outcome: replied | skipped_bot_inactive | skipped_ignored."""
        self._call("POST", f"/api/bot/events/{urllib.parse.quote(str(event_id), safe='')}/ack", body={"outcome": outcome})

    def fail(self, event_id, reason, retry=True):
        self._call("POST", f"/api/bot/events/{urllib.parse.quote(str(event_id), safe='')}/fail",
                   body={"reason": str(reason)[:500], "retry": bool(retry)})

    def handoff(self, conversation_id, reason, telefono=None, detail=None, canal=None, contacto_id=None):
        """Pasa la conversacion a una persona. reason: modelo_fallo|accion_invalida|pidio_persona|fuera_de_alcance|otro.
        Otros canales: `canal` + `contacto_id` (sin `telefono`); WhatsApp sigue mandando solo `telefono`."""
        body = {"conversationId": str(conversation_id), "reason": reason}
        if canal and canal != "whatsapp":
            body["canal"] = canal
            if contacto_id:
                body["contacto_id"] = str(contacto_id)
        elif telefono:
            body["telefono"] = telefono
        if detail:
            body["detail"] = str(detail)[:500]
        self._call("POST", "/api/bot/handoffs", body=body)
