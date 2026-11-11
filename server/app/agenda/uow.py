"""Unidad de trabajo: sesiones cortas por operacion y escrituras en UNA transaccion.

Sustituye al `threading.Lock` de `scheduler.py`: la exclusion mutua entre procesos la da la BD (UNIQUE de
`appointment_blocks`), no un cerrojo en memoria. Si MySQL elige esta transaccion como victima de un interbloqueo
(o SQLite dice 'database is locked') se repite completa: sigue siendo atomica porque lo anterior se revierte.
"""
from __future__ import annotations

import random
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Callable

from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session, sessionmaker

from ..db import WRITE_OPTION, is_retryable
from .repo import Repo
from .rules import Rules


class Unit:
    MAX_TRIES = 5

    def __init__(self, session_factory: sessionmaker[Session], rules: Rules | None = None,
                 clock: Callable[[], datetime] | None = None):
        self._sf = session_factory
        self.rules = rules or Rules()
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        #: transacciones repetidas por interbloqueo/espera agotada (las pruebas comprueban que sea 0 en la carrera normal)
        self.retries = 0
        self._retries_lock = threading.Lock()

    def now(self) -> datetime:
        """Ahora, con la zona de la clinica (inyectable para las pruebas)."""
        return self._clock().astimezone(self.rules.tz)

    @contextmanager
    def _read(self):
        s = self._sf()
        try:
            yield Repo(s, self.rules)
        finally:
            s.close()

    def _write(self, fn: Callable[[Repo, Session], object]):
        """Ejecuta `fn(repo, session)` en una transaccion; confirma al volver, revierte si lanza."""
        for attempt in range(self.MAX_TRIES):
            s = self._sf()
            try:
                with s.begin():
                    s.connection(execution_options={WRITE_OPTION: True})  # antes del primer SQL de la transaccion
                    return fn(Repo(s, self.rules), s)
            except DBAPIError as e:
                if attempt + 1 < self.MAX_TRIES and is_retryable(e):
                    with self._retries_lock:
                        self.retries += 1
                    time.sleep(random.uniform(0.01, 0.05) * (attempt + 1))
                    continue
                raise
            finally:
                s.close()
