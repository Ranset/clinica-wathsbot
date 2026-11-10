# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Clinica CUBAMEX — bot de WhatsApp + app de gestion

Idioma del usuario: espanol. Este directorio NO es un repositorio git (no hay historial para deshacer cambios).

## Que es
Una clinica en Cancun (Clinica de Especialidades CUBAMEX, Av. Nichupte Mz 10 Lote 10, Num. Ext. 103, SM 513, CP 77534) con **2 consultorios** y **7 doctores**:
Proctologia (Dr. Cervantes Pelaez), Ginecologia (Dr. Perez Lago), Ortopedia y Traumatologia (Dra. Bordas Rodriguez), Ultrasonidos (Dr. Gustavo Torrealba), Otorrinolaringologia (Dr. Molina Lopez), Anestesiologia (Dra. Geydi), Reumatologia (Dra. Ana del Carmen Arguelles).
Horario: L-V 9:00-18:00, sabados 9:00-13:00. Citas de 30 min. Zona `America/Cancun` (UTC-5, sin horario de verano).
Regla de agenda: minimo 60 min de antelacion, maximo 60 dias a futuro.

## Arquitectura objetivo (decidida por el usuario)
- **Agente (Hermes) corre aparte, en su contenedor.** Opera el bot de WhatsApp. No se migra.
- **Servidor de la clinica** (Flask + MySQL, para PythonAnywhere): app web para administrador y personal + API.
- **API** usada por: el bot, la app web y la PWA del doctor.
- **PWA del doctor**: React 19 + TypeScript + Vite + `vite-plugin-pwa`. Agenda personal; el doctor solo ve SUS citas y puede marcar ausencias/cambios de horario.
- **Roles:** administrador tecnico, personal de la clinica, doctor.
- **La base de datos propia es la fuente de verdad de las citas** (se abandona Google Calendar como fuente de verdad). Calendar solo podria ser un espejo de solo lectura, mas adelante.
- **Webhook de Zernio (decision A):** el servidor recibe el webhook en una URL fija con HTTPS, verifica la firma HMAC y guarda el evento en una cola; el bot (que no tiene IP publica) consulta la cola por conexion saliente. Asi un reinicio no pierde mensajes.
- **Interruptor del bot:** el bot consulta un indicador "activo/inactivo" en la API antes de contestar; el personal lo cambia con un boton.
- **Si la API no responde**, el bot NO ofrece horarios de una cache: pasa el caso a una persona.
- El bot deja de tocar Google Calendar y de usar `scheduler.py`; pide horarios/reserva/cancelacion/reprogramacion a la API, que valida y reserva de forma atomica.

## Estado actual del repo
Plan por fases F0-F9 en `C:\Users\VIDEO\.claude\plans\wild-wibbling-cake.md` (aprobado). **Hecho: F0 (entorno) y F1 (contrato).** Siguiente: F2 (modelo de datos + motor de agenda en `server/`), F3 (webhook/cola), F4 (auth); en paralelo tras F1: `admin-web/` (F6) y `doctor-pwa/` (F7), que aun NO existen.
- `docs/openapi.yaml` — **contrato de la API** (OpenAPI 3.1, 49 operaciones: bot, webhook, auth, agenda, admin, doctor). Es la referencia para servidor, bot, web y PWA; cambiar el contrato antes que el codigo. `server/tests/test_contract.py` lo valida y lo ata a `bot/scheduler.py` (codigos de error), a `Booking` de `shared/calendar/src/types.ts` y a las 6 acciones del bot.
- `server/` — solo entorno por ahora: `requirements.txt` / `requirements-dev.txt` (Flask, SQLAlchemy 2.1, Alembic, PyMySQL, pytest) y `tests/test_contract.py`. El venv esta en `server/.venv` (ignorado por git).
- `bot/` — bot de WhatsApp actual, funcional y probado de punta a punta contra Google Calendar. Python, solo libreria estandar (sin `requirements.txt`); `GoogleBackend`/`gcal_auth.py` ademas necesitan `google-auth`, `google-api-python-client`, `google-auth-oauthlib`. Se migrara a la API en F5.
- `shared/calendar/` — calendario React 19 + TS (paquete `@clinica/calendar`), Dia/Semana/Mes/Lista + carriles por doctor/consultorio. Se consume como libreria (`src/index.ts`).
- `.claude/launch.json` — configuracion `calendar-demo` para abrir la demo del calendario en el navegador integrado.

