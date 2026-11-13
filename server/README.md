# Servidor de la clinica (Flask + SQLAlchemy 2 + Alembic)

Compatibilidad: el servidor corre en **Python 3.10** (PythonAnywhere) con SQLAlchemy 2.0.x: nada de `StrEnum`, `datetime.UTC`, `Self`,
`ExceptionGroup`, `tomllib`, ni `datetime.fromisoformat` con 'Z' (usar `agenda.parse_dt`), ni APIs solo de SQLAlchemy 2.1.

Estado: **F2, F3 y F4 hechas** — modelo de datos, migraciones, motor de agenda, seed, cola de eventos de Zernio, las rutas del bot y
la API de personas. Rutas HTTP: las 69 operaciones de `../docs/openapi.yaml` (el contrato; se cambia ANTES que el codigo): `/api/health`,
`/api/bot/*` (token de servicio), `POST /webhooks/zernio` (firma HMAC) y la API de personas (sesion por cookie, roles y CSRF):
`/api/auth/*`, `/api/me`, `/api/appointments`, `/api/doctors`, `/api/users`, `/api/doctor/*`, etc. Una prueba compara las rutas
reales con el contrato en los dos sentidos (ni una sin documentar, ni una sin implementar).

## Arrancar

```bash
# desde server/ (Windows: .venv/Scripts/...)
python -m venv .venv && .venv/Scripts/python -m pip install -r requirements-dev.txt
export DATABASE_URL='mysql+pymysql://usuario:clave@host/base?charset=utf8mb4'   # sin ella: SQLite en server/instance/clinica.db (solo desarrollo)
.venv/Scripts/alembic upgrade head          # o: flask --app wsgi upgrade-db
.venv/Scripts/flask --app wsgi seed         # idempotente; el bot nace APAGADO (--bot-active para encenderlo)
.venv/Scripts/flask --app wsgi run          # http://127.0.0.1:5000/api/health
```

Para probar las webs contra este servidor (`npm run dev:real` en `admin-web/` o `doctor-pwa/`, que mandan `/api` a `:5000`): arrancar
Flask con `AUTH_COOKIE_SECURE=0` (la cookie `Secure` no viaja por http local) y `BOT_TOKEN`, y crear un usuario con
`flask --app wsgi create-user`. El proxy de Vite conserva el `Host` a proposito (`changeOrigin: false`): el servidor compara `Origin`
con `Host` en las escrituras y, si el proxy lo reescribiera, daria 403 `csrf`. Las cookies no se aislan por puerto: dos webs en
`127.0.0.1` comparten la sesion (la PWA mostrara su aviso «esta app es para los doctores» si entraste como personal).

Variables: `DATABASE_URL`, `TIMEZONE` (America/Cancun), `SLOT_MINUTES` (30), `MIN_NOTICE_MINUTES` (60), `HORIZON_DAYS` (60),
`MAX_DURATION_MINUTES` (1440), `POOL_SIZE` (conexiones permanentes del pool de MySQL, hasta el doble en rafagas; **en PythonAnywhere
gratis `POOL_SIZE=1`**: el usuario solo tiene 3 conexiones simultaneas), `SQL_ECHO`. En PythonAnywhere el motor usa `pool_recycle=280` y `pool_pre_ping`.
`wsgi.py` expone `app` para el WSGI de PythonAnywhere.

Secretos de F3 (solo por entorno, nunca en el repo ni en los logs): `BOT_TOKEN` (token de servicio del bot; `flask --app wsgi gen-token`
imprime uno aleatorio; sin el, TODO `/api/bot/*` responde 401), `ZERNIO_WEBHOOK_SECRET` (el que se registra en Zernio; sin el, el webhook
responde 503, reintentable) y los ajustes de la cola `EVENT_MAX_ATTEMPTS` (5) y `EVENT_RETRY_BACKOFF_SECONDS` (30, crece con cada intento).

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
- **Bot** (`app/api/bot.py`): capa delgada sobre el motor. La identidad del paciente es el `telefono` que manda el bot (el
  `message.sender.id` de Zernio): `mis_citas`/`cancelar`/`reprogramar` solo ven las citas de ESE telefono (lo ajeno es 404
  `cita_no_encontrada`, igual que lo inexistente). Los errores de negocio traen los mismos codigos de `scheduler.py` (409 conflicto,
  404, 422); un cuerpo no JSON, un 5xx o un 401 el cliente del bot los trata como API caida. TODA respuesta de `/api` y `/webhooks` es
  JSON (nunca la pagina HTML de error de Flask) y lleva `Cache-Control: no-store`.
