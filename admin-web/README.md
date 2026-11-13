# admin-web

Web de administración y personal de la Clínica CUBAMEX: SPA React 19 + TypeScript + Vite que habla con la
API de [`docs/openapi.yaml`](../docs/openapi.yaml) (la misma que usan el bot y la PWA del doctor).

Se construyó y probó contra la API **simulada**, y el 2026-11-10 se revisó a mano en el navegador contra el **servidor Flask real**
(`npm run dev:real`; ver `server/README.md` para levantarlo): login, calendario, alta de citas (incluido el choque 409), cambio de
estado, botón del bot, aprobar solicitudes de horario y casos de atención. Esa revisión destapó que el proxy de Vite debe llevar
`changeOrigin: false` (si reescribe el `Host`, el servidor rechaza las escrituras por `Origin`; ya está corregido) y que **aprobar
una solicitud de horario no avisaba de las citas que quedaban fuera del nuevo horario**: ahora muestra la lista, como ya hacía el
diálogo de horario. No hay pruebas automáticas contra el servidor real.

## Comandos

`npm install` se corre **una sola vez en la raíz** del repositorio (npm workspaces: una sola copia de React
para `admin-web`, `shared/calendar` y `shared/api-client`). Después, desde esta carpeta:

```bash
npm run dev        # API SIMULADA en memoria, en http://127.0.0.1:5180 (no hace falta servidor)
npm run dev:real   # igual, pero /api va al servidor Flask en http://127.0.0.1:5000
npm test           # vitest + Testing Library contra el simulador
npm run typecheck  # tsc --noEmit
npm run build      # bundle de producción en dist/ (API real del mismo origen; sin simulador)
npm run build:demo # demo estática con el simulador, en dist-demo/
```

## Modos de la API (`VITE_API_MODE`, ver `.env.*`)

| Modo | Cuándo | Qué usa |
| --- | --- | --- |
| `mock` | `npm run dev`, `build:demo` | `createMockApi()` de `@clinica/api-client/mock`, como `fetch` del cliente. |
| `real` | `npm run dev:real`, `npm run build` | `fetch` normal; cookie de sesión y `X-CSRF-Token` del mismo origen. |

El simulador respeta el contrato (sesión + CSRF, roles, ETag/304, errores 401/403/404/409/422/429 y las reglas
de agenda). Cuentas de ejemplo: `DEMO_ACCOUNTS` en `shared/api-client/src/mock/seed.ts` (la pantalla de
entrada ofrece botones que las llenan). En modo `mock`, `window.__clinicaMock` expone controles para probar a mano:

```js
__clinicaMock.simulateBotBooking()          // el "bot" agenda una cita: aparece sola en el calendario (≤ 5 s)
__clinicaMock.controls.setOffline(true)     // sin red: la pantalla conserva lo que tenía y avisa
__clinicaMock.controls.failNext(1, 503)     // la próxima petición responde una página de error HTML
__clinicaMock.controls.expireSession()      // la sesión vence: la siguiente petición da 401 y vuelve al login
__clinicaMock.reset()                       // datos de ejemplo de nuevo
```

## Pantallas

- **Calendario** (`#/calendario`): `TimeGrid`, `MonthGrid` y `AgendaList` de `@clinica/calendar`. Día por carriles
  (un carril por doctor, con su horario sombreado, o por consultorio; los bloqueos tienen su propia columna).
  Cada doctor tiene su **color** (en las citas, los encabezados de columna y los puntos de mes y lista); la leyenda de colores arriba del calendario, que además
  filtra por doctor al hacer clic, está apagada (ver *Funciones apagadas*). El color se elige en la pestaña «Datos» del doctor (paleta, «Otro color» o «Automático»,
  que usa un color de la paleta según su número); no se aceptan colores tan claros que el texto blanco de las citas no se lea.
  Las **ausencias** de los doctores se ven como franjas ámbar rayadas con su motivo: en «Día» por doctor (cada una en la columna de
  su doctor) y en «Día»/«Semana» con un doctor filtrado; las citas quedan encima. Cuando un doctor tiene un **evento personal** (lo anota en su PWA)
  se ve una franja **gris rayada «No disponible»**, sin motivo ni texto (el detalle es privado del doctor; la API solo da doctor y horario): en ese
  horario el doctor no se puede agendar, pero el consultorio sigue libre para los demás doctores.
  Al **pasar el puntero por una cita** (Día, Semana y Mes) sale el **doctor, su especialidad y el consultorio** («Dra. Bordas Rodríguez · Ortopedia y Traumatología · Consultorio 2»; un
  bloqueo, solo el consultorio): es el atributo `title` (`bookingHover` de `@clinica/calendar`), útil cuando el nombre del paciente se corta en una columna angosta.
  Clic en un hueco → *Nueva cita*. En ese formulario, si el doctor elegido **no atiende a esa fecha y hora** (el tramo completo, según su horario) sale el aviso
  «… no atiende … a esa hora» y **«Agendar cita» queda deshabilitado** (tampoco Enter envía; «cita de mostrador» no lo cambia: solo omite la antelación); los
  demás avisos (ya pasó, menos de 60 minutos) no bloquean. Clic en una cita → detalle (mover / cancelar / notas; «realizada» / «no asistió» están apagadas, ver *Funciones apagadas*).
  Los filtros viven en la dirección (`?vista=semana&dia=2026-11-12&doctor=d1`). Se actualiza solo cada 5 s con
  `If-None-Match` (un 304 no toca el estado) y `coalesce` junta las ráfagas de avisos en una consulta.
