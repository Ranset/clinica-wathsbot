#!/usr/bin/env python3
"""Simula que un paciente escribe por WhatsApp: manda al servidor LOCAL un webhook de Zernio FIRMADO (como lo haria Zernio).

    .venv/Scripts/python scripts/dev_webhook.py "Hola, quiero una cita de proctologia"
    .venv/Scripts/python scripts/dev_webhook.py "Hola" --phone 5219981110050 --conv conv-prueba-2

El mensaje queda en la cola de eventos; lo atiende el bot (`bot/poller.py`) si esta corriendo. Sirve para ver el webhook, la firma y
la cola sin tener WhatsApp ni Zernio. Usa el secreto de desarrollo de `dev_server.py`.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import sys
import time
import urllib.error
import urllib.request

SECRET = "secreto-de-desarrollo"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("text", help="texto del mensaje del paciente")
    ap.add_argument("--phone", default="5219981110050", help="telefono del paciente (digitos con lada)")
    ap.add_argument("--conv", default="conv-dev-prueba", help="id de la conversacion")
    ap.add_argument("--url", default="http://127.0.0.1:5000/webhooks/zernio")
    a = ap.parse_args()

    event = {"id": f"evt-dev-{int(time.time() * 1000)}", "event": "message.received", "test": False,
             "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
             "message": {"id": "m-dev", "conversationId": a.conv, "platform": "whatsapp", "direction": "incoming", "text": a.text,
                         "sender": {"id": a.phone, "name": "Paciente de prueba"}, "metadata": {}},
             "account": {"accountId": "acc-dev"}, "conversation": {"id": a.conv}}
    raw = json.dumps(event).encode("utf-8")
    sig = hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    req = urllib.request.Request(a.url, data=raw, method="POST",
                                 headers={"Content-Type": "application/json", "X-Zernio-Signature": sig})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            print(r.status, r.read().decode())
    except urllib.error.HTTPError as e:
        print(e.code, e.read().decode())
        return 1
    except OSError as e:
        print(f"No se pudo conectar ({e}). ¿Esta corriendo el servidor? (npm run dev:local)")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