- **Webhook** (`app/api/webhook.py`): HMAC-SHA256 del cuerpo CRUDO (`X-Zernio-Signature`, alias `X-Late-Signature`), comparado en
  tiempo constante. Solo se encolan los `message.received` de pacientes por WhatsApp; `webhook.test` y lo demas se responde 200 y
  se descarta. Idempotente (`UNIQUE(zernio_event_id)`): una entrega duplicada responde 200 `duplicate`. Sin secreto = 503 (Zernio
  reintenta los 5xx; cualquier otro 4xx lo manda a su cola de eventos muertos).
- **Cola** (`app/events.py`): `pending -> claimed -> done|skipped|failed`. `claim` toma candidatos con un `UPDATE ... WHERE`
  condicional (si otro bot los tomo, no coincide): sin bloqueos especiales y igual en SQLite y MySQL. Un reclamo cuyo plazo vence
  vuelve a ofrecerse; cada reclamo es un intento y, al llegar a `EVENT_MAX_ATTEMPTS`, el evento pasa a `failed` y se crea un caso
  de atencion (`attention_cases`). `fail(retry)` espera `EVENT_RETRY_BACKOFF_SECONDS * intento`. Las horas de la cola van a segundos
  enteros (MySQL redondea los DATETIME). **Privacidad:** al cerrar un evento se borra el texto del paciente (podria contar sintomas);
  solo quedan la conversacion y el telefono para poder contactarlo.
- **Personas** (`app/auth.py`, `app/api/security.py`): login con correo y contrasena (scrypt de werkzeug, o pbkdf2 si el Python no lo
  trae; minimo 10 caracteres). La cookie `clinica_session` (HttpOnly, SameSite=Lax, Secure) lleva un token aleatorio; la BD guarda
  solo su SHA-256 (`sessions`), asi que una copia de la BD no sirve para entrar. Caduca a las 8 h sin actividad o a los 7 dias, y se
  cierra al salir, desactivar al usuario o cambiarle el rol o la contrasena. 5 contrasenas erroneas seguidas lo bloquean 15 min (429;
  el contador se confirma ANTES de rechazar). Un usuario inexistente o inactivo da el mismo 401 y gasta el mismo tiempo.
  Orden de las comprobaciones: sin sesion 401 -> rol no permitido 403 -> escritura sin `X-CSRF-Token` correcto (estable por sesion)
  o con `Origin` ajeno 403 (`detail: csrf`). `require("staff", ...)` es la unica puerta de las rutas de personas.
- **API del personal y del doctor**: capa delgada sobre `Agenda`, `Availability` y `Directory` (`app/directory.py`: doctores,
  solicitudes de cambio de horario, casos de atencion, push). Aprobar una solicitud cambia el horario Y la marca de aprobada en UNA
  transaccion (si el horario ya no cabe en el de la clinica, sigue pendiente). **Doctor**: ninguna ruta recibe el id de otro doctor;
  una ausencia ajena es 404 (no 403); sus citas salen SIN telefono (`patient.id` es el id de la cita). Una ausencia suya con citas
  agendadas deja un caso de atencion para el personal SIN nombres ni telefonos. Cambios de usuarios, doctores, horarios, ausencias y
  del bot quedan en `audit_log` sin contrasenas, correos ni nombres de pacientes.
- **Casos de atención paginados** (`GET /api/attention?status=&limit=&offset=`): sin `limit` salen todos (los pendientes son pocos); los atendidos se piden por
  páginas (`limit` 1 a 100, `offset` solo junto con `limit`) y la respuesta lleva `total`. El `LIMIT` va en la consulta y ordena por `id` (índice `(status, id)`):
  no se trae toda la tabla para recortar. `Directory.attention()` devuelve `(casos, total)`.
