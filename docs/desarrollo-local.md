# Probar la aplicación en tu máquina (antes de desplegar)

Con un solo comando levantas **todo** en tu computadora: el servidor real (Flask), la web de administración y la PWA del doctor,
con una base de datos de ejemplo. Nada sale de tu máquina y no toca PythonAnywhere ni WhatsApp.

## 1. Una sola vez

Necesitas Python 3.10 o más nuevo y Node 22 (los dos ya los tienes si has corrido las pruebas).

```bash
# desde la raíz del repositorio
npm install

cd server
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt     # Linux/macOS: .venv/bin/python
```

Si el entorno de `server/.venv` ya existe, no hagas nada.

## 2. Arrancar

```bash
# desde la raíz del repositorio
npm run dev:local
```

La primera vez crea la base de desarrollo (`server/instance/dev.db`) con doctores, usuarios, citas de ejemplo (en los próximos tres
días hábiles), una ausencia, una solicitud de cambio de horario y un caso de atención. Después imprime esto:

| Qué | Dónde | Usuario |
|---|---|---|
| Web de administración | http://127.0.0.1:5180 | `admin@dev.test` o `recepcion@dev.test` |
| PWA del doctor | http://127.0.0.1:5181 | el código `1001`, `1002` o `1003` (se elige en una lista; sin correo) |
| Servidor (API) | http://127.0.0.1:5000/api/health | — |

La contraseña de todos es `clave-de-desarrollo-1`. Es **solo de desarrollo**: está en el código y los scripts se niegan a usarla
con cualquier base que no sea `server/instance/dev.db`. **Ctrl+C** detiene los tres programas.

> Las dos webs comparten la sesión (las cookies no se separan por puerto en `127.0.0.1`). Si entras como personal en una y luego
> abres la otra, te dirá "esta app es para los doctores" o al revés: cierra sesión primero.

## 3. Qué probar

**Como personal (`recepcion@dev.test`) en la web de administración**
- Calendario: cambia entre Día, Semana, Mes y Lista; filtra por doctor; abre una cita (se ve el teléfono del paciente).
- Cambia una cita a "realizada", "no asistió" o "cancelada"; muévela de horario.
- *Nueva cita*: agenda una libre; intenta una que choque (debe avisar "ese horario ya no está libre"); prueba una fuera de horario.
- *Bloquear horario*: bloquea un consultorio y comprueba que ya no caben dos citas a esa hora.
- Botón **Bot**: enciéndelo y apágalo (pide confirmación al apagar).
- **Doctores**: aprueba o rechaza la solicitud de cambio de horario (si queda alguna cita fuera del nuevo horario, te lo avisa).
- **Atención**: marca como atendido el caso del paciente que pidió hablar con una persona.

**Como administrador (`admin@dev.test`)**: lo anterior, más *Usuarios* (crear, desactivar, restablecer contraseña) y editar el horario
de la clínica y los doctores.

**Como doctor (código `1001`) en la PWA**
- *Crear tu contraseña*: en la web de administración (`recepcion@dev.test`) da de alta un doctor en *Doctores* (su cuenta nace sola, sin contraseña), abre su pestaña *Datos* y pulsa **Generar enlace y copiar**. El texto copiado (nombre, código y enlace, listo para WhatsApp) trae un enlace a `http://127.0.0.1:5181/#/contrasena?t=…`: ábrelo, crea la contraseña y quedas dentro; el mismo botón sirve para recuperar una contraseña olvidada. (El servidor de desarrollo pone `DOCTOR_APP_URL` solo.)
- *Entrar*: no pide correo. El campo «Usuario» es una lista con **código y nombre** de cada doctor que tiene cuenta (aquí `1001` Cervantes, `1002` Pérez Lago, `1003` Bordas); escribe parte del código o del nombre y se reduce, y la contraseña la escribes tú.
- *Hoy* y *Semana*: solo ves **tus** citas y nunca el teléfono del paciente.
- *Ausencias*: registra una que cubra citas (te dice cuántas son) y luego mira en la web de administración, en *Atención*, el aviso.
- *Horario*: pide un cambio permanente y apruébalo desde la web de administración.

