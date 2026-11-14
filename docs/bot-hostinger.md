# El bot de WhatsApp trabajando con el sistema de la clinica

El bot que ya responde en el servidor de Hostinger **sigue recibiendo los mensajes igual que hoy** (Zernio → bot). Lo que cambia es
de dónde saca la información y dónde agenda: en vez de Google Calendar y datos fijos en su texto, **trabaja a través de la API de
la clínica, como un empleado más**.

```
Paciente ──WhatsApp──> Zernio ──webhook──> BOT (Hostinger, server.py)
                                             │ 1. ¿estoy activo?          GET  /api/bot/status        (el botón "Bot" del personal)
                                             │ 2. doctores y horarios     GET  /api/bot/config        (vigentes, en cada mensaje)
                                             │ 3. disponibilidad          GET  /api/bot/availability, /nearest
                                             │ 4. agendar / ver / cancelar / reprogramar   /api/bot/appointments...
                                             │ 5. pasar a una persona     POST /api/bot/handoffs      (aparece en "Atención")
                                             ▼
                                   Flask + MySQL de la clínica (PythonAnywhere)  ← el personal ve y mueve las citas en la web
```

## Qué decide cada parte

| Qué | Dónde vive | Cómo se cambia |
|---|---|---|
| ¿El bot contesta ahora? | Interruptor en la API | Botón **Bot** de la web de administración (apagado = no contesta, atiende una persona) |
| Doctores, especialidades, horario de la clínica y de cada doctor | Base de datos | Web de administración (*Doctores*, horario) — el bot lo lee **en cada mensaje**, sin reiniciarlo |
| Horarios libres, citas, consultorios, ausencias | Base de datos (motor de agenda) | El bot solo **pide**; el servidor valida y reserva de forma atómica |
| Estilo, ubicación, reglas de seguridad, precios | `bot/system_prompt.md` | Editar el archivo y reiniciar el bot |
| El modelo | CLI `claude` del propio bot (`WATHSBOT_LLM=cli`, el defecto) | **No se usa `ANTHROPIC_API_KEY`** |
| Formato de hora | Al paciente, **12 h con AM/PM** ("10:00 AM", "4:30 PM"), igual que la web y la PWA; la API y las acciones del bot siguen en 24 h | Regla 7 de `agenda_prompt()` en `server.py` (y `clinic_info.to_12h()` corrige si se escapa una hora de 24 h) |

El paciente se identifica por el teléfono de WhatsApp que entrega Zernio, nunca por lo que escriba: un paciente solo ve, cambia o cancela **sus** citas.

## Si algo falla

- **Interruptor apagado:** el bot no contesta y no gasta modelo (atiende el personal desde Zernio).
- **La API no responde** (al ver el interruptor o al armar la respuesta): el bot **no ofrece horarios de memoria**; envía "un miembro del equipo se pondrá en contacto" y registra el caso en *Atención* (si la API sigue caída, el aviso queda solo en el registro del bot).
- **Falla el modelo** (CLI caído, tiempo agotado): mismo mensaje de respaldo y caso en *Atención* (motivo `modelo_fallo`).
- **Una acción de agenda falla a mitad de la conversación:** el modelo recibe `agenda_no_disponible` y le dice al paciente que el equipo lo contactará.
- **El paciente pide hablar con una persona** (o el bot dice que el equipo lo contactará): el caso se registra en *Atención* (acción `pasar_a_persona`; si el modelo la olvida, el código la registra). El bot solo promete el aviso si de verdad quedó registrado; si no, pide volver a escribir en unos minutos. Varios mensajes seguidos del mismo paciente abren **un** caso (ventana de 15 min, `WATHSBOT_HANDOFF_DEDUP_S`).
- **Fotos, audios, documentos o mensajes sin texto:** el bot no puede verlos; avisa a una persona en *Atención* (con el tipo de archivo, sin descargarlo) y se lo dice al paciente. Un sticker suelto se ignora.
- **Zernio no acepta la respuesta** (red, 5xx, 429): el bot reintenta 2 veces con la misma `Idempotency-Key`, así que un reintento nunca duplica el mensaje. Si no lo logra, deja un caso en *Atención* ("el paciente no recibió la respuesta") además de la línea `ENVIO FALLO` en su registro.

## Probarlo en tu máquina (sin WhatsApp, con el modelo real)

```bash
# terminal 1, desde la raíz del repositorio
npm run dev:local            # servidor + web de administración (http://127.0.0.1:5180, recepcion@dev.test)

# en la web de administración: enciende el botón "Bot" (el servidor de desarrollo lo arranca APAGADO, a propósito)

# terminal 2
npm run dev:bot              # = python bot/dev_chat.py
```

Tú eres el paciente: escribes y contesta el bot de verdad (mismo código y mismo modelo que en producción, vía tu suscripción de
Claude Code). Se ven las líneas `ACTION ...` con lo que el bot pidió a la API. Comandos: `/nuevo`, `/tel 5299...` (cambia de
paciente: prueba que no ve las citas de otro), `/salir`. **No envía nada a WhatsApp.** Las citas que agendes son reales en la base de
desarrollo (`dev_seed.py --reset` la reinicia). Cada respuesta tarda entre 6 y 30 s (arranque del CLI y hasta 4 pasos del modelo).

## Pasar el bot de Hostinger a este sistema

**Requisito:** el servidor de la clínica debe estar **desplegado con HTTPS público** (ver `docs/despliegue.md`). Un servidor en tu
computadora no lo alcanza el bot de Hostinger.

