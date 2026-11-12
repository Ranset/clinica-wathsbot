# doctor-pwa

PWA del doctor de la Clínica CUBAMEX (F7): React 19 + TypeScript + Vite + `vite-plugin-pwa`. Habla con la API de
[`docs/openapi.yaml`](../docs/openapi.yaml) (rutas `/api/doctor/*` más sesión). **El doctor solo ve lo suyo**: su agenda,
sus ausencias y su horario. Se construyó y probó contra la **API simulada** (`@clinica/api-client/mock`) y después se
revisó a mano contra el **servidor Flask real** (`npm run dev:real`; ver «Probado y no probado»).

## Comandos

`npm install` se corre **una sola vez en la raíz** del repositorio (npm workspaces). Después, desde esta carpeta:

```bash
npm run dev          # API SIMULADA en memoria, en http://127.0.0.1:5181 (no hace falta servidor)
npm run dev:real     # igual, pero /api va al servidor Flask en http://127.0.0.1:5000
npm test             # vitest + Testing Library contra el simulador (77 pruebas)
npm run typecheck    # tsc --noEmit (la app) + tsc --noEmit -p tsconfig.sw.json (el service worker)
npm run build        # bundle de producción en dist/ (API real del mismo origen) + sw.js + manifest.webmanifest
npm run build:demo   # demo estática con la API simulada y service worker, en dist-demo/
npm run preview:demo # sirve dist-demo/ en http://127.0.0.1:5182 (para probar instalación y sin conexión)
npm run icons        # regenera public/icons/*.png (sin dependencias; ver scripts/make-icons.mjs)
```

El service worker **no corre en `npm run dev`** (es a propósito: en desarrollo estorba). Para ver precache, instalación o
la app sin servidor hay que usar `build:demo` + `preview:demo` (en `.claude/launch.json`: `doctor-pwa-demo`).

## Modos de la API (`VITE_API_MODE`, ver `.env.*`)

| Modo | Cuándo | Qué usa |
| --- | --- | --- |
| `mock` | `npm run dev`, `build:demo` | `createMockApi()` como `fetch` del cliente; la pantalla de entrada ofrece cuentas de ejemplo. |
| `real` | `npm run dev:real`, `npm run build` | `fetch` normal; cookie de sesión `clinica_session` y `X-CSRF-Token` del mismo origen. |

Cuentas de ejemplo: `DEMO_ACCOUNTS` (`shared/api-client/src/mock/seed.ts`). La del **doctor** es `cervantes@clinica.test`
(Dr. Cervantes Peláez, `d1`); con las otras dos (personal, administrador) se ve el aviso de «esta app es para los doctores».
En modo `mock`, `window.__clinicaMock` expone los controles del simulador (`controls.setOffline(true)`, `failNext`,
`expireSession`, `simulateBotBooking()`; ver `admin-web/README.md`). Otra variable: `VITE_VAPID_PUBLIC_KEY` (clave
pública VAPID para los avisos; en `.env.development`/`.env.mock` hay una **de demostración** cuya privada no se guardó).

## Pantallas (`#/hoy`, `#/semana`, `#/ausencias`, `#/horario`, `#/cuenta`)

- **Hoy / Semana**: `TimeGrid` de `@clinica/calendar` con UN solo carril (mi agenda: encabezado con mi nombre y
  especialidad, horario propio sombreado). Flechas, «Hoy» y «Mostrar canceladas»; el día va en la dirección
  (`#/hoy?dia=2026-11-12`). Tocar una cita abre el detalle (solo lectura; **sin teléfono del paciente**). Mis **ausencias se ven en la
  rejilla** como una franja ámbar rayada (de la hora en que empiezan a la en que terminan; con su motivo, que se queda a la vista al
  desplazarse) y además un aviso arriba con el texto; las citas siguen visibles encima de la franja. El doctor no agenda pacientes ni cambia estados desde aquí.
  **Eventos personales**: el botón «Evento» (o tocar un hueco vacío de la rejilla) abre un formulario con título, día, hora de inicio y duración (o «todo
  el día») y notas; el formulario aclara que **no es una cita de la clínica**: en ese horario no recibes citas, pero el consultorio queda libre para los
  demás doctores, y para agendar a un paciente lo registra el personal. Se ven en la rejilla como un bloque gris punteado con icono de persona; un toque los
  abre para editarlos o eliminarlos (con confirmación). Son **privados**: el personal solo ve «No disponible». Si caen sobre una cita ya agendada el servidor
  los rechaza (409) y la PWA dice a qué hora está la cita (sin el paciente). Duran hasta 24 h (para varios días, una ausencia) y no se repiten. Sin conexión
  se leen (copia guardada) pero no se crean ni se borran.