## Comandos
Verificados en este entorno (Windows, Python 3.12.10, Node con `node_modules` ya instalado): las 23 pruebas de Python, las 60 de vitest y el typecheck pasan.

Bot (desde `bot/`; sin pytest, es un runner propio en `test_scheduler.py`):
```bash
python test_scheduler.py                                                  # las 23 pruebas
python -c "import test_scheduler as t; t.cercanos_horario_libre_es_exacto()"   # UNA prueba (sin salida = paso)
```
Calendario (desde `shared/calendar/`):
```bash
npm install
npm test                                  # vitest, 60 pruebas
npx vitest run --root . test/render.test.tsx   # un archivo
npx vitest run --root . -t "semana"            # por nombre
npm run typecheck                         # tsc --noEmit (tambien cubre demo/ y test/)
npm run dev                               # demo con datos de ejemplo en http://127.0.0.1:5199
npm run build                             # demo estatica en dist-demo/
```
Servidor (desde `server/`, venv en `server/.venv`; en Windows `.venv/Scripts/python`):
```bash
python -m venv .venv && .venv/Scripts/python -m pip install -r requirements-dev.txt   # una sola vez
.venv/Scripts/python -m pytest tests -q                                               # 7 pruebas del contrato
.venv/Scripts/python -m pytest tests/test_contract.py -k csrf                         # una prueba
```
No hay linter configurado en ninguno de los tres.

`run.sh`, `start.sh`, `stop.sh` y `gcal_auth.py` usan rutas del contenedor del agente (`/data/profiles/wathsbot/...`, `/opt/venv/bin/python`, `cloudflared`) y llaman a la API real de Zernio: **no sirven en local ni deben ejecutarse sin que el usuario lo pida**. `start.sh`/`stop.sh` tienen fijo el ID del webhook de Zernio y activan/desactivan el webhook de produccion. `e2e_sim.py` usa el modelo real (CLI `claude`, ruta por defecto `/data/.local/bin/claude`, cambiable con `CLAUDE_BIN`); contra la agenda simulada, sin Google ni Zernio. No se ejecuto en esta sesion.

## Como funciona el bot (flujo entre archivos)
`server.py` (webhook HTTP) -> `handle()` -> `run_agent()` -> `llm()` -> `run_action()` -> `scheduler.Agenda` -> backend.
- **El modelo NO toca el calendario.** Responde un unico JSON `{"reply": ..., "action": ...}`. `run_agent` (max 4 pasos) parsea, `run_action` valida y ejecuta una de: `horarios`, `cercanos`, `agendar`, `mis_citas`, `cancelar`, `reprogramar`, y devuelve al modelo `RESULTADO (sistema, no es el paciente): {...}` para que redacte la respuesta final. Texto plano que no parece JSON se envia tal cual; cualquier fallo -> `FALLBACK` ("el equipo se pondra en contacto").
- **El prompt se compone en dos partes:** `system_prompt.md` (estilo, datos, limites de seguridad) + `agenda_prompt()` en `server.py`, generado en tiempo de ejecucion (fecha/hora actual, doctores, limites de `agenda_config.json`, formato de acciones y flujo de conversacion). Las reglas de agendado viven en `agenda_prompt()`, no en el `.md`; ahi la seccion de agenda "tiene prioridad" sobre "Ayudar a agendar" del `.md`.
- **Compuerta `agenda_enabled()`:** la agenda automatica solo se activa si el remitente trae telefono numerico y ningun ID de consultorio en `agenda_config.json` contiene "PENDIENTE"; si no, el bot responde solo con el prompt base.
- **Seleccion de modelo (`llm()`):** `WATHSBOT_LLM` (defecto `cli`) -> CLI `claude -p --tools ""`; en otro caso `ANTHROPIC_API_KEY` (defecto `claude-haiku-4-5`) u `OPENROUTER_API_KEY`. `WATHSBOT_MODEL` cambia el modelo.
- **Entorno del servidor:** `ZERNIO_API_KEY` es obligatoria al importar `server.py` (KeyError si falta; `e2e_sim.py` pone un valor falso). Otras: `WATHSBOT_WEBHOOK_SECRET` (sin ella toda firma se rechaza), `WATHSBOT_PORT` (8787), `WATHSBOT_DRY_RUN=1` (no envia la respuesta a Zernio), `GOOGLE_TOKEN_PATH`.
- **Estado en memoria** (`SEEN` para dedupe de eventos, `GREETED`): se pierde al reiniciar; es parte de la razon de la cola de eventos del servidor.
- Zernio API: base `https://zernio.com/api/v1`, `Authorization: Bearer $ZERNIO_API_KEY`. Responder: `POST /inbox/conversations/{id}/messages` con `accountId` y `message`. Webhook `message.received`; saltar `metadata.standby`, no-entrantes y duplicados (dedupe por `id` del evento). Ventana de 24 h para mensajes libres. La cuenta de Zernio aun NO puede enviar WhatsApp por iniciativa propia (sin plantillas): por eso no hay recordatorios ni avisos proactivos.
- `valid_sig` acepta cualquier cabecera cuyo nombre contenga "signature" (o `x-zernio-secret`/`x-webhook-secret`) y compara HMAC-SHA256 del cuerpo; al portarlo a Flask conviene fijar el nombre real de la cabecera de Zernio.
- Modelo en produccion: hoy usa el CLI `claude` con una suscripcion. **Para produccion usar `ANTHROPIC_API_KEY`** (la suscripcion tiene limites; no es para produccion).