- **Mover una cita con calendario emergente**: en el detalle de una cita o bloqueo, «Mover a otro horario» conserva «Nueva fecha» y «Nueva hora» y suma el botón **«Elegir en el calendario (ver horarios libres)»**: una ventana emergente con el mes (anterior/siguiente, hasta 60 días a futuro), los días con horarios libres resaltados y, al elegir un día, sus horarios libres en 12 h (el de la cita se marca «Horario actual»); tocar uno llena la fecha y la hora y la cierra (Esc cierra solo el calendario, no el detalle). Con teclado: flechas entre los días con horarios y RePág/AvPág para cambiar de mes. Respeta el consultorio elegido y «Cita de mostrador». Los horarios los calcula el servidor (`GET /api/appointments/{id}/move-slots`) con las mismas reglas del movimiento, así que lo que se ve libre se puede elegir; si no cargan, avisa y ofrece «Reintentar» (los campos de fecha y hora siguen sirviendo a mano).
- **Cuenta del doctor y enlace de contraseña**: al **dar de alta** un doctor (el formulario no cambia) su cuenta se crea sola, sin correo y sin contraseña. En su pestaña **«Datos»** hay una sección «Acceso del doctor a su app» con el botón **«Generar enlace y copiar»** (personal y administrador): copia al portapapeles un mensaje de tres líneas («Dr. X · Código 1001» / «Crea o cambia tu contraseña aquí (vale 3 días):» / el enlace), corto para WhatsApp, y lo deja a la vista en un recuadro (si el navegador no deja copiar, ahí se copia a mano). Sirve para la primera contraseña y para recuperar una olvidada; el enlace es de un solo uso y el nuevo reemplaza al anterior. Si el servidor no tiene `DOCTOR_APP_URL`, avisa. En **Usuarios**, «Nuevo usuario» solo crea Personal y Administrador (los doctores nacen con el doctor); el renglón de un doctor dice «Sin correo: entra con su código» y «Sin contraseña» mientras no la cree; editar su cuenta no deja cambiar su rol ni su doctor.
- **Código de acceso del doctor**: cada doctor tiene un código de 4 dígitos (lo asigna el sistema al darlo de alta, desde 1001; no se edita) que es su «usuario» en la app del doctor. Se ve en la tarjeta de **Doctores** («Código de acceso: 1001»), en su pestaña **«Datos»** (solo lectura, con la explicación; al dar de alta avisa que se asignará) y en **Usuarios** (el renglón de un usuario doctor dice «· código 1001» y la lista de doctores del formulario empieza con el código). El doctor ya no entra con su correo: elige su código o nombre en una lista y escribe su contraseña.
- **Doctores** (`#/doctores`): cada card lleva una **franja a la izquierda del color del doctor** (el mismo con el que se ve en el calendario: el elegido o el
  automático; `colorOf`). **Los doctores de baja no salen por defecto**: el check «Mostrar doctores inactivos (N)» los muestra, con su etiqueta «De baja»
  (viaja en la dirección: `#/doctores?inactivos=1`; si no queda ninguno activo, la pantalla lo dice). Horario semanal propio o de la clínica, ausencias, solicitudes de cambio de horario
  de los doctores. El administrador y el personal de recepción dan de alta, editan y dan de baja doctores y cambian el
  horario de la clínica (pestaña «Datos» de cada doctor). Solo el administrador puede además *eliminar* un doctor dado de alta por error
  (si nunca tuvo citas ni cuenta de usuario; en cualquier otro caso se da de baja).