- **Ausencias**: lista (próximas / «Ver pasadas»), registrar (rango de fechas inclusivo, todo el día o por horas, motivo) y
  quitar (con confirmación). Al registrar muestra `affectedCount`: cuántas citas agendadas quedan en el rango (no se
  cancelan; el servidor avisa al personal).
- **Horario**: el horario semanal vigente (`doctorHours`), solicitar un **cambio permanente** (`doctorCreateScheduleChange`:
  editor por día validado contra el horario de la clínica, fecha de inicio, nota) y mis solicitudes con su estado
  (pendiente / aprobada / rechazada). Una **pendiente** se puede **eliminar** (icono de papelera y confirmación); una aprobada o
  rechazada es historial y ya no (`doctorDeleteScheduleChange`).
- **Cuenta**: avisos push de este dispositivo, instalar la app y cerrar sesión.

## Decisiones (todas cambiables)

### Sin conexión: solo lectura, con la copia en el dispositivo (no en el service worker)
La lectura es **«red primero»**: cada consulta va al servidor; si falla (sin red, 5xx o una página de error del hosting) se
queda lo último guardado. Esa copia la guarda **la propia app** en `localStorage` (`src/lib/storage.ts`), no una ruta de
caché del service worker, por cuatro razones: (1) la copia lleva junto el **ETag** de los datos que describe (si el ETag
viviera aparte, un `304` dejaría la pantalla sin datos); (2) se puede **borrar al cerrar sesión** (contiene nombres de
pacientes) y se separa por usuario; (3) la pantalla dice «Última sincronización: hoy 10:42» con la hora de la última
confirmación del servidor; (4) se prueba con vitest. El service worker solo hace el precache del shell.

- Se guarda por usuario: las últimas 8 semanas de agenda (y los eventos personales de cada una: hasta 16 copias), el perfil/horario, las ausencias y quién entró.
- **Abre sin conexión**: si `GET /api/me` no contesta y este dispositivo ya conocía a un doctor, la app abre en solo lectura con
  lo guardado (`verified: false`: aún no hay token CSRF). Cada 10 s y al volver la red intenta confirmar la sesión; si
  responde 401 va al login con el aviso. Una sesión recordada de alguien que no es doctor **no** abre nada.
- **Solo lectura**: `useCanWrite()` deshabilita crear/borrar (ausencias, eventos personales, solicitud de horario y eliminar una pendiente, activar/desactivar avisos) y
  dice por qué. «Sin conexión» sale de `navigator.onLine` **o** de que la última petición falló (red/5xx): el navegador
  se equivoca a veces. Mientras está «sin conexión» por una petición fallida, una sonda barata (`GET /api/health`, cada 5 s y
  al volver la red/pestaña) la recupera sin esperar al siguiente refresco.
- **Cerrar sesión borra todo** lo guardado, quita la suscripción push de este dispositivo (en el servidor y en el navegador)
  y, si entra **otro** usuario, se borra lo del anterior.

### Refresco de la agenda (patrón `use-bookings` de admin-web)
La API se consulta **por semana** (lunes a domingo, `[from, to)` en UTC): Hoy y Semana comparten la misma consulta, la misma
copia y el mismo ETag, y las flechas dentro de la semana no piden nada. Sondeo cada **15 s** (admin-web usa 5 s; aquí
pesa la batería) con `If-None-Match`: un `304` no toca el estado (la rejilla ni se entera); se junta con `coalesce` lo que
llega junto (reloj, volver a la pestaña, volver la red); con la pestaña oculta no consulta y al volver consulta de
inmediato. `src/pages/agenda/use-agenda.ts`.

