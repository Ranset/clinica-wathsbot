# Servidor de la clinica (Flask + SQLAlchemy 2 + Alembic)

Compatibilidad: el servidor corre en **Python 3.10** (PythonAnywhere) con SQLAlchemy 2.0.x: nada de `StrEnum`, `datetime.UTC`, `Self`,
`ExceptionGroup`, `tomllib`, ni `datetime.fromisoformat` con 'Z' (usar `agenda.parse_dt`), ni APIs solo de SQLAlchemy 2.1.

Estado: **F2 hecha** — modelo de datos, migracion inicial, motor de agenda y seed. Rutas HTTP: solo `GET /api/health`
(las demas llegan en F3/F4, ver `../docs/openapi.yaml`, que no se edita desde aqui).

## Arrancar

```bash
# desde server/ (Windows: .venv/Scripts/...)
python -m venv .venv && .venv/Scripts/python -m pip install -r requirements-dev.txt
export DATABASE_URL='mysql+pymysql://usuario:clave@host/base?charset=utf8mb4'   # sin ella: SQLite en server/instance/clinica.db (solo desarrollo)
.venv/Scripts/alembic upgrade head          # o: flask --app wsgi upgrade-db
.venv/Scripts/flask --app wsgi seed         # idempotente; el bot nace APAGADO (--bot-active para encenderlo)
.venv/Scripts/flask --app wsgi run          # http://127.0.0.1:5000/api/health
```

Variables: `DATABASE_URL`, `TIMEZONE` (America/Cancun), `SLOT_MINUTES` (30), `MIN_NOTICE_MINUTES` (60), `HORIZON_DAYS` (60),
`MAX_DURATION_MINUTES` (1440), `POOL_SIZE` (conexiones permanentes del pool de MySQL, hasta el doble en rafagas; **en PythonAnywhere
gratis `POOL_SIZE=1`**: el usuario solo tiene 3 conexiones simultaneas), `SQL_ECHO`. En PythonAnywhere el motor usa `pool_recycle=280` y `pool_pre_ping`.
`wsgi.py` expone `app` para el WSGI de PythonAnywhere.

## Como esta hecho

- **Hora:** la BD guarda **UTC ingenuo** (`DATETIME`). Los horarios semanales (`clinic_hours`, `doctor_hours`) son hora de pared de la
  clinica (`TIME`, `weekday` 0=lunes). Ids enteros en BD; el contrato los pasa a cadena en JSON.
- **Exclusion mutua = la BD.** `appointment_blocks(appointment_id, doctor_id, room_id, slot_start)` con `UNIQUE(doctor_id, slot_start)` y
  `UNIQUE(room_id, slot_start)`; una fila por cada 30 min. Un bloqueo de consultorio usa `doctor_id = NULL`. Cancelar borra las filas;
  `realizada` / `no_show` las conservan. Ya no hay `threading.Lock` ni re-verificacion posterior.
- **Reservar = UNA transaccion** (`Agenda._create`): bloquea las filas de `rooms` (ver abajo) -> valida (antelacion, horizonte, horario de la
  clinica, horario y ausencias del doctor, alineacion a 30 min) -> comprueba ocupacion de todo el rango en una consulta -> inserta la cita y
  prueba consultorios en orden, cada intento en un SAVEPOINT; si el UNIQUE choca, siguiente consultorio; si no queda ninguno,
  `horario_ocupado` y se revierte todo.
- **Reprogramar** (`Agenda._move`): libera los huecos propios y reserva los nuevos en la misma transaccion; cualquier fallo revierte todo y la
  cita original queda intacta (no hace falta `ignore_id`; una cita puede moverse sobre su propio hueco).