1. **Token del bot.** En el servidor: `flask --app wsgi gen-token` → ese valor va en `BOT_TOKEN` del servidor y **el mismo** en el bot como
   `CLINICA_BOT_TOKEN`. Sin él, toda `/api/bot/*` responde 401.
2. **Archivos.** Copia al bot de Hostinger la carpeta `bot/` actual: **`server.py`**, **`api_client.py`**, **`clinic_info.py`** y
   `system_prompt.md` (los dos últimos son nuevos o cambiaron). `scheduler.py` y `gcal_auth.py` solo hacen falta si vuelves a Google.
   Requiere Python 3.9+ (`zoneinfo`); si el sistema no trae base de zonas horarias: `pip install tzdata`.
3. **Variables de entorno** (además de las que ya tiene: `ZERNIO_API_KEY`, `WATHSBOT_WEBHOOK_SECRET`, `WATHSBOT_PORT`...):
   ```
   WATHSBOT_BACKEND=api
   CLINICA_API_URL=https://<tu-dominio-de-la-clinica>
   CLINICA_BOT_TOKEN=<el token del paso 1>
   WATHSBOT_DRY_RUN=1          # solo para el ensayo; quitarlo al final
   ```
   No pongas `WATHSBOT_INGRESS` (el defecto `webhook` es lo que ya funciona: Zernio → el bot). El modelo se queda como está
   (`WATHSBOT_LLM=cli`).
4. **Ensayo.** Reinicia el bot con `DRY_RUN=1`. En su registro debe salir una línea como
   `agenda=API https://... OK | bot ACTIVO | 7 doctores | horario: lunes a viernes 9:00 a 18:00 hrs, ...`. Si dice `NO RESPONDE`, revisa
   la URL y el token. Manda un mensaje de prueba por WhatsApp: en el registro verás `IN: ... -> OUT: ...` con lo que contestaría, sin enviarlo.
5. **Corte.** Quita `WATHSBOT_DRY_RUN`, reinicia, **enciende el botón Bot** en la web, y recorre por WhatsApp: pedir horarios, agendar,
   ver, reprogramar y cancelar; comprueba la cita en el calendario. Las citas viejas de Google Calendar no se migran solas.
6. **Messenger e Instagram (opcional, despues de que WhatsApp ande).** Con `WATHSBOT_PLATFORMS=whatsapp,facebook,instagram` el bot atiende
   tambien esos canales con las mismas funciones; la identidad ahi es un id de Meta (no hay telefono, y el bot pide un telefono de contacto
   antes de agendar). Cada canal tiene su PROPIO interruptor en la web (tres botones: WhatsApp, Messenger, Instagram) y Messenger e Instagram
   nacen APAGADOS: despliega la API con la migracion 0009, enciende primero Messenger, prueba, y despues Instagram. Mientras la API no
   traiga `channels` el bot los trata como apagados y no contesta.
7. **Horario automatico (opcional).** Cada canal puede manejarse a mano (su interruptor) o por horario: en la web, dentro del panel del bot,
   el reloj de cada canal abre «Horario del bot» (dias, hora de inicio y de fin; si el fin es menor que el inicio, termina al dia siguiente).
   El bot no necesita nada nuevo: ya consulta el estado antes de cada mensaje y la API le contesta el estado vigente a esa hora.
8. **Marcha atrás en un minuto.** Apaga el botón **Bot** (deja de contestar), o pon `WATHSBOT_BACKEND=google` (o quita la variable) y
   reinicia: vuelve el bot de antes con Google Calendar (etiqueta `pre-api` del repositorio).

## Ensayo con un túnel de Cloudflare hacia tu computadora

Para probar el bot de Hostinger contra el servidor local antes de desplegar: túnel de Cloudflare → `http://localhost:5000`, y el bot con
`CLINICA_API_URL=https://<tu-dominio-del-tunel>`. **Mientras el túnel esté arriba, ese servidor es público.** Por eso:
- Arranca el servidor con un token propio: `flask --app wsgi gen-token`, luego `$env:BOT_TOKEN="<token>"; npm run dev:local`. Con un token
  propio, `scripts/dev_server.py` deja pasar desde el túnel **solo `/api/bot/*`** (todo lo demás, incluidos el login con las claves de
  desarrollo y el webhook, responde 404). Con el token de desarrollo (público) no deja pasar nada. La web de administración la usas local.
- Comprueba desde fuera: `/api/health` → 404; `/api/bot/status` sin token → 401, con tu token → 200.
- Instrucciones listas para Hermes: `docs/instrucciones-hermes.md` (y `hermes-bot-api.zip` con los 3 archivos del bot).

## Límites conocidos

- **Sin cola:** si el proceso del bot está caído cuando llega un mensaje, Zernio reintenta (hasta 7 veces en ~51 h para 5xx/timeouts); un
  reinicio borra la memoria de eventos ya vistos, así que un reintento tras reiniciar puede contestar **dos veces** un mismo mensaje. Si
  eso importa, usa el modo con cola (`WATHSBOT_INGRESS=queue` + `poller.py`; el servidor recibe el webhook y el bot lo consulta).
- **No hay recordatorios ni avisos por iniciativa del bot:** la cuenta de Zernio aún no puede iniciar conversaciones (sin plantillas).
- El texto de `system_prompt.md` aún dice **"entorno de PRUEBA"**; quitarlo antes de atender pacientes reales. Los precios (salvo
  proctología, $750) siguen sin cargarse: el bot dice que el equipo los confirmará.
- Probado con el modelo real **solo en la máquina de desarrollo** (agendar, ver citas, aislamiento entre pacientes, interruptor), no en
  Hostinger ni con mensajes reales de Zernio.
