# @clinica/api-client

Cliente `fetch` tipado de la API de la clínica y un **servidor simulado en memoria** para desarrollar sin backend.
Lo usan `admin-web/` (F6) y, después, `doctor-pwa/` (F7). Se consume como código fuente (`src/index.ts`), igual que
`@clinica/calendar`.

```ts
import { createApiClient, isApiError } from "@clinica/api-client";

const api = createApiClient();                       // mismo origen: cookie `clinica_session` + `X-CSRF-Token`
await api.auth.login(email, password);              // guarda el token CSRF (también `me()`)
await api.auth.loginDoctors();                      // PÚBLICO: [{ code: "1001", name }] de los doctores con cuenta (la lista de la entrada del doctor)
await api.auth.loginDoctor("1001", password);       // entrada del doctor con su código de 4 dígitos (sin correo); guarda el token CSRF
await api.doctors.createPasswordLink(doctorId);     // personal/admin: { url, expiresAtUtc } del enlace para que el doctor cree (o cambie) su contraseña
await api.auth.checkPasswordLink(token);            // PÚBLICO: { doctorCode, doctorName, expiresAtUtc } o 404 `enlace_invalido`
await api.auth.usePasswordLink(token, password);    // PÚBLICO: guarda la contraseña (un solo uso) y deja la sesión abierta
const r = await api.appointments.list({ from, to }, { etag });   // { notModified: true, etag } si el servidor dio 304
await api.appointments.update(id, { status: "realizada" });
await api.appointments.moveSlots(id, { from, to, roomId });   // los horarios LIBRES a los que se puede mover esa cita, por día (`[from, to)`, hasta 42 días)
await api.appointments.availability({ from, to, doctorId, durationMinutes, roomId });  // lo mismo para una cita (o `kind: "block"`) NUEVA
api.onUnauthenticated(() => /* la sesión venció */);
```

- **Tipos**: `src/schema.d.ts` se **genera** de `docs/openapi.yaml` (`npm run generate`); `src/types.ts` les pone nombre
  corto. `Booking`, `BookingStatus` y `WeeklyHours` son los de `@clinica/calendar` (el contrato los calca;
  `test/types.test.ts` lo comprueba en el typecheck).
- **Errores**: siempre `ApiError { status, code, detail, body }` con el `{ error, detail }` del contrato. Sin red:
  `code: "red"`, `status: 0`. Respuesta que no es JSON: `respuesta_invalida` / `desconocido`.
- **Operaciones**: `src/operations.ts` es la tabla `operationId → [método, ruta]`; `test/contract.test.ts` la compara con el
  YAML. Cubre todo menos `/api/bot/*` y el webhook (incluye `doctorSelf.*` para la PWA).

## Servidor simulado (`@clinica/api-client/mock`)

```ts
import { createMockApi, DEMO_ACCOUNTS } from "@clinica/api-client/mock";
const mock = createMockApi({ latencyMs: 120, storage: localStorage });   // `now` y `storage` son opcionales
const api = createApiClient({ fetch: mock.fetch });
```

Habla el contrato: sesión + CSRF, roles (`x-roles`), ETag/304, 401/403/404/409/422/429 y las reglas de agenda (doctor y
consultorio libres, horario del doctor, ausencias, antelación 60 min, horizonte 60 días, citas de 30 min alineadas,
transiciones de estado, mover sin perder la cita original). Los datos de ejemplo salen de `src/mock/seed.ts`.
`mock.controls` (`setOffline`, `failNext`, `expireSession`) y `mock.simulateBotBooking()` sirven para probar a mano.

## Pruebas (`npm test`)

`test/spec.ts` lee `docs/openapi.yaml` y envuelve un `fetch` con `contractFetch()`: cada petición y respuesta se valida con
Ajv contra el contrato (ruta, cuerpo, estado declarado, `X-CSRF-Token` donde se exige). Las pruebas de `admin-web` usan el
mismo envoltorio, así que una pantalla que mande algo fuera del contrato falla en pruebas.
