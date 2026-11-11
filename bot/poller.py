#!/usr/bin/env python3
"""Poller del bot (F5): reclama eventos de la cola de la API de la clinica y los atiende con `server.handle()`.

MODO ALTERNATIVO. El modo principal es el webhook directo (Zernio -> `server.py` con WATHSBOT_BACKEND=api; ver
`docs/bot-hostinger.md`). Este poller es para cuando el webhook lo recibe el servidor de la clinica.
Sustituye al servidor HTTP de `server.py` (WATHSBOT_INGRESS=queue, decision A del proyecto): el webhook de
Zernio lo recibe el servidor de la clinica (URL fija con HTTPS), lo guarda en una cola y este proceso, que no
tiene IP publica, la consulta por conexion saliente. Un reinicio ya no pierde mensajes.

Uso (en el contenedor del agente):  WATHSBOT_BACKEND=api python poller.py
Entorno: CLINICA_API_URL, CLINICA_BOT_TOKEN, ZERNIO_API_KEY, ademas de las de server.py (WATHSBOT_DRY_RUN, ...).
  WATHSBOT_WORKERS (4)        conversaciones atendidas a la vez
  WATHSBOT_POLL_SECONDS (2)   espera entre consultas cuando la cola esta vacia
  WATHSBOT_LEASE_SECONDS (420) plazo de un evento reclamado: cubre hasta 4 pasos del modelo (90 s c/u)

Garantias (entrega "al menos una vez"):
- Interruptor apagado -> el evento se cierra como `skipped_bot_inactive` y NO se contesta (atiende una persona).
- Si la API no responde al preguntar el interruptor o al armar el prompt, el evento vuelve a la cola
  (`fail` con reintento); tras 5 intentos el servidor lo marca fallido y aparece en /api/attention.
- Si la API cae DESPUES de contestar (al hacer `ack`), el evento se vuelve a reclamar al vencer el plazo, pero
  `Processor.done` evita contestar dos veces mientras este proceso siga vivo. Un reinicio en esa ventana
  puede duplicar UNA respuesta: limitacion conocida y aceptada.
- Mensajes de una misma conversacion se atienden de uno en uno (candado por `conversationId`).
"""
import os
import signal
import sys
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

from api_client import ApiUnavailable


def _log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


class Processor:
    def __init__(self, client, handle_fn, fallback_text, log=_log, done_window=1000):
        self.client, self.handle, self.fallback, self.log = client, handle_fn, fallback_text, log
        self.done = OrderedDict()  # ids de evento ya contestados (ventana acotada)
        self._done_max = done_window
        self._guard = threading.Lock()
        self._conv_locks = {}

    def _conv_lock(self, conv_id):
        with self._guard:
            return self._conv_locks.setdefault(conv_id, threading.Lock())

    def _mark_done(self, eid):
        with self._guard:
            self.done[eid] = True
            while len(self.done) > self._done_max:
                self.done.popitem(last=False)

    def _release(self, eid, reason):
        """Devuelve el evento a la cola ahora mismo (si tambien eso falla, vence el plazo y vuelve solo)."""
        try:
            self.client.fail(eid, reason, retry=True)
        except ApiUnavailable as e:
            self.log(f"event={eid} no se pudo devolver a la cola ({e}); vuelve al vencer el plazo")

    @staticmethod
    def _is_patient_message(payload):
        m = payload.get("message")
        return (payload.get("event") == "message.received" and not payload.get("test") and isinstance(m, dict)
                and m.get("platform") == "whatsapp" and m.get("direction") == "incoming"
                and not (m.get("metadata") or {}).get("standby"))

    def process(self, row):
        """Atiende un evento reclamado. Nunca lanza: un fallo aqui no debe tumbar el bucle."""
        eid = row["id"]
        try:
            self._process(eid, row.get("payload") or {})
        except Exception as e:  # defensa final
            self.log(f"event={eid} error inesperado: {e!r}")
            self._release(eid, repr(e))

    def _process(self, eid, payload):
        if eid in self.done:  # reclamado de nuevo tras un `ack` que no llego: solo cerrarlo
            return self._ack(eid, "replied")
        if not self._is_patient_message(payload):
            return self._ack(eid, "skipped_ignored")
        try:
            active = self.client.bot_active()
        except ApiUnavailable as e:
            self.log(f"event={eid} no se pudo leer el interruptor: {e}")
            return self._release(eid, "interruptor ilegible: " + str(e))
        if not active:
            return self._ack(eid, "skipped_bot_inactive")
        m = payload["message"]
        conv = str(m.get("conversationId") or "")
        phone = str((m.get("sender") or {}).get("id") or "")
        try:
            with self._conv_lock(conv):
                reply = self.handle(payload)
        except ApiUnavailable as e:
            self.log(f"event={eid} la API no respondio al preparar la respuesta: {e}")
            return self._release(eid, "API no disponible: " + str(e))
        except Exception as e:
            self.log(f"event={eid} fallo al atender: {e!r}")
            return self._release(eid, repr(e))
        self._mark_done(eid)
        self._ack(eid, "replied")
        if reply == self.fallback:  # el bot no pudo ayudar: avisar al personal (mejor esfuerzo)
            try:
                self.client.handoff(conv, "otro", telefono=phone or None, detail="El bot envio el mensaje de respaldo")
            except ApiUnavailable as e:
                self.log(f"event={eid} no se pudo registrar el traspaso a una persona: {e}")

    def _ack(self, eid, outcome):
        try:
            self.client.ack(eid, outcome)
        except ApiUnavailable as e:
            self.log(f"event={eid} ack({outcome}) fallo: {e}; vuelve al vencer el plazo")


def run(client, processor, stop, workers=4, poll=2.0, lease=420, log=_log):
    """Bucle principal: reclama solo lo que hay capacidad para atender; backoff si la API cae."""
    pool = ThreadPoolExecutor(max_workers=workers)
    inflight, lock = [0], threading.Lock()

    def done_cb(_f):
        with lock:
            inflight[0] -= 1

    wait = poll
    while not stop.is_set():
        with lock:
            free = workers - inflight[0]
        if free <= 0:
            stop.wait(0.2)
            continue
        try:
            rows = client.claim(limit=min(free, 20), lease_seconds=lease)
        except ApiUnavailable as e:
            wait = min(wait * 2, 30.0)
            log(f"API no disponible ({e}); reintento en {wait:.0f}s")
            stop.wait(wait)
            continue
        wait = poll
        for row in rows:
            with lock:
                inflight[0] += 1
            pool.submit(processor.process, row).add_done_callback(done_cb)
        if not rows:
            stop.wait(poll)
    pool.shutdown(wait=True)


def main():
    os.environ["WATHSBOT_BACKEND"] = "api"
    os.environ["WATHSBOT_INGRESS"] = "queue"
    import server  # exige ZERNIO_API_KEY
    client = server.get_agenda()
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    workers = int(os.environ.get("WATHSBOT_WORKERS", "4"))
    poll = float(os.environ.get("WATHSBOT_POLL_SECONDS", "2"))
    lease = int(os.environ.get("WATHSBOT_LEASE_SECONDS", "420"))
    _log(f"Wathsbot poller: api={client.base} workers={workers} poll={poll}s lease={lease}s dry_run={server.DRY_RUN}")
    run(client, Processor(client, server.handle, server.FALLBACK), stop, workers, poll, lease)
    _log("Wathsbot poller detenido.")


if __name__ == "__main__":
    sys.exit(main())
