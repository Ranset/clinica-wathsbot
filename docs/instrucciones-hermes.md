# Instrucciones para Hermes: conectar Wathsbot a la API de la clínica

Eres Hermes y operas el bot de WhatsApp **Wathsbot** (`/data/profiles/wathsbot/workspace/wathsbot`). Tu tarea: que el bot deje de usar
Google Calendar y datos fijos, y **trabaje a través de la API de la clínica como un empleado más**: pregunta si está activo, lee
doctores y horarios vigentes, consulta disponibilidad y agenda/consulta/reprograma/cancela citas, y pasa el caso a una persona
cuando no puede ayudar.

**No cambies cómo el bot recibe los mensajes.** Zernio sigue llamando al bot (puerto 8791, `run.sh`, `start.sh` y su túnel) igual que hoy.
Solo cambia de dónde saca la agenda.

- URL de la API (prueba): `https://cmcash.dpdns.org` (túnel hacia la computadora del usuario; solo responde `/api/bot/*`).
- Token: te lo da el usuario (variable `BOT_TOKEN` de su servidor). **Nunca lo imprimas, lo pegues en chats ni lo escribas en
  los registros.** Guárdalo en un archivo con permisos 600.

## Archivos que recibes (carpeta `bot/` del repositorio)
| Archivo | Qué hacer |
|---|---|
| `server.py` | **Reemplaza** el actual (haz respaldo antes). |
| `api_client.py` | **Nuevo**: cliente de la API (solo librería estándar). |
| `clinic_info.py` | **Nuevo**: pone en el prompt el horario y los doctores vigentes. |
| `system_prompt.md` | **No lo sobrescribas.** Se conserva el tuyo. Solo debe tener las líneas que empiezan exactamente con `- Horario:` y `- Especialidades y doctores:`: el bot las sustituye en cada mensaje con los datos de la API. Si no existen, las agrega al final. |
| `scheduler.py`, `gcal_auth.py` | No los toques ni los borres: son el camino de vuelta. |

## Pasos

**1. Respaldo.** `cp -a /data/profiles/wathsbot/workspace/wathsbot /data/profiles/wathsbot/workspace/wathsbot.bak-$(date +%Y%m%d)`

**2. Copia los archivos** (`server.py`, `api_client.py`, `clinic_info.py`) a la carpeta del bot.

**3. Comprueba Python.** `/opt/venv/bin/python` debe ser 3.9 o superior y conocer la zona horaria:
```bash
/opt/venv/bin/python -c "import sys; from zoneinfo import ZoneInfo; ZoneInfo('America/Cancun'); print(sys.version)"
```
Si falla por la zona horaria: `/opt/venv/bin/pip install tzdata`. Si la versión es menor a 3.9, detente y avisa al usuario.

**4. Guarda el token** (el usuario te lo da; escríbelo sin mostrarlo):
```bash
umask 077; printf '%s' '<TOKEN>' > /data/profiles/wathsbot/clinica_bot_token
```

**5. Prueba de conexión (no afecta a ningún paciente).** Debe imprimir `activo = True` (o `False`) y la lista de 7 doctores:
```bash
cd /data/profiles/wathsbot/workspace/wathsbot && CLINICA_API_URL=https://cmcash.dpdns.org \
CLINICA_BOT_TOKEN="$(cat /data/profiles/wathsbot/clinica_bot_token)" /opt/venv/bin/python -c \
"import api_client as a; c=a.ApiAgenda(); print('activo =', c.bot_active()); print([d['name'] for d in c.config()['doctors']])"
```
Si lanza `ApiUnavailable`: `HTTP 401` = token distinto al del servidor; `HTTP 404` = URL equivocada; `HTTP 5xx`/error de red = el túnel
o el servidor del usuario están apagados. Avisa al usuario; no sigas hasta que funcione.

**6. Configura `run.sh`.** Antes de la línea `exec /opt/venv/bin/python server.py` agrega:
```bash
export WATHSBOT_BACKEND=api
export CLINICA_API_URL=https://cmcash.dpdns.org
export CLINICA_BOT_TOKEN="$(cat /data/profiles/wathsbot/clinica_bot_token)"
```
Deja todo lo demás (puerto 8791, secreto del webhook, `ZERNIO_API_KEY`) tal cual. El modelo sigue siendo el CLI `claude`
(`WATHSBOT_LLM` por defecto); **no se usa `ANTHROPIC_API_KEY`.**