## Motor de agenda (`bot/scheduler.py`) — lo que hay que portar a la API
`Agenda(backend)` es toda la logica determinista; el backend solo expone `list_events(cal,start,end,private=None)`, `insert(cal,body)`, `delete(cal,id)`. `GoogleBackend` es el real y `Fake` (en `test_scheduler.py`) el de pruebas: **esa costura backend es lo que la API reemplaza con MySQL** y `test_scheduler.py` es la especificacion ejecutable a conservar/portar.
- Hoy el estado vive en eventos de Google Calendar (uno por consultorio, con `extendedProperties.private` = telefono/doctor/paciente); los eventos manuales del equipo bloquean consultorio y doctor (el doctor se detecta por su apellido, campo `match`, en el titulo). Nada de esto aplica a la BD propia.
- La exclusion mutua hoy es un `threading.Lock` en proceso + re-verificacion tras insertar: NO sirve con varios procesos; en MySQL usar los bloques unicos descritos abajo.
- Los codigos de error son parte del contrato con el modelo y el prompt: `horario_ocupado`, `horario_pasado_o_muy_cercano`, `fuera_de_rango`, `fuera_de_horario`, `falta_nombre_completo`, `especialidad_no_encontrada`, `cita_no_encontrada`, `agenda_no_disponible`, `accion_desconocida`. Conservarlos al portar (o actualizar `agenda_prompt()` a la vez).
- Las pruebas calculan fechas relativas a `now()` (no hay fechas fijas): pasan cualquier dia, pero dependen del reloj.
- Los doctores/horarios estan repetidos en `agenda_config.json`, `system_prompt.md` y `shared/calendar/demo/main.tsx`; mientras no exista la BD, mantenerlos sincronizados.

## Reglas de agenda que la API debe imponer (ya implementadas en `bot/scheduler.py`)
1. Hay 2 consultorios y cada doctor es un recurso: un horario se ofrece solo si el doctor esta libre (en CUALQUIER consultorio) y al menos un consultorio esta libre. Nunca mas de 2 citas simultaneas, nunca el mismo doctor dos veces.
2. Reservar es atomico. En MySQL no hay indices unicos parciales: usar una tabla de bloques de 30 min con `UNIQUE(consultorio_id, inicio)` y `UNIQUE(doctor_id, inicio)` (o equivalente) y reservar en transaccion. Re-verificar justo antes de insertar.
3. La identidad del paciente es su telefono de WhatsApp (`message.sender.id`, digitos completos), NUNCA lo que escriba en el chat. Un paciente solo ve/cambia/cancela SUS citas.
4. Reprogramar: si el nuevo horario falla, la cita original se conserva.
5. Antelacion minima 60 min y horizonte 60 dias, tambien al reprogramar.
6. Citas con estado: `agendada`, `realizada`, `no_show`, `cancelada`. Solo guardar nombre, telefono, especialidad y horario (nada de sintomas).
7. Disponibilidad por doctor: horario semanal propio + ausencias (hoy todos usan el horario de la clinica: PENDIENTE).