## 4. El bot, sin WhatsApp

**Hablar con el bot de verdad** (usa el modelo del propio bot: el CLI `claude` con tu suscripción, **no** una `ANTHROPIC_API_KEY`):
1. Con `npm run dev:local` en marcha, en la web de administración (`recepcion@dev.test`) **enciende el botón Bot** (el servidor de
   desarrollo lo arranca apagado, como en producción).
2. En otra terminal, desde la raíz:

```bash
npm run dev:bot
```

Tú eres el paciente. El bot revisa el interruptor, lee doctores y horarios de la API, ofrece horarios reales, agenda, consulta, reprograma y
cancela; en la terminal se ven las líneas `ACTION ...` con lo que pidió a la API, y la cita aparece en el calendario de la web. Comandos:
`/nuevo`, `/tel 5299...` (cambia de paciente: no ve las citas del otro) y `/salir`. **No se envía nada a WhatsApp.** Cada respuesta tarda
entre 6 y 30 s. Apaga el botón Bot y escribe otra vez: el bot calla. Guía completa, incluido el cambio del bot de Hostinger: `docs/bot-hostinger.md`.

**Ver que un mensaje de WhatsApp llega a la cola** (modo alternativo con cola; no necesita modelo):

```bash
cd server
.venv/Scripts/python scripts/dev_webhook.py "Hola, quiero una cita de proctologia"
# 200 {"ok":true,"queued":true}   <- el servidor verificó la firma y encoló el mensaje
```

## 5. Pruebas automáticas

```bash
npm test && npm run typecheck && npm run build                            # JS: cliente, calendario, web y PWA
cd server && .venv/Scripts/python -m pytest tests -q                       # servidor (SQLite)
cd bot && python test_scheduler.py && python test_api_client.py && python test_bot_direct.py   # bot
TEST_MYSQL_DOCKER=1 .venv/Scripts/python -m pytest tests -q                # servidor también contra MySQL 8 (Docker Desktop abierto)
```

## 6. Lo que NO prueba tu máquina

- **MySQL de PythonAnywhere** (3 conexiones por usuario, Python 3.10 real): se valida corriendo `python scripts/pa_run_tests.py` en su
  consola (ver `docs/despliegue.md`). Aquí el servidor usa SQLite; las pruebas con MySQL sí corren en Docker.
- **HTTPS y la cookie `Secure`**: aquí va sin `Secure` a propósito (`AUTH_COOKIE_SECURE=0`); en producción va activada.
- **WhatsApp y Zernio reales**, el **push real** y la PWA **instalada** en un teléfono.
- **Servir las webs desde Flask**: aún no está hecho (es parte del despliegue, F8). En local las sirve Vite; `npm run build` solo
  comprueba que compilan.

## 7. Problemas comunes

| Síntoma | Qué hacer |
|---|---|
| "No encuentro el entorno de Python" | Haz el paso 1 (`python -m venv .venv` y `pip install` dentro de `server/`). |
| Puerto 5000, 5180 o 5181 ocupado | Cierra lo que lo use (otra copia de `dev:local`) y repite. |
| 403 al guardar algo | Casi siempre es otra copia de la web con otra sesión; recarga e inicia sesión de nuevo. |
| Quiero los datos de ejemplo como al principio | `cd server && .venv/Scripts/python scripts/dev_seed.py --reset` |
| Cerré la ventana sin Ctrl+C y quedó algo corriendo | Busca los procesos `node` y `python` del proyecto y ciérralos desde el Administrador de tareas. |

## Archivos

`scripts/dev-local.mjs` (el comando único) · `server/scripts/dev_seed.py` (datos de ejemplo) · `server/scripts/dev_server.py` (servidor
local) · `server/scripts/dev_webhook.py` (simula un mensaje de WhatsApp).