- **Atención** (`#/atencion`): casos que el bot no pudo resolver (`/api/attention`). «Pendientes» sale completo; **«Atendidos» se pagina de 10 en 10**, de los más
  recientes a los más antiguos (por la fecha de cada caso), con «Mostrando 11–20 de 47», Anterior / Siguiente y «Página 2 de 5» (`src/ui/pager.tsx`; no se pinta si
  caben en una página; al cambiar de pestaña vuelve a la primera). **La paginación la hace el servidor**: la web pide `GET /api/attention?status=resolved&limit=10&offset=N` y
  recibe esa página y el `total`; si la lista se achica mientras se mira la última página, pasa sola a la última que exista. Si el servidor todavía es de la versión anterior
  (sin reiniciar: ignora `limit` y no manda `total`), la web pagina la lista completa por su cuenta en vez de mostrar «Página 1 de NaN».
- **Usuarios** (`#/usuarios`): solo `admin` (junto con eliminar doctores, es lo que el personal de recepción no hace).
  **Filtros** arriba de la lista, en una sola fila: botones de **rol** («Todos», Administradores, Personal, Doctores, cada uno con cuántos hay) y, a la derecha, el check **«Mostrar usuarios sin acceso (N)»**. Igual que los doctores inactivos, **los usuarios sin acceso (dados de baja, la etiqueta roja «Sin acceso») no salen por defecto**; el check los muestra y N es cuántos hay de ese tipo (en el rol elegido). Los números de los botones cuentan lo que se ve (con el check puesto incluyen las bajas). Viajan en la dirección (`#/usuarios?rol=doctor&bajas=1`; `rol` = `admin|staff|doctor`, solo `bajas=1` muestra las bajas; cualquier otro valor se ignora), así que se pueden compartir y sobreviven a recargar. Si un rol no tiene usuarios con acceso lo dice («No hay usuarios con acceso con el rol «Doctor».», y si hay bajas de ese rol avisa que el check las muestra) y ofrece «Quitar filtro de rol». Es solo de la web: el servidor sigue devolviendo todos los usuarios (`GET /api/users`).
- **Clínica** (`#/clinica`): solo `admin` (recepción no ve la opción y, si abre la dirección, la web dice «Esta sección no está disponible para tu rol»; el servidor responde 403). Cambia el **nombre de la clínica** (1 a 80 caracteres) y su **logotipo**: se elige un archivo PNG, JPG o WebP **cuadrado (1:1)**, de 64 a 2048 px por lado y de hasta 1 MB (no SVG). La web lo revisa antes de subirlo (`checkLogo` de `@clinica/api-client`, las mismas reglas y mensajes que el servidor), muestra la vista previa y no guarda hasta «Guardar logotipo»; «Quitar logotipo» (con confirmación) vuelve al icono por defecto. El nombre y el logotipo se guardan por separado y salen en el encabezado, el inicio de sesión, el título de la pestaña y la PWA del doctor (`src/brand.tsx`: `BrandProvider`, `useBrand`, `BrandMark`). Un nombre largo se recorta con «…» en el encabezado.
- **Botón del bot** en el encabezado: siempre visible, muestra si está activo y quién lo cambió; apagarlo pide confirmación.

Un usuario con rol `doctor` no usa esta web (usa la PWA del doctor).

## Notas de diseño

- Navegación por **hash** (`#/ruta`) y `base: "./"`: el mismo `dist/` sirve en `/` o en `/admin/` sin reglas de
  reescritura en Flask. Copiarlo a los estáticos de Flask es de F8.
- El rango que se pide al calendario es `[from, to)` en UTC: desde las 00:00 de Cancún del primer día visible hasta las
  00:00 del día siguiente al último (92 días exactos caben en el tope de la API).
- Permisos en la interfaz (`src/permissions.ts`) solo esconden lo que el servidor rechazaría con 403; el servidor manda.

## Funciones apagadas

Hay funciones que existen en el código pero están **apagadas** por decisión de la clínica. Los interruptores están en `src/features.ts`:

| Interruptor | Qué hace al encenderlo |
|---|---|
| `doctorLegend` | Muestra arriba del calendario la leyenda de colores de los doctores; al hacer clic en uno filtra por ese doctor. |
| `attendanceStatus` | En el detalle de una cita, ofrece «Marcar como realizada» / «No asistió» y «Corregir». |

Para volver a usar una: cambia su valor a `true` y recompila (`npm run build`; con `npm run dev` se ve al guardar). El servidor y la API no cambian: solo es la interfaz.