- **Eventos personales del doctor** (`/api/doctor/personal-events`, tabla `doctor_personal_events`, migracion 0005): el doctor anota lo suyo en su
  PWA. Mientras dura uno el doctor no se ofrece ni se le agenda (bot, personal, reprogramar: `doctor_no_disponible`, sin decir por que) pero el
  consultorio queda libre para los demas. **El texto (titulo, notas) es privado**: solo lo devuelve la API del propio doctor; el personal recibe
  `GET /api/busy-times` = `{id, doctorId, startUtc, endUtc}` (`Availability.busy_between` ni carga el texto) y la bitacora guarda solo ids y
  horas. Maximo 24 h; no se acepta sobre una cita agendada del doctor (409 `evento_con_cita`; el alta y la reserva hacen cola con
  `Repo.lock_rooms`). `Repo.personal_events` entrega solo las franjas al motor.
- **Marca de la clinica** (`/api/branding`, `/api/branding/logo`, `/api/settings/branding[/logo]`; `app/branding.py`, `app/images.py`, `app/api/branding.py`; tabla `clinic_logo`, migracion 0006): nombre y logotipo de la clinica. Las dos lecturas son PUBLICAS (la web y la PWA los muestran antes de iniciar sesion); escribir y quitar es solo del `admin` (CSRF + bitacora `branding.*` sin los bytes). El logotipo debe ser PNG, JPG o WebP (el tipo sale de la cabecera del archivo; SVG no), exactamente cuadrado, 64 a 2048 px, <= 1 MB (`request.max_content_length = 1 MB + 1`: el 413 llega sin leer un archivo enorme); el nombre, 1 a 80 caracteres. Se guarda en la BD (`LargeBinary`, `MEDIUMBLOB` en MySQL) con su sha256, que es el `ETag` (304 si no cambio) y la huella `?v=` de `logoUrl`; responde con `nosniff` y CSP `default-src 'none'`.
- **Entrada del doctor con codigo** (`GET /api/auth/doctors`, `POST /api/auth/doctor-login`; `AuthService.login_doctors/login_doctor`, `app/doctor_codes.py`; `doctors.code`, migracion 0007): cada doctor tiene un codigo de 4 digitos (unico, asignado al darlo de alta desde 1001, no editable) que es su «usuario». La lista (publica) trae `{code, name}` de quienes tienen una cuenta de rol doctor ACTIVA; el login solo admite cuentas `doctor` y comparte con el de correo la cookie, el bloqueo (el contador es de la cuenta) y el `credenciales_invalidas` unico. Un doctor con dos cuentas entra por la de menor id (la otra solo por correo). El codigo es PUBLICO: protege la contrasena.
- **Cuenta del doctor sin contrasena + enlace** (`create_doctor_account`, `AuthService.create_password_link/check_password_link/use_password_link`; `POST /api/doctors/{id}/password-link`, `POST /api/auth/password-link/check|use`; `users.email`/`password_hash` NULL y `setup_token_hash`/`setup_expires_at`, migracion 0008): `Directory.create_doctor` crea la cuenta (sin correo ni contrasena) en la misma transaccion; el personal genera un enlace de un solo uso (72 h, reemplaza al anterior, solo se guarda su SHA-256) que apunta a `DOCTOR_APP_URL` (`<url>#/contrasena?t=<token>`; sin ella 503 `no_configurado`) y el doctor lo usa para fijar su contrasena (primera vez o recuperacion): se cierran sus sesiones, se quita el bloqueo y entra. Una cuenta sin contrasena no entra, no cuenta intentos y no sale en `GET /api/auth/doctors`. `POST /api/users` solo crea `staff` y `admin`. Eliminar un doctor borra tambien su cuenta si nunca tuvo contrasena ni entro; si no, 409 `doctor_con_usuario`.
- **Horarios libres para mover una cita** (`GET /api/appointments/{id}/move-slots`; `Agenda.move_slots`, `Repo.busy(ignore_appointment_id=...)`): los inicios que `PATCH` aceptaria, dia por dia en `[from, to)` (hasta 42 dias), con las MISMAS reglas que `_move` (horario de la clinica y del doctor, ausencias y eventos personales, antelacion —`allowShortNotice=true` la omite—, horizonte, doctor y consultorio libres, duracion de la cita), contando su propio horario como libre; `roomId` limita a un consultorio; un bloqueo ofrece de 7:00 a 20:00 donde su consultorio este libre. Alimenta el calendario emergente del formulario «Mover» de la web.
- **Reglas de usuarios**: un administrador no se desactiva ni cambia su propio rol, y nunca queda el sistema sin administrador activo;
  el primero se crea con `flask --app wsgi create-user`.
