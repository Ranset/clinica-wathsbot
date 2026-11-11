# Despliegue y corte (F8) — guia borrador

**Estado: borrador SIN PROBAR.** Aun no hay cuenta de PythonAnywhere ni servidor con todos los endpoints. Los datos de la
seccion 1 se leyeron en la documentacion oficial el 2026-11-10; lo marcado **(sin verificar)** hay que comprobarlo en el
panel al contratar. Los nombres de variables nuevas (SECRET_KEY, tokens...) son propuestas hasta que F3/F4 los fijen.

## 1. Lo verificado en la documentacion de PythonAnywhere

| Tema | Dato | Fuente |
|---|---|---|
| Plan necesario | **Developer, 10 USD/mes**: 1 web app con dominio propio, 5 GB, **MySQL**, **1 tarea siempre activa**, 20 tareas programadas (cada hora o dia), **3 web workers**, 5 000 s de CPU/dia, **salida a internet sin restriccion**. El plan gratis (Beginner) NUEVO no tiene MySQL ni tareas programadas, no admite dominio propio y solo sale a sitios de una lista; las cuentas gratuitas anteriores a enero de 2026 conservan MySQL (ver 1b). Las paginas de precios hoy muestran Beginner / Developer / Custom. | [pricing](https://www.pythonanywhere.com/pricing/) |
| Dominio propio | Hay que crear la web app con un nombre `www.midominio.com` (o subdominio) y poner en el DNS un **CNAME** hacia `webapp-XXXX.pythonanywhere.com` (el valor exacto sale en la pestana *Web*). **Un CNAME no vale para el dominio "desnudo"** (sin `www`). | [CustomDomains](https://help.pythonanywhere.com/pages/CustomDomains/) |
| HTTPS | El plan lo ofrece, pero la pagina de ayuda que explica certificado y *Force HTTPS* devolvio 404 al consultarla: **(sin verificar)** el procedimiento exacto; se hace en la pestana *Web* despues de que el sitio responda por HTTP. | pricing (dice "free SSL support") |
| MySQL | Base con nombre `<usuario>$<nombre>`; usuario = tu usuario; el host sale en la pestana *Databases*. **Las conexiones inactivas se cierran a los 300 s** -> SQLAlchemy con `pool_recycle=280` (ya esta en `server/app/db.py`, junto con `pool_pre_ping`). No usar `init_command` que cambie variables de sistema (error 1227). Respaldo con `mysqldump`. **La base que crea la pestana *Databases* nace en `utf8mb3`** (verificado el 2026-11-10 con `@@character_set_database`) y `utf8mb3` no guarda emojis: la migracion `0001` fija todas las tablas en `utf8mb4`. | [UsingMySQL](https://help.pythonanywhere.com/pages/UsingMySQL/), [ManagingDatabaseConnections](https://help.pythonanywhere.com/pages/ManagingDatabaseConnections/) |
| Driver | `mysqlclient` viene preinstalado fuera de virtualenvs, pero en un venv hay que instalarlo; **PyMySQL es Python puro y no necesita compilar** (es el que usa `server/requirements.txt`). | UsingMySQL |
| Peticiones web | **Limite de 5 minutos** por peticion. **No se soportan hilos ni subprocesos** que sobrevivan a la peticion. **Sin WebSockets** (solo WSGI). Trabajo largo = cola + tarea siempre activa. | [AsyncInWebApps](https://help.pythonanywhere.com/pages/AsyncInWebApps/) y foros |
| Tareas siempre activas | Solo cuentas de pago; si se caen, se reinician solas. | [AlwaysOnTasks](https://help.pythonanywhere.com/pages/AlwaysOnTasks/) |
| Secretos / variables de entorno | La pagina consultada devolvio 404: **(sin verificar)**. Propuesta: archivo `.env` FUERA de la carpeta de la web app, permisos `600`, leido desde el WSGI. | — |
| Version de Python | La consola de tu cuenta trae **3.10.5** (captura). El codigo del proyecto exige **>= 3.9** (calculado con `vermin` sobre `bot/` y `server/`), asi que corre en 3.10; las dependencias se fijaron para 3.10 (**SQLAlchemy 2.0.57**: la 2.1 exige 3.11). La version de la web app se elige en la pestana *Web*: **(sin verificar)** cuales ofrece. | captura + `vermin` |

Consecuencias de diseno (ya cubiertas): la exclusion mutua de las reservas la da la BD (`UNIQUE`), no un candado en
proceso, porque habra 3 workers; el servidor no usa hilos; el calendario del personal refresca por consulta con `ETag`
(sin WebSockets); el poller del bot corre FUERA de PythonAnywhere (en el contenedor del agente), solo hace llamadas salientes.

## 1b. Tu cuenta de PythonAnywhere (capturas del 2026-11-10)
- **Cuenta GRATUITA anterior a enero de 2026** (la pagina de MySQL dice "since you have a free account"). Conserva **MySQL 8.0.46** (consola MySQL) y, segun la documentacion, 1 tarea programada diaria (**comprobar en la pestana *Tasks***). Esos beneficios son de "cuentas anteriores": una cuenta nueva no los tiene.
- **MySQL:** host `Ranset83.mysql.pythonanywhere-services.com`, usuario `Ranset83`. **Solo se puede conectar desde codigo que corre dentro de PythonAnywhere**: las migraciones (`flask --app wsgi upgrade-db`), el `seed` y los respaldos se ejecutan en una consola de PythonAnywhere, no desde la PC. Ya existe una base `Ranset83$crud` (de otra prueba): **no reutilizarla**; crear `Ranset83$clinica` (y `Ranset83$clinica_test` para las pruebas).
- **Dominio:** el gratuito `ranset83.pythonanywhere.com` (HTTPS incluido, sin CNAME). El webhook de Zernio quedaria en `https://ranset83.pythonanywhere.com/webhooks/zernio`.
- **Python:** consola con 3.10.5 -> ver fila "Version de Python" arriba.

Limites de la cuenta gratuita que pesan en este proyecto ([FreeAccountsFeatures](https://help.pythonanywhere.com/pages/FreeAccountsFeatures/), [WhatAreCPUSeconds](https://help.pythonanywhere.com/pages/WhatAreCPUSeconds/), [blog 2025-12-15](https://blog.pythonanywhere.com/221/); la pagina de funciones tiene ~300 dias):
| Limite | Efecto |
|---|---|
| **1 web app, 1 web worker**, expira al **mes** ("unused web apps will expire after 1 month") | Si la web app expira, el webhook deja de recibir y Zernio reintenta y luego manda a eventos muertos. **Comprobar en la pestana *Web* la fecha de caducidad y como se extiende** (el articulo no lo detalla). Con 1 worker se atiende una peticion a la vez. |
| **100 s de CPU/dia**, solo consolas y tareas; **las peticiones de la web app NO cuentan "actualmente"** | El poller (2 s) y los calendarios abiertos no gastan esa cuota, pero la palabra "actualmente" avisa que puede cambiar. Las migraciones, el seed y las pruebas por consola SI la gastan: no instalar dependencias ni correr toda la suite varias veces al dia. |
| **3 conexiones MySQL simultaneas por usuario** (`max_user_connections`, error 1226; **verificado el 2026-11-10** al correr las pruebas de concurrencia en la cuenta) | La web app debe usar **`POOL_SIZE=1`** (variable de entorno; maximo 2 conexiones) y asi deja una libre para la consola, migraciones y respaldos. Sin ella SQLAlchemy abre hasta 15 por proceso y fallaria bajo carga. No tener una consola MySQL abierta mientras corre la web app o las pruebas. El limite del plan Developer: **sin verificar**. |
| **512 MiB** de disco, compartido con MySQL | Sobra para datos de citas; vigilar `node_modules` (no subirlo: solo los builds de `admin-web`/`doctor-pwa`). |
| 2 consolas, **sin tareas siempre activas** | Nada de procesos propios dentro de PythonAnywhere; el poller del bot sigue en el contenedor del agente. |
| Salida a internet **solo a sitios de una lista (proxy)** | El servidor no llama a Zernio (lo hace el bot), pero el **envio de push al doctor (F7) probablemente no funcione** en la cuenta gratuita. |
| Soporte solo por foros | Sin ayuda directa si falla el servicio en horario de consulta. |

**Recomendacion:** la cuenta gratuita sirve para desarrollar y ensayar con datos de prueba. Para **pacientes reales** conviene pasar a Developer (10 USD/mes): sin caducidad mensual de la web app, 3 workers, tareas siempre activas, salida sin restriccion y un servicio con respaldo oficial; ademas son datos personales (nombre y telefono) de la clinica. Decision del usuario y de la clinica.

**Prueba util en tu cuenta (cierra dos dudas con evidencia):** subir el repo, crear `~/venv` con `python3.10`, `pip install -r server/requirements-dev.txt` y correr, desde `server/`, `python scripts/pa_run_tests.py` (pregunta usuario/host/base con valores por defecto y la clave oculta; comprueba la conexion antes de lanzar la suite y se niega a vaciar una base cuyo nombre no termine en `_test`; la base es `Ranset83$clinica_test`). Eso corre en Python 3.10 REAL y ejecuta contra MySQL 8.0.46 las ~54 pruebas que hoy se saltan (concurrencia y `UNIQUE`), que es lo mas importante del motor. La clave de MySQL la escribes tu en tu consola; no la compartas aqui. Cuida la cuota de 100 s de CPU: una sola corrida.

**Resultado de las dos primeras corridas (2026-11-10, Python 3.10.5 real + MySQL 8.0.46):** la primera destapo `no such function: MOD` (el SQLite de la cuenta no trae funciones matematicas; el CHECK de duracion paso a usar `%`). La segunda dio 144 pruebas bien y 8 fallos, por tres causas reales ya corregidas en el codigo: (1) `max_user_connections = 3` (las 6 pruebas de concurrencia `[mysql]`: el script `pa_run_tests.py` ahora detecta el limite y reduce pool y procesos; ver la fila de conexiones arriba), (2) tablas en `utf8mb3` (migracion y prueba con emoji) y (3) `make_engine` ignoraba `pool_size` en SQLite. **Tercera corrida (2026-11-10, tras las correcciones), `python scripts/pa_run_tests.py -k "mysql or 20_reservas"`: 71 pruebas, 71 bien, en 41 s**, con las 70 variantes `[mysql]` (incluidas concurrencia, `UNIQUE`, migracion en `utf8mb4` sobre una base `utf8mb3` y el emoji) y `20_reservas[sqlite]`. Alcance: las otras 83 pruebas (solo SQLite y contrato) pasaron en la segunda corrida con el codigo anterior y no se repitieron en la cuenta tras el ultimo cambio (si se quiere, una corrida completa gasta CPU: `python scripts/pa_run_tests.py`). Con 3 conexiones la concurrencia que se prueba en MySQL es de 2 transacciones a la vez (y 3 procesos), no de 40.

## 2. Que corre donde

```
Paciente --WhatsApp--> Zernio --(webhook)--> BOT en Hostinger (bot/server.py, WATHSBOT_BACKEND=api)
                                                |  (solo conexiones SALIENTES, Bearer BOT_TOKEN)
                                                v
                              PythonAnywhere: Flask (WSGI) + MySQL + estaticos admin/PWA
                              interruptor, doctores y horarios, disponibilidad, citas, traspasos a una persona
```
**Decision revisada (2026-11-11): el webhook de Zernio sigue llegando al bot** (como hoy), no al servidor de la clinica. El bot ya no usa
Google Calendar: se configura y agenda a traves de la API. Detalle y pasos del cambio en `docs/bot-hostinger.md`. El camino con cola (Zernio ->
servidor -> cola -> `poller.py`, la "decision A" original) sigue implementado y probado como **alternativa** (`WATHSBOT_INGRESS=queue`); las
secciones 4 y 5 lo describen.

## 3. Servidor en PythonAnywhere (orden sugerido)
1. **Ensayo:** la cuenta gratuita actual, con `ranset83.pythonanywhere.com` (HTTPS incluido, sin CNAME); en la pestana *Web* anotar la fecha de caducidad y como se extiende. **Produccion con pacientes reales:** pasar a **Developer** y, si se quiere, dominio propio (subdominio `www` o `app` con CNAME); confirmar que *Force HTTPS* queda activo.
2. Subir el codigo. Hoy el repo es solo local (sin remoto): o se crea un remoto PRIVADO (GitHub) y se hace `git clone` en una consola de PythonAnywhere, o se sube un zip. **Decision del usuario.**
3. Consola bash (Python 3.10.5): `python3.10 -m venv ~/venv && source ~/venv/bin/activate && pip install -r server/requirements.txt` (sin `-dev`; `requirements.txt` ya fija SQLAlchemy 2.0.57 por compatibilidad con 3.10). Elegir 3.10 tambien en la pestana *Web*.
4. Pestana *Databases*: fijar la contrasena de MySQL (la escribes tu, no se comparte) y crear la base `clinica` (queda `Ranset83$clinica`; **no usar `Ranset83$crud`**). `DATABASE_URL=mysql+pymysql://Ranset83:<clave>@Ranset83.mysql.pythonanywhere-services.com/Ranset83$clinica?charset=utf8mb4` (entre comillas simples en bash por el `$`).
5. Crear `~/clinica.env` (permisos 600) con: `DATABASE_URL`, **`POOL_SIZE=1`** (el MySQL gratuito solo da 3 conexiones por usuario), **`BOT_TOKEN`** (generar uno con `flask --app wsgi gen-token`; el MISMO valor va en el bot como `CLINICA_BOT_TOKEN`), **`ZERNIO_WEBHOOK_SECRET`** (el secreto que elija la clinica y que se registra tal cual en Zernio), `SECRET_KEY` (F4) y las claves VAPID (cuando exista el push). **Nunca en el repo.** Sin `BOT_TOKEN` todo `/api/bot/*` responde 401; sin `ZERNIO_WEBHOOK_SECRET` el webhook responde 503 (a proposito: Zernio reintenta los 5xx, pero manda a eventos muertos cualquier otro 4xx).
6. Archivo WSGI de la web app: cargar `~/clinica.env` en `os.environ`, anadir `server/` al `sys.path` y `from wsgi import app as application`.
7. En `server/` (con el venv activo y las variables cargadas): `flask --app wsgi upgrade-db` y `flask --app wsgi seed` (el seed deja el **interruptor del bot apagado**; es lo deseable hasta el corte). Crear el primer administrador con `flask --app wsgi create-user --role admin` (pide correo, nombre y la clave, oculta y con confirmacion; minimo 10 caracteres; la clave nunca va por argumento). Recuperar el acceso: `flask --app wsgi set-password`. Con la web ya en `https://`, la cookie de sesion lleva `Secure` (no poner `AUTH_COOKIE_SECURE=0` fuera de desarrollo).
8. *Static files* de la pestana *Web*: `/admin/` -> build de `admin-web`, `/doctor/` -> build de `doctor-pwa`. *Reload*.
9. Humo: `GET /api/health`; `GET /api/bot/status` SIN token debe dar 401 y CON `Authorization: Bearer <BOT_TOKEN>` 200 con `{"active": false}`; un `POST /webhooks/zernio` sin firma debe dar 401 (no 5xx); iniciar sesion y abrir el calendario (F4/F6).
10. Respaldo: tarea programada **diaria** con `mysqldump` a un archivo fechado + copia fuera de PythonAnywhere (por definir donde). La cuenta gratuita anterior deberia tener 1 tarea diaria (**comprobar en *Tasks***); si no, el respaldo es manual desde la consola. Los 512 MiB incluyen los respaldos: borrar los viejos. **Probar una restauracion** antes del corte.

## 4. Zernio (solo si se usa la cola; con el webhook directo al bot, Zernio no cambia)
- Registrar (o actualizar) el webhook con URL fija `https://<dominio>/webhooks/zernio`, evento `message.received` y un **secreto elegido por la clinica**. Cabecera de firma `X-Zernio-Signature`, HMAC-SHA256 hex del cuerpo crudo.
- **Cuidado:** Zernio manda a su cola de eventos muertos, en el PRIMER intento, cualquier 4xx (incluido el 401 de firma invalida). Probar primero con un `webhook.test` (`POST /v1/webhooks/test`) y verificar que responde 200 antes de activar el webhook de produccion. Los eventos muertos se pueden redistribuir desde Zernio.
- El servidor (F3, implementado) verifica la firma, encola SOLO los `message.received` de pacientes por WhatsApp (el `webhook.test` y lo demas se responde 200 y se descarta), es idempotente por id de evento y, al cerrar cada evento, **borra el texto del mensaje** de la cola (solo conserva conversacion y telefono para poder contactar al paciente). Si el bot esta apagado o se cae, los mensajes esperan en la cola; tras 5 intentos fallidos aparecen como caso de atencion para el personal.
- **(sin verificar)** si la cuenta permite DOS webhooks a la vez (necesario para el ensayo en paralelo de la seccion 6).

## 5. Bot: modo con cola (alternativa) y datos comunes
El modo principal (webhook directo al bot de Hostinger) esta en `docs/bot-hostinger.md`. Lo siguiente aplica al modo con cola salvo donde se indica.
- Variables: `WATHSBOT_BACKEND=api`, `CLINICA_API_URL`, `CLINICA_BOT_TOKEN`, `ZERNIO_API_KEY`, `ANTHROPIC_API_KEY` y `WATHSBOT_LLM=api` (cualquier valor distinto de `cli`; en produccion no usar la suscripcion, hoy el defecto es el CLI). Fijar `WATHSBOT_MODEL` a proposito: el defecto del codigo para la API es `claude-haiku-4-5`, un modelo anterior a los actuales; elegir el modelo es decision del usuario y se prueba antes con `e2e_sim.py`. Opcionales del poller: `WATHSBOT_WORKERS`, `WATHSBOT_POLL_SECONDS`, `WATHSBOT_LEASE_SECONDS`.
- El modelo de hoy es el CLI `claude` (`WATHSBOT_LLM=cli`, defecto): **el usuario decidio no usar `ANTHROPIC_API_KEY`**; la linea anterior aplica solo si algun dia se cambia esa decision.
- Arranque: `python poller.py` (hace falta un `run_poller.sh`/servicio equivalente, **pendiente**: sustituir `run.sh`/`start.sh`/`stop.sh`).
- Antes de pacientes reales: quitar el aviso "entorno de PRUEBA" de `bot/system_prompt.md`, cargar precios (hoy solo proctologia, 750 MXN) y cerrar con la clinica el aviso de privacidad.

## 6. Ensayo y corte (modo con cola; para el webhook directo ver `docs/bot-hostinger.md`)
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
- CPU: hoy las peticiones de la web app no cuentan para la cuota (la documentacion dice "currently", puede cambiar). En Developer la cuota es de 5 000 s/dia, en la gratuita 100 s/dia; si algun dia contaran, un poller cada 2 s son ~43 000 peticiones/dia: **medir** y subir `WATHSBOT_POLL_SECONDS` si hace falta. Pasada la cuota el sitio se frena (tarpit), no se apaga.
- **Caducidad mensual** de la web app gratuita (por confirmar el mecanismo): un olvido deja sin webhook a la clinica. Otra razon para Developer en produccion.
- Entrega "al menos una vez": un reinicio del poller entre contestar y confirmar puede duplicar una respuesta.
- Una sola tarea siempre activa disponible: reservarla para el envio de push u otra cola si hiciera falta (no se usa hoy).
