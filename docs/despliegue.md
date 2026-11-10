# Despliegue y corte (F8) — guia borrador

**Estado: borrador SIN PROBAR.** Aun no hay cuenta de PythonAnywhere ni servidor con todos los endpoints. Los datos de la
seccion 1 se leyeron en la documentacion oficial el 2026-11-10; lo marcado **(sin verificar)** hay que comprobarlo en el
panel al contratar. Los nombres de variables nuevas (SECRET_KEY, tokens...) son propuestas hasta que F3/F4 los fijen.

## 1. Lo verificado en la documentacion de PythonAnywhere

| Tema | Dato | Fuente |
|---|---|---|
| Plan necesario | **Developer, 10 USD/mes**: 1 web app con dominio propio, 5 GB, **MySQL**, **1 tarea siempre activa**, 20 tareas programadas (cada hora o dia), **3 web workers**, 5 000 s de CPU/dia, **salida a internet sin restriccion**. El plan gratis (Beginner) no tiene MySQL ni dominio propio y solo sale a sitios de una lista. Las paginas de precios hoy muestran Beginner / Developer / Custom. | [pricing](https://www.pythonanywhere.com/pricing/) |
| Dominio propio | Hay que crear la web app con un nombre `www.midominio.com` (o subdominio) y poner en el DNS un **CNAME** hacia `webapp-XXXX.pythonanywhere.com` (el valor exacto sale en la pestana *Web*). **Un CNAME no vale para el dominio "desnudo"** (sin `www`). | [CustomDomains](https://help.pythonanywhere.com/pages/CustomDomains/) |
| HTTPS | El plan lo ofrece, pero la pagina de ayuda que explica certificado y *Force HTTPS* devolvio 404 al consultarla: **(sin verificar)** el procedimiento exacto; se hace en la pestana *Web* despues de que el sitio responda por HTTP. | pricing (dice "free SSL support") |
| MySQL | Base con nombre `<usuario>$<nombre>`; usuario = tu usuario; el host sale en la pestana *Databases*. **Las conexiones inactivas se cierran a los 300 s** -> SQLAlchemy con `pool_recycle=280` (ya esta en `server/app/db.py`, junto con `pool_pre_ping`). No usar `init_command` que cambie variables de sistema (error 1227). Respaldo con `mysqldump`. | [UsingMySQL](https://help.pythonanywhere.com/pages/UsingMySQL/), [ManagingDatabaseConnections](https://help.pythonanywhere.com/pages/ManagingDatabaseConnections/) |
| Driver | `mysqlclient` viene preinstalado fuera de virtualenvs, pero en un venv hay que instalarlo; **PyMySQL es Python puro y no necesita compilar** (es el que usa `server/requirements.txt`). | UsingMySQL |
| Peticiones web | **Limite de 5 minutos** por peticion. **No se soportan hilos ni subprocesos** que sobrevivan a la peticion. **Sin WebSockets** (solo WSGI). Trabajo largo = cola + tarea siempre activa. | [AsyncInWebApps](https://help.pythonanywhere.com/pages/AsyncInWebApps/) y foros |
| Tareas siempre activas | Solo cuentas de pago; si se caen, se reinician solas. | [AlwaysOnTasks](https://help.pythonanywhere.com/pages/AlwaysOnTasks/) |
| Secretos / variables de entorno | La pagina consultada devolvio 404: **(sin verificar)**. Propuesta: archivo `.env` FUERA de la carpeta de la web app, permisos `600`, leido desde el WSGI. | — |
| Version de Python | Hace falta 3.12 (`zoneinfo`): **(sin verificar)** que este disponible al crear la web app. | — |

Consecuencias de diseno (ya cubiertas): la exclusion mutua de las reservas la da la BD (`UNIQUE`), no un candado en
proceso, porque habra 3 workers; el servidor no usa hilos; el calendario del personal refresca por consulta con `ETag`
(sin WebSockets); el poller del bot corre FUERA de PythonAnywhere (en el contenedor del agente), solo hace llamadas salientes.

## 2. Que corre donde

```
Zernio --(webhook, HTTPS fijo)--> PythonAnywhere: Flask (WSGI) + MySQL + estaticos admin/PWA
                                        ^  cola de eventos, API, interruptor del bot
                                        |  (solo conexiones SALIENTES desde el bot)
Contenedor del agente: bot/poller.py --+--> API de la clinica   y   --> Zernio (responder)
```
Sin tunel de Cloudflare ni `start.sh`/`stop.sh` actuales (esos son del bot viejo con el webhook directo).

## 3. Servidor en PythonAnywhere (orden sugerido)
1. Contratar **Developer**; elegir dominio (p. ej. `app.<dominio-de-la-clinica>`) y crear el CNAME. Confirmar que *Force HTTPS* queda activo.
2. Subir el codigo. Hoy el repo es solo local (sin remoto): o se crea un remoto PRIVADO (GitHub) y se hace `git clone` en una consola de PythonAnywhere, o se sube un zip. **Decision del usuario.**
3. Consola bash: `python3.12 -m venv ~/venv && source ~/venv/bin/activate && pip install -r server/requirements.txt` (sin `-dev`).
4. Pestana *Databases*: fijar contrasena de MySQL y crear la base `<usuario>$clinica`. `DATABASE_URL=mysql+pymysql://<usuario>:<clave>@<host de la pestana>/<usuario>$clinica?charset=utf8mb4` (escapar el `$` si se escribe en shell).
5. Crear `~/clinica.env` (permisos 600) con: `DATABASE_URL`, `SECRET_KEY`, secreto del webhook de Zernio, token del bot, claves VAPID (cuando exista el push). **Nunca en el repo.**
6. Archivo WSGI de la web app: cargar `~/clinica.env` en `os.environ`, anadir `server/` al `sys.path` y `from wsgi import app as application`.
7. En `server/` (con el venv activo y las variables cargadas): `flask --app wsgi upgrade-db` y `flask --app wsgi seed` (el seed deja el **interruptor del bot apagado**; es lo deseable hasta el corte). Crear el primer usuario administrador (comando de F4, por definir).
8. *Static files* de la pestana *Web*: `/admin/` -> build de `admin-web`, `/doctor/` -> build de `doctor-pwa`. *Reload*.
9. Humo: `GET /api/health`; iniciar sesion; abrir el calendario.
10. Respaldo: tarea programada **diaria** con `mysqldump` a un archivo fechado + copia fuera de PythonAnywhere (por definir donde). **Probar una restauracion** antes del corte.

## 4. Zernio
- Registrar (o actualizar) el webhook con URL fija `https://<dominio>/webhooks/zernio`, evento `message.received` y un **secreto elegido por la clinica**. Cabecera de firma `X-Zernio-Signature`, HMAC-SHA256 hex del cuerpo crudo.
- **Cuidado:** Zernio manda a su cola de eventos muertos, en el PRIMER intento, cualquier 4xx (incluido el 401 de firma invalida). Probar primero con un `webhook.test` (`POST /v1/webhooks/test`) y verificar que responde 200 antes de activar el webhook de produccion. Los eventos muertos se pueden redistribuir desde Zernio.
- **(sin verificar)** si la cuenta permite DOS webhooks a la vez (necesario para el ensayo en paralelo de la seccion 6).

## 5. Bot en el contenedor del agente
- Variables: `WATHSBOT_BACKEND=api`, `CLINICA_API_URL`, `CLINICA_BOT_TOKEN`, `ZERNIO_API_KEY`, `ANTHROPIC_API_KEY` y `WATHSBOT_LLM=api` (cualquier valor distinto de `cli`; en produccion no usar la suscripcion, hoy el defecto es el CLI). Fijar `WATHSBOT_MODEL` a proposito: el defecto del codigo para la API es `claude-haiku-4-5`, un modelo anterior a los actuales; elegir el modelo es decision del usuario y se prueba antes con `e2e_sim.py`. Opcionales del poller: `WATHSBOT_WORKERS`, `WATHSBOT_POLL_SECONDS`, `WATHSBOT_LEASE_SECONDS`.
- Arranque: `python poller.py` (hace falta un `run_poller.sh`/servicio equivalente, **pendiente**: sustituir `run.sh`/`start.sh`/`stop.sh`).
- Antes de pacientes reales: quitar el aviso "entorno de PRUEBA" de `bot/system_prompt.md`, cargar precios (hoy solo proctologia, 750 MXN) y cerrar con la clinica el aviso de privacidad.

## 6. Ensayo y corte
Ensayo (sin riesgo para pacientes):
1. Servidor arriba, interruptor del bot **apagado**, webhook de prueba apuntando al servidor nuevo (si Zernio permite un segundo webhook; si no, ensayar con mensajes de prueba y `webhook.test`).
2. `WATHSBOT_DRY_RUN=1` en el poller: lee la cola real, arma la respuesta, **no** la envia. Revisar los registros.
3. Que el personal use el calendario unos dias con citas reales cargadas a mano y compare con Google Calendar.

Corte (en horario de poca demanda):
1. Pasar las citas vigentes de Google Calendar a la BD (hoy solo hay 1 cita de prueba; borrarla o cargarla a mano).
2. Apagar el bot viejo (`stop.sh`: desactiva el webhook actual y mata el servicio/tunel).
3. Activar el webhook nuevo -> encender el poller sin `DRY_RUN` -> **encender el interruptor** desde la web.
4. Mandar un mensaje de prueba por WhatsApp y recorrer: pedir horarios, agendar, ver, reprogramar, cancelar; ver la cita en el calendario.

Rollback (minutos): apagar el interruptor del bot (deja de contestar; atiende el personal desde Zernio) -> detener el poller -> restaurar los archivos de `bot/` de la etiqueta `pre-api` (en la maquina de desarrollo: `git archive pre-api bot | tar -x -C <carpeta-temporal>` y copiarlos al contenedor, que no tiene el repo) -> `start.sh` (reapunta el webhook al tunel y reactiva el bot con Google Calendar). Las citas creadas en la BD durante la prueba se pasan a mano.

## 7. Riesgos abiertos
- Sin cuenta ni servidor probados: todo lo de la seccion 3 es teoria hasta el primer despliegue de prueba.
- 5 000 s de CPU al dia: un poller cada 2 s y varios calendarios abiertos son unas decenas de miles de peticiones cortas; se espera holgura, **medir** en la primera semana. Si se excede, el sitio se frena (tarpit).
- Entrega "al menos una vez": un reinicio del poller entre contestar y confirmar puede duplicar una respuesta.
- Una sola tarea siempre activa disponible: reservarla para el envio de push u otra cola si hiciera falta (no se usa hoy).