- **Tablas que NO estan aun**: ninguna del contrato. `push_subscriptions` guarda las suscripciones; el ENVIO de notificaciones llega
  con la PWA (F7, `pywebpush`).

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
- `test_personal_events.py`: eventos personales (bloqueo solo del doctor, consultorio libre, choque con citas, validaciones, 404 ajeno, **privacidad**
  con texto «centinela» en todas las rutas del personal y del bot, bitacora sin texto, migracion 0005 en `test_schema.py`).
- `test_doctor_login.py`: codigos (seed, siguiente libre, hueco, no editable, carrera por el mismo codigo), la lista publica (solo codigo y nombre, baja, dos cuentas, orden), el login por codigo (cookie, `/api/me`, bitacora, espacios, 401 unico, 422, `Origin`, bloqueo compartido con el correo) y la migracion 0007 en `test_schema.py`.
- `test_move_slots.py`: los horarios por dia (clinica, ocupados, dos consultorios llenos, cita larga, ausencias y eventos personales, horario propio, doctor de baja, `roomId`, horizonte y cita de mostrador, pasado), la CONSISTENCIA con `PATCH` (lo listado es exactamente lo que se acepta, para una semana mixta, por consultorio, cita larga, mostrador y bloqueo), errores (rango, 42/43 dias, consultorio, 404, cita cancelada) y permisos (el doctor, 403; sin datos de pacientes).
- `test_doctor_account.py`: la cuenta nace con el doctor (sin correo ni contrasena, atomica), no entra ni se bloquea, el enlace (corto, 72 h, solo hash, nunca en la bitacora, reemplazo, cuenta desactivada, 503 sin `DOCTOR_APP_URL`, direccion normalizada), la pagina del enlace (404 unico, un solo uso, contrasena invalida no lo gasta, vencimiento, `Origin`), recuperar una contrasena olvidada (sesiones cerradas, bloqueo quitado) y eliminar un doctor con su cuenta sin usar; la migracion 0008 en `test_schema.py` (conserva los CHECK).
- `test_branding.py`: lectura de PNG/JPEG/WebP (lossy, lossless y extendido) y sus rechazos (no cuadrada, chica, grande, dañada, tipo falso), la API (publico/admin, recepcion 403, CSRF, 1 MB exacto y de mas, archivo enorme, `ETag`/304, bitacora, quitar, nombre y logotipo independientes) y la migracion 0006 en `test_schema.py`.
- `test_agenda_port.py`: las 23 de `bot/test_scheduler.py` portadas. `test_agenda_rules.py`: horario propio, ausencias, estados,
  atomicidad, antelacion con reloj congelado, bloqueos, privacidad por telefono, UTC. `test_concurrency.py`: 20 hilos y 6 procesos a la misma
  hora -> exactamente 2 reservas, `retries == 0`, e invariantes de la BD (`helpers.check_integrity`). `test_schema.py`: migracion en
  limpio == modelos (SQLite y MySQL), seed, CLI. `test_contract_engine.py`: respuestas del bot validadas contra `docs/openapi.yaml`.
  F4: `test_auth.py` (login, cookie, CSRF/Origin, caducidad con reloj falso, bloqueo, comandos), `test_authorization.py` (**dirigida por el
  contrato**: cada operacion sin sesion = 401, con cada rol que no le toca = 403, sin CSRF = 403, y las rutas reales = el contrato),
  `test_staff_api.py`, `test_admin_api.py` y `test_doctor_api.py` (aislamiento entre doctores, sin telefono, privacidad en la bitacora).
  La clase `Session` de las pruebas valida CADA respuesta contra `docs/openapi.yaml` (estado declarado y esquema del cuerpo), asi que
  todas esas pruebas son tambien de conformidad con el contrato; `check_contract` tiene su propia prueba de que detecta desviaciones.
  F3: `test_bot_api.py` (autenticacion, contrato, errores, privacidad por telefono), `test_webhook.py` (firma, duplicados, filtrado),
  `test_event_queue.py` (plazos, reintentos, intentos agotados, concurrencia; reloj falso) y `test_bot_e2e.py`: el codigo REAL del
  bot (`bot/api_client.py`, `run_action`, `poller.py`) contra el servidor por HTTP de verdad; se salta si no esta la carpeta `bot/`.
- Las fechas se calculan con el reloj de la agenda (inyectable: `create_app(..., clock=...)`).
