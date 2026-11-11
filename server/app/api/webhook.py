"""`POST /webhooks/zernio`: entrada de los eventos de Zernio. Contrato: `docs/openapi.yaml`, operacion `zernioWebhook`.

Verifica la firma HMAC-SHA256 del cuerpo CRUDO, guarda el evento en la cola (idempotente) y responde en milisegundos;
el bot lo atiende despues. Detalles de Zernio (docs.zernio.com/webhooks, 2026-11-10): cabecera `X-Zernio-Signature`
(`X-Late-Signature` es un alias heredado), digest en hexadecimal minusculas, sin marca de tiempo. Reintenta 408/429/5xx y
timeouts; CUALQUIER otro 4xx (incluido el 401 de firma invalida) manda el evento a su cola de eventos muertos. Por eso un
servidor sin secreto configurado responde 503 (reintentable) y no 401.
"""
from __future__ import annotations

import hashlib
import hmac
import json

from flask import Blueprint, current_app, jsonify, request

from ..events import is_patient_message
from .common import error

bp = Blueprint("webhook", __name__)


def signature_ok(secret: str, raw: bytes, header: str) -> bool:
    """Compara en tiempo constante. Se tolera un prefijo `sha256=` y mayusculas; el digest siempre se calcula aqui."""
    given = header.strip().lower()
    if given.startswith("sha256="):
        given = given[7:]
    expected = hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected.encode("ascii"), given.encode("utf-8"))


@bp.post("/webhooks/zernio")
def zernio():
    secret = current_app.config.get("ZERNIO_WEBHOOK_SECRET") or ""
    if not secret:
        current_app.logger.error("webhook de Zernio recibido, pero ZERNIO_WEBHOOK_SECRET no esta configurado")
        return error("no_configurado", 503, "el servidor aun no tiene el secreto del webhook")
    raw = request.get_data()
    header = request.headers.get("X-Zernio-Signature") or request.headers.get("X-Late-Signature") or ""
    if not signature_ok(secret, raw, header):
        current_app.logger.warning("webhook de Zernio con firma ausente o invalida (%d bytes)", len(raw))
        return error("firma_invalida", 401)
    try:
        payload = json.loads(raw)
    except ValueError:
        return error("validacion", 422, "el cuerpo no es JSON")
    eid = payload.get("id") if isinstance(payload, dict) else None
    if isinstance(eid, int) and not isinstance(eid, bool):
        eid = str(eid)
    if not isinstance(eid, str) or not 0 < len(eid) <= 128 or not isinstance(payload.get("event"), str):
        return error("validacion", 422, "falta id o event")
    payload["id"] = eid
    if not is_patient_message(payload):  # webhook.test, mensajes salientes, standby, otras plataformas...
        return jsonify(ok=True, queued=False)
    if current_app.extensions["events"].enqueue(payload):
        return jsonify(ok=True, queued=True)
    return jsonify(ok=True, queued=False, duplicate=True)