- **Bloqueo de `rooms` al inicio de cada escritura** (`Repo.lock_rooms`, `SELECT ... FOR UPDATE` en orden de id): sin el, varios INSERT
  simultaneos que chocan con un UNIQUE dejan bloqueos residuales y InnoDB los resuelve con **interbloqueos (1213)** que descartan
  transacciones validas (se midio: `Agenda.retries > 0`). Con el bloqueo las reservas rivales hacen cola y no hay reintentos; los UNIQUE
  siguen siendo la red de seguridad (hay una prueba que falsea la pre-comprobacion para demostrarlo). Si aun asi MySQL elige una victima
  (1213/1205, o 1305 por el `ROLLBACK TO SAVEPOINT` que sigue), `Unit._write` repite la transaccion completa (hasta 5 veces).
- **Errores:** `AgendaError(code)`; los codigos del bot son EXACTAMENTE los de `bot/scheduler.py` mas `doctor_no_disponible`,
  `transicion_invalida`, `validacion`, `no_encontrado` (todos en `ErrorCode` del contrato; hay una prueba que lo ata). `http_status` da el estado.
- **Dos superficies** (`app/agenda/service.py`): para el bot, dicts en espanol como `scheduler.py` (`free_slots`, `nearest`, `book`, `mine`,
  `cancel`, `reschedule`; `event_id` pasa a `cita_id` y reprogramar conserva el id); para el personal/API, que lanza `AgendaError`
  (`create_booking`, `update_booking`, `get_booking`, `list_bookings`). Disponibilidad en `app/agenda/availability.py` (horario de la
  clinica, horario propio del doctor, ausencias: devuelven las citas afectadas y no cancelan nada).
- **Privacidad:** el paciente es su telefono; `mine/cancel/reschedule` solo ven citas `agendada` de ese telefono (un telefono vacio no es
  dueno de nada). La bitacora (`audit_log`) no guarda nombres ni telefonos.
- **Tablas que NO estan aun** (llegan con su fase): solicitudes de cambio de horario, casos de atencion y suscripciones push (F3/F4/F7).

## Pruebas

```bash
.venv/Scripts/python -m pytest tests -q                       # SQLite; las variantes [mysql] se saltan (se avisa en la cabecera)
TEST_MYSQL_DOCKER=1 .venv/Scripts/python -m pytest tests -q   # levanta/reutiliza mysql:8 en Docker (Docker Desktop abierto)
TEST_MYSQL_URL='mysql+pymysql://root:clave@127.0.0.1:33307/clinica_test?charset=utf8mb4' .venv/Scripts/python -m pytest tests -q
scripts/mysql_test_db.sh up|down|url                          # el mismo contenedor a mano (puerto 33307, utf8mb4, sin fsync)
python scripts/pa_run_tests.py [args de pytest]               # contra un MySQL remoto (p. ej. PythonAnywhere): clave oculta, solo bases *_test
```

- Cada prueba de datos corre en `[sqlite]` y en `[mysql]`. **El MySQL de pruebas se vacia**: no apuntarlo a una base con datos
  (`conftest.py` se niega si el nombre no contiene "test"; `scripts/pa_run_tests.py`, si no termina en `_test`).
- `TEST_MYSQL_MAX_CONN=N`: el usuario MySQL solo admite N conexiones simultaneas (PythonAnywhere gratis: 3). Reduce el pool de las
  pruebas y los procesos de la prueba multiproceso (minimo 3); `pa_run_tests.py` lo detecta solo con `@@max_user_connections`.
- `test_agenda_port.py`: las 23 de `bot/test_scheduler.py` portadas. `test_agenda_rules.py`: horario propio, ausencias, estados,
  atomicidad, antelacion con reloj congelado, bloqueos, privacidad por telefono, UTC. `test_concurrency.py`: 20 hilos y 6 procesos a la misma
  hora -> exactamente 2 reservas, `retries == 0`, e invariantes de la BD (`helpers.check_integrity`). `test_schema.py`: migracion en
  limpio == modelos (SQLite y MySQL), seed, CLI. `test_contract_engine.py`: respuestas del bot validadas contra `docs/openapi.yaml`.
- Las fechas se calculan con el reloj de la agenda (inyectable: `create_app(..., clock=...)`).