### PWA
- `vite-plugin-pwa` con `injectManifest` y `src/sw.ts`: **precache del shell** (HTML, JS, CSS, iconos), navegación a
  `index.html` (nunca intercepta `/api` ni `/webhooks`), `registerType: "prompt"` (aviso «Hay una versión nueva»; no se
  recarga la agenda a media consulta; se busca versión nueva cada hora), manejadores `push` y `notificationclick`.
- Manifiesto con rutas **relativas** (`start_url`/`scope` = `./`), igual que `base: "./"` y la navegación por hash: el mismo
  `dist/` sirve en `/` o en `/doctor/` sin reglas de reescritura. Iconos generados (192, 512, maskable, `apple-touch-icon`).
- **Avisos push, solo el lado del cliente** (`src/pwa/push.ts`): pide permiso, suscribe el service worker con la clave VAPID y
  llama `doctorSubscribePush`/`doctorUnsubscribePush` con `endpoint` y claves `p256dh`/`auth`. Si el servidor no registra la
  suscripción se deshace la local (no queda «activado» a medias). La pantalla explica lo que no se puede: **iPhone/iPad solo
  con la app instalada (iOS/iPadOS ≥ 16.4)**, permiso bloqueado, navegador sin push, sin clave.
- **Instalación**: botón donde el navegador lo ofrece (`beforeinstallprompt`); en iPhone, instrucciones de Safari.

### Copias de `admin-web/`
`lib/errors.ts` (+ `isTransientError`), `lib/range.ts`, `lib/hours.ts` (+ `sameHours`), `lib/use-now.ts`, `ui/controls.tsx`,
`ui/modal.tsx`, `toast.tsx`, `router.tsx`, `api-context.tsx`, `pages/schedule/hours-editor.tsx` y `app.css` son copias (la
tarea pedía no tocar `admin-web/`). Son candidatas a un paquete compartido (`shared/ui`) cuando haya un tercer cliente.

## Huecos del contrato (`docs/openapi.yaml` NO se editó) — para quien lo mantenga

1. **La clave pública VAPID no tiene cómo llegar a la PWA.** `pushManager.subscribe` la exige y el contrato solo define el
   registro de la suscripción. Hoy: variable de build `VITE_VAPID_PUBLIC_KEY`. Alternativa: `GET /api/doctor/push-config` →
   `{ vapidPublicKey }`.
2. **El contenido del aviso push no está definido** (servidor → service worker). `src/pwa/push-payload.ts` asume
   `{ title, body, url?, tag? }` (JSON o texto plano; `url` solo `#/…` o `./#/…`, nunca otro sitio) y avisos con el mismo `tag`
   se reemplazan. Conviene fijarlo en el contrato, con qué eventos avisan (cita nueva, cancelada, movida…) **sin teléfono** y
   con el mínimo de datos de paciente (el aviso se ve en la pantalla bloqueada).
3. **`GET /api/doctor/absences` devuelve TODAS las ausencias** (incluidas las pasadas, sin tope). La PWA las filtra y ordena en el
   cliente; con los años crecerá. Sugerencia: `?from=` (por omisión, hoy) o paginación. La web de administración tiene el mismo
   problema con `GET /api/doctors/{id}/absences`.
4. **Una solicitud rechazada no dice por qué.** `ScheduleChangeRequest.note` es la nota del doctor; la nota de `rejectScheduleChange`
   no tiene dónde viajar de vuelta. Sugerencia: `decisionNote` (nullable).
5. `effectiveFrom` es informativo (el contrato ya lo dice): la UI lo avisa («por ahora el cambio entra en vigor en cuanto la
   aprueban»). Si algún día hay horarios con vigencia futura, esa frase se quita.
