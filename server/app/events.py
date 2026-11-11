"""Cola de eventos de Zernio (F3): el servidor recibe el webhook, lo guarda, y el bot (sin IP publica) lo reclama
por una conexion saliente. Un reinicio del bot ya no pierde mensajes.

Estados de `webhook_events.status`:

    pending --claim--> claimed --ack--> done | skipped          (cerrado)
       ^                  |
       |<--fail(retry)----+--fail(sin reintento) o intentos agotados--> failed (+ caso de atencion)
       '--------- plazo vencido (el bot murio) ---------'

- **Idempotente**: `UNIQUE(zernio_event_id)`; Zernio puede entregar un evento varias veces.
- **Reclamo con plazo** (`claimed_until`): un evento reclamado cuyo plazo vence vuelve a ofrecerse. Cada reclamo cuenta un
  intento; al llegar a `max_attempts` el evento pasa a `failed` en vez de ofrecerse otra vez (evita un bucle infinito
  con un mensaje que siempre revienta) y aparece como caso de atencion.
- **Reclamo sin bloqueos especiales**: se eligen candidatos y cada uno se toma con un `UPDATE ... WHERE` condicional;
  si otro bot lo tomo antes, `rowcount` es 0 y se salta. Funciona igual en SQLite y MySQL.
- **Privacidad**: el webhook trae el texto del paciente (podria contar sintomas). Al cerrar un evento (`done`, `skipped`
  o `failed`) se BORRA el contenido y solo queda lo necesario para contactar a la persona (conversacion, telefono).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Callable

from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from .agenda.rules import Rules
from .agenda.uow import Unit
from .db import is_unique_violation, iso_utc, to_db
from .models import AttentionCase, WebhookEvent

#: resultado que informa el bot -> estado final del evento
OUTCOMES = {"replied": "done", "skipped_bot_inactive": "skipped", "skipped_ignored": "skipped"}
HANDOFF_REASONS = ("modelo_fallo", "accion_invalida", "pidio_persona", "fuera_de_alcance", "otro")
CLOSED = ("done", "skipped")


def is_patient_message(p: dict) -> bool:
    """Lo unico que se encola: `message.received` de WhatsApp, entrante, real y sin `metadata.standby`.
    (Misma regla que `Processor._is_patient_message` del bot y que el `do_POST` del bot antiguo.)"""
    m = p.get("message")
    if p.get("event") != "message.received" or p.get("test") or not isinstance(m, dict):
        return False
    md = m.get("metadata")
    return m.get("platform") == "whatsapp" and m.get("direction") == "incoming" and not (
        isinstance(md, dict) and md.get("standby"))


def routing(p: dict) -> tuple[str | None, str | None]:
    """(conversationId, telefono) de un evento, o None. El telefono es `message.sender.id` (digitos)."""
    m = p.get("message") if isinstance(p.get("message"), dict) else {}
    sender = m.get("sender") if isinstance(m.get("sender"), dict) else {}
    conv = str(m.get("conversationId") or "").strip()[:64] or None
    phone = str(sender.get("id") or "").strip()
    return conv, (phone if phone.isdigit() and 8 <= len(phone) <= 15 else None)


def redact(p: dict) -> dict:
    """Deja solo lo necesario para contactar y reconocer el evento; fuera el texto, adjuntos y nombres."""
    m = p.get("message") if isinstance(p.get("message"), dict) else {}
    out: dict = {"id": p.get("id"), "event": p.get("event"), "timestamp": p.get("timestamp"), "redacted": True}
    keep = {k: m[k] for k in ("conversationId", "platform", "direction") if k in m}
    if isinstance(m.get("sender"), dict) and "id" in m["sender"]:
        keep["sender"] = {"id": m["sender"]["id"]}
    if keep:
        out["message"] = keep
    acc = p.get("account")
    if isinstance(acc, dict):
        out["account"] = {k: acc[k] for k in ("accountId", "id") if k in acc}
    return out


class EventQueue(Unit):
    def __init__(self, session_factory: sessionmaker[Session], rules: Rules | None = None,
                 clock: Callable[[], datetime] | None = None, *, max_attempts: int = 5, backoff_seconds: int = 30):
        super().__init__(session_factory, rules, clock)
        self.max_attempts = max_attempts
        self.backoff_seconds = backoff_seconds

    def _utc(self) -> datetime:
        """Ahora en UTC ingenuo, a SEGUNDOS enteros: MySQL guarda DATETIME sin fracciones y REDONDEA (hasta 0,5 s hacia
        adelante), lo que haria distinto el comportamiento de plazos y esperas entre SQLite y MySQL."""
        return to_db(self.now()).replace(microsecond=0)

    # ------------------------------------------------------------------ entrada (webhook)
    def enqueue(self, payload: dict) -> bool:
        """Guarda el evento. True = encolado; False = ya existia (entrega duplicada)."""
        now = self._utc()

        def work(repo, s):
            s.add(WebhookEvent(zernio_event_id=str(payload["id"])[:128], event_type=str(payload["event"])[:64],
                               payload=payload, status="pending", received_at=now))
        try:
            self._write(work)
        except IntegrityError as e:
            if is_unique_violation(e):
                return False
            raise
        return True

    # ------------------------------------------------------------------ salida (bot)
    @staticmethod
    def _claimable(now: datetime):
        return or_(and_(WebhookEvent.status == "pending",
                        or_(WebhookEvent.claimed_until.is_(None), WebhookEvent.claimed_until <= now)),
                   and_(WebhookEvent.status == "claimed", WebhookEvent.claimed_until < now))

    def claim(self, limit: int = 5, lease_seconds: int = 120) -> list[dict]:
        """Eventos pendientes (o con el plazo vencido) en orden de llegada, ya marcados como reclamados."""
        def work(repo, s):
            now = self._utc()
            # un plazo vencido con los intentos agotados no se vuelve a ofrecer: pasa a `failed`
            for e in s.scalars(select(WebhookEvent).where(
                    WebhookEvent.status == "claimed", WebhookEvent.claimed_until < now,
                    WebhookEvent.attempts >= self.max_attempts).order_by(WebhookEvent.id)).all():
                self._mark_failed(s, e, f"sin respuesta del bot tras {e.attempts} intentos", now)
            s.flush()
            ids = list(s.scalars(select(WebhookEvent.id).where(self._claimable(now))
                                 .order_by(WebhookEvent.id).limit(limit)))
            until = now + timedelta(seconds=lease_seconds)
            taken = []
            for eid in ids:
                r = s.execute(update(WebhookEvent).where(WebhookEvent.id == eid, self._claimable(now))
                              .values(status="claimed", claimed_until=until, attempts=WebhookEvent.attempts + 1)
                              .execution_options(synchronize_session=False))
                if r.rowcount == 1:  # si otro bot lo tomo entre el SELECT y el UPDATE, no coincide y se salta
                    taken.append(eid)
            if not taken:
                return []
            rows = s.scalars(select(WebhookEvent).where(WebhookEvent.id.in_(taken)).order_by(WebhookEvent.id)).all()
            return [{"id": str(e.id), "zernioEventId": e.zernio_event_id, "payload": e.payload,
                     "attempts": e.attempts, "receivedAtUtc": iso_utc(e.received_at)} for e in rows]
        return self._write(work)

    @staticmethod
    def _get(s: Session, event_id) -> WebhookEvent | None:
        try:
            return s.get(WebhookEvent, int(event_id), with_for_update=True)
        except (TypeError, ValueError):
            return None

    def ack(self, event_id, outcome: str) -> bool:
        """Cierra un evento atendido. Idempotente (si el `ack` se perdio y se repite, sigue siendo 'cerrado').
        False = el evento no existe."""
        def work(repo, s):
            e = self._get(s, event_id)
            if e is None:
                return False
            if e.status in CLOSED:
                return True
            e.status, e.outcome = OUTCOMES[outcome], outcome
            e.claimed_until, e.processed_at = None, self._utc()
            e.payload = redact(e.payload)
            return True
        return self._write(work)

    def fail(self, event_id, reason: str, retry: bool = True) -> bool:
        """El bot no pudo atender el evento. Con `retry` vuelve a la cola tras una espera (crece con los intentos);
        sin `retry` o con los intentos agotados pasa a `failed` y se avisa a una persona. False = no existe."""
        reason = (reason or "")[:500]

        def work(repo, s):
            e = self._get(s, event_id)
            if e is None:
                return False
            if e.status in CLOSED or e.status == "failed":
                return True
            now = self._utc()
            if retry and e.attempts < self.max_attempts:
                e.status = "pending"
                e.claimed_until = now + timedelta(seconds=self.backoff_seconds * max(1, e.attempts))
                e.last_error = reason
            else:
                self._mark_failed(s, e, reason, now)
            return True
        return self._write(work)

    def _mark_failed(self, s: Session, e: WebhookEvent, reason: str, now: datetime) -> None:
        conv, phone = routing(e.payload)
        e.status, e.last_error, e.claimed_until, e.processed_at = "failed", reason[:500], None, now
        e.payload = redact(e.payload)
        s.add(AttentionCase(kind="event_failed", status="open", conversation_id=conv, phone=phone,
                            reason="mensaje_sin_atender", detail=reason[:500], event_id=e.id, created_at=now))

    # ------------------------------------------------------------------ traspaso a una persona
    def handoff(self, conversation_id: str, reason: str, phone: str | None = None, detail: str | None = None) -> int:
        """Registra que una persona debe atender la conversacion. Si ya hay un caso abierto de esa conversacion
        devuelve ese (el bot puede repetir el aviso sin llenar la lista)."""
        conv = str(conversation_id).strip()[:64]
        now = self._utc()

        def work(repo, s):
            open_case = s.scalars(select(AttentionCase).where(
                AttentionCase.kind == "handoff", AttentionCase.status == "open",
                AttentionCase.conversation_id == conv).order_by(AttentionCase.id.desc())).first()
            if open_case is not None:
                return open_case.id
            c = AttentionCase(kind="handoff", status="open", conversation_id=conv, phone=phone, reason=reason,
                              detail=(detail or None) and detail[:500], created_at=now)
            s.add(c)
            s.flush()
            return c.id
        return self._write(work)
