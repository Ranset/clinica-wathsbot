# Clinica App

Estructura (el contrato de la API esta en `docs/openapi.yaml`):

```
docs/              Contrato de la API (OpenAPI 3.1): bot, webhook, auth, agenda, admin, doctor
bot/               Bot de WhatsApp actual (agenda en Google Calendar; migra a la API)
shared/calendar/   Calendario compartido (React 19 + TS): Dia/Semana/Mes/Lista y
                   carriles por doctor o consultorio. Lo usan la app del doctor
                   y la pagina de administracion (bundle servido por Flask).
server/            Flask + MySQL: API, administracion y cola de webhooks
                   (por ahora solo entorno y pruebas del contrato)
admin-web/         (pendiente) SPA del personal/administrador
doctor-pwa/        (pendiente) React 19 + Vite + vite-plugin-pwa
```

## Origen del calendario

La logica de fechas (`src/lib/calendar.ts`, `src/lib/slots.ts`) y los componentes
`time-grid`, `month-grid`, `agenda-list` y `calendar-toolbar` parten de
[Vocero CRM](https://github.com/kevinrivm/vocero-crm) (MIT, (c) 2026 Kevin Belier).
Se conserva su licencia en `shared/calendar/LICENSE.vocero-crm`.

Cambios propios: modelo de cita con doctor y consultorio, carriles por doctor con
su horario sombreado, tema propio, sin dependencias del CRM. Las pruebas de
`test/vocero/` son las originales sobre la logica copiada.

## Comandos (en `shared/calendar`)

    npm install
    npm run typecheck
    npm test            # 60 pruebas
    npm run build       # demo en dist-demo/