6. Los huecos de 401/403/422 no declarados que ya anotó `docs`/F6 (ver `side-session-notes/f6-admin-web-traspaso.md`) también
   aplican a `/api/doctor/*`: `403` por rol en `doctorListAbsences`, `doctorHours`…, `422` en `doctorSubscribePush`/`Unsubscribe`.
   La PWA trata todo 4xx como error de negocio (`{error, detail}`) y solo 0/5xx/«no es JSON» como «sin conexión».

## Probado y no probado

**Verificado** (desde la raíz: `npm run typecheck`, `npm test`, `npm run build`):
- 77 pruebas de la PWA (+ las 182 existentes: api-client 67, calendar 60, admin-web 55, sin cambios): refresco con ETag/304,
  copia al abrir sin red y confirmación con `304`, ausencias (crear/quitar/`affectedCount`/validación/solo lectura), solicitud
  de horario (envío, validación contra la clínica, estados), apertura sin conexión (sesión recordada, recuperación, 401,
  nada guardado, no-doctor), push (activar/desactivar/permiso/iOS/sin clave/deshacer si el servidor falla/cerrar sesión),
  almacenamiento (cuota, bloqueado, corrupto, por usuario). Cada petición pasa por el validador de contrato de `api-client`.
- En el navegador integrado, escritorio y 375 px: login, Hoy, Semana, detalle de cita, ausencias (crear), horario (solicitud),
  cuenta, aviso de personal/no doctor y sin conexión simulada (`setOffline`); consola sin errores (salvo uno de recarga en
  caliente de Vite al editar un hook, que no aparece en una pestaña nueva).
- Build de producción: `sw.js` autónomo (sin `import`), manifiesto y 10 recursos en precache; con `build:demo` el service worker
  quedó **activo y controlando la página**, y con el servidor detenido la app **se cargó entera desde el precache**.

**NO probado** (sin hacer, no «probablemente funciona»):
- **Pruebas AUTOMATIZADAS contra el servidor Flask real**: no existen. Contra el servidor real solo hubo una revisión **a mano en
  el navegador** (2026-11-10, `npm run dev:real` con la base de desarrollo del servidor): login, Hoy y Semana con datos reales (solo
  las citas del doctor y sin teléfono), ausencia con aviso al personal, cierre de sesión, y las rutas del personal responden 403.
  No se vio: latencia, 5xx reales, CORS (no aplica: mismo origen) ni la PWA instalada. **Ojo con el proxy de Vite**: debe llevar
  `changeOrigin: false` (ya lo lleva); con el atajo de cadena el servidor rechaza las escrituras (403 `csrf`) porque el `Origin`
  del navegador no coincide con el `Host` reescrito.
- **Push real**: nunca llegó un push; el manejador `push`/`notificationclick` del service worker no se ejecutó (solo se prueba
  el análisis del contenido). La suscripción real (`pushManager.subscribe` con una clave VAPID válida) no se probó: el
  navegador integrado tiene los permisos bloqueados, así que ahí solo se vio el estado «bloqueadas».
- **Otros navegadores** (Safari, Firefox, Edge) y **teléfonos físicos** (iPhone, Android): solo el navegador integrado
  (escritorio y emulación de 375 px). La instalación (`beforeinstallprompt`, «Añadir a pantalla de inicio»), el modo
  `standalone` real, el área segura (`safe-area-inset`) y el comportamiento de iOS no se vieron.
- **Lighthouse / auditoría PWA** y accesibilidad con axe o lector de pantalla (se cuidaron roles, etiquetas, foco y Esc; no se auditó).
- **Rendimiento con meses de citas reales** y el tope de `localStorage` con agendas muy cargadas (hay desalojo de lo más viejo,
  probado con una cuota simulada).
- La actualización del service worker («Hay una versión nueva») y el reintento de actualización cada hora.
- `npm audit` (raíz) reporta avisos solo en dependencias de **desarrollo**: la cadena de `vitest` (ya estaba) y la de
  `workbox-build` (`glob`, `deepmerge`; solo en el build, nada llega al bundle). `npm audit --omit=dev` → 0. No se tocaron.
