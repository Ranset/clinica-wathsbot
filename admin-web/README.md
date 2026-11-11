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
  Clic en un hueco → *Nueva cita*; clic en una cita → detalle (realizada / no asistió / mover / cancelar / notas).
  Los filtros viven en la dirección (`?vista=semana&dia=2026-11-12&doctor=d1`). Se actualiza solo cada 5 s con
  `If-None-Match` (un 304 no toca el estado) y `coalesce` junta las ráfagas de avisos en una consulta.
- **Doctores** (`#/doctores`): horario semanal propio o de la clínica, ausencias, solicitudes de cambio de horario
  de los doctores; solo el administrador da de alta doctores y cambia el horario de la clínica.
- **Atención** (`#/atencion`): casos que el bot no pudo resolver (`/api/attention`).
- **Usuarios** (`#/usuarios`): solo `admin`.
- **Botón del bot** en el encabezado: siempre visible, muestra si está activo y quién lo cambió; apagarlo pide confirmación.

Un usuario con rol `doctor` no usa esta web (usa la PWA del doctor).

## Notas de diseño

- Navegación por **hash** (`#/ruta`) y `base: "./"`: el mismo `dist/` sirve en `/` o en `/admin/` sin reglas de
  reescritura en Flask. Copiarlo a los estáticos de Flask es de F8.
- El rango que se pide al calendario es `[from, to)` en UTC: desde las 00:00 de Cancún del primer día visible hasta las
  00:00 del día siguiente al último (92 días exactos caben en el tope de la API).
- Permisos en la interfaz (`src/permissions.ts`) solo esconden lo que el servidor rechazaría con 403; el servidor manda.