## Calendario (`shared/calendar`)
Adaptado de **Vocero CRM** (https://github.com/kevinrivm/vocero-crm, MIT, (c) 2026 Kevin Belier; licencia en `LICENSE.vocero-crm`; conservarla). `src/lib/calendar.ts` y `src/lib/slots.ts` se copiaron SIN cambios, igual que las pruebas en `test/vocero/` (las 50 originales): no editarlos; si hay que cambiar comportamiento, hacerlo en capa propia. Propio: `src/types.ts` (modelo `Booking` con doctor+consultorio, `Lane`, `WeeklyHours`), la **vista de dia por carriles** (una columna por doctor o consultorio con su horario sombreado), `booking-look.ts`, el tema (`src/styles.css`, Tailwind 3) y `test/render.test.tsx` (10 pruebas).
- `Booking.scheduledAtUtc` viaja en UTC; la rejilla pinta en la zona de la clinica. Los horarios semanales (`WeeklyHours`) son hora de pared por dia (`mon`..`sun`), distinto del formato de `agenda_config.json` (indice 0-6, "HH:MM").
- `vite.config.ts` solo configura la **demo** (`root: "demo"`); no hay build de libreria. Para la web de administracion (Flask) se serviria como bundle estatico; para la PWA se importa como libreria (`src/index.ts`).
- **Revisado en el navegador integrado el 2026-11-10** (`.claude/launch.json` -> `calendar-demo`): semana, dia por carriles y mes se renderizan bien en escritorio y movil (375 px), sin errores de consola. En movil la vista de mes tiene scroll horizontal dentro de su tarjeta (7 columnas de ~82 px); la pagina no se desborda. Lista no se reviso visualmente. Las pruebas siguen verificando estructura, no estetica.

## Credenciales (NO incluidas; el usuario las tiene)
`ZERNIO_API_KEY`, secreto del webhook de Zernio, token de Google (`google_token.json`, ya no necesario cuando la BD sea la fuente de verdad), `ANTHROPIC_API_KEY`. Nunca las pongas en el repo ni las imprimas. `bot/scheduler.py` lee el token desde `GOOGLE_TOKEN_PATH` (por defecto `/data/profiles/wathsbot/google_token.json`). `.gitignore` ya excluye `.env`, `google_token.json`, `google_client_secret*.json`, `google_oauth_pending.json`.

## Pendientes conocidos
- Contrato de la API: **borrador v0.1 hecho** (`docs/openapi.yaml`); falta que el usuario lo revise. Decisiones por defecto tomadas en el (cambiables): web admin = SPA React; sesion por cookie + CSRF, mismo origen; ausencia de doctor surte efecto de inmediato y avisa al personal (no cancela citas); cambio permanente de horario lo aprueba el personal; el doctor no ve el telefono del paciente; `allowShortNotice` permite al personal omitir SOLO la antelacion de 60 min (PENDIENTE confirmar con la clinica si el personal esta exento de la regla 5).
- Cabecera/algoritmo reales de la firma del webhook de Zernio: sin verificar (confirmar con la documentacion de Zernio en F3).
- Disponibilidad por doctor (horario semanal + ausencias), en la BD y en la API.
- Precios: solo existe proctologia ($750, en la seccion Skills de `system_prompt.md`). Los demas, pendientes; hoy el bot dice que el equipo los confirmara.
- Quitar el aviso "entorno de PRUEBA" de `bot/system_prompt.md` antes de usarlo con pacientes reales.
- Aviso de privacidad / ley mexicana de datos personales: lo revisa la clinica, no el desarrollador.
- Hosting: PythonAnywhere requiere plan Developer (~$10/mes) para dominio propio, MySQL y salida a internet sin restriccion (verificar al contratar). Sin WebSockets: el calendario del personal consulta cada pocos segundos; avisos al doctor por push.
- Citas de prueba que quedaron en Google Calendar: 1 (Consultorio 1, 12-nov 13:30). Borrarla si se sigue usando Calendar.

## Convenciones
- Verificar con evidencia real (pruebas, salida de comandos) antes de afirmar que algo funciona. Decir con claridad lo que no se pudo probar.
- Cambios al motor de agenda: correr/ampliar `test_scheduler.py` (o su equivalente en la API) siempre.
- Python 3.12+ (usa `zoneinfo`; en Windows instalar `tzdata`).