**7. Reinicia SOLO el servicio** (no uses `stop.sh`: desactiva el webhook de Zernio; tampoco hace falta `start.sh`, el túnel actual sigue
apuntando al puerto 8791):
```bash
cd /data/profiles/wathsbot/workspace/wathsbot
kill "$(cat server.pid)"; sleep 1
./run.sh >> server.log 2>&1 & echo $! > server.pid
sleep 3; tail -n 5 server.log
```
En `server.log` debe aparecer una línea así (los doctores y el horario salen de la API):
```
HH:MM:SS agenda=API https://cmcash.dpdns.org OK | bot ACTIVO | 7 doctores | horario: lunes a viernes 9:00 a 18:00 hrs, sabados 9:00 a 13:00 hrs
```
- `bot APAGADO (no contestara)`: el botón **Bot** de la web de la clínica está apagado; pídele al usuario que lo encienda.
- `agenda=API ... NO RESPONDE`: vuelve al paso 5.

**8. Ensayo opcional sin enviar nada:** agrega `export WATHSBOT_DRY_RUN=1` en `run.sh`, reinicia (paso 7) y mira `server.log`: verás
`IN: ... -> OUT: ...` con lo que contestaría. **Con DRY_RUN el bot deja de contestar a todos**, así que hazlo breve y quítalo después.

**9. Prueba real.** Con `DRY_RUN` quitado y el botón **Bot** encendido, el usuario escribe por WhatsApp. Recorre con él: preguntar el
horario; pedir cita de una especialidad; elegir un horario concreto y dar nombre completo; "¿qué citas tengo?"; reprogramar; cancelar.
En `server.log` verás líneas `ACTION horarios|cercanos|agendar|mis_citas|cancelar|reprogramar -> {...}`: son las llamadas a la API.
La cita debe aparecer en el calendario de la clínica. Con el botón **Bot** apagado el bot no debe contestar nada.

**10. Marcha atrás (un minuto).** En `run.sh` comenta los tres `export` del paso 6 (o pon `WATHSBOT_BACKEND=google`) y reinicia como en el
paso 7: vuelve el bot con Google Calendar. También sirve apagar el botón **Bot** de la clínica para que deje de contestar.

## Qué hace el bot ahora (para que lo sepas al leer los registros)
- Antes de cada respuesta consulta `GET /api/bot/status` (interruptor) y `GET /api/bot/config` (doctores y horarios vigentes).
- Si el interruptor está apagado: **no contesta** y no llama al modelo.
- Si la API no responde o el modelo falla: envía el mensaje de respaldo ("un miembro del equipo se pondrá en contacto") y registra el caso en
  *Atención* de la clínica (`POST /api/bot/handoffs`). Nunca ofrece horarios de memoria.
- Si el paciente pide una persona, o manda fotos/audios/archivos (que el bot no puede ver), registra un caso en *Atención*
  (`ACTION pasar_a_persona`, `HANDOFF ... REGISTRADO` en `server.log`). Si Zernio rechaza la respuesta la reintenta con la misma
  `Idempotency-Key` y, si no puede, deja el caso en *Atención* y la línea `ENVIO FALLO` en `server.log`: avísale al usuario si la ves.
- La identidad del paciente es el teléfono que entrega Zernio; solo ve y modifica sus propias citas.
- Las reservas las valida y hace de forma atómica el servidor; el bot solo las pide.

## Reglas para ti
1. No imprimas ni registres el token; si un comando lo mostraría, no lo ejecutes así.
2. No modifiques el webhook de Zernio ni ejecutes `stop.sh` a menos que el usuario lo pida.
3. No edites `system_prompt.md` salvo que el usuario lo pida (quedan pendientes quitar el aviso "entorno de PRUEBA" y cargar precios).
4. Si algo no coincide con lo descrito aquí, detente y reporta al usuario con la salida exacta (sin el token).

## Límites conocidos
- Mientras la API sea la computadora del usuario por túnel, el bot depende de que esté encendida (y del túnel). Es solo para ensayo; el
  destino final es el servidor en PythonAnywhere (solo cambia `CLINICA_API_URL` y el token).
- Sin cola: si el bot se reinicia justo cuando Zernio reintenta un mensaje, puede contestarlo dos veces.
