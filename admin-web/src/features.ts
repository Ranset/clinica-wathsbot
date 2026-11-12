/**
 * Funciones de la web de administración que EXISTEN en el código pero están APAGADAS por decisión de la clínica
 * (2026-11-11). Nada se borró: para volver a usar una, cambia su valor a `true` y vuelve a compilar la web
 * (`npm run build`; con `npm run dev` se ve al guardar). Las pruebas cubren las dos posiciones.
 *
 * - `doctorLegend`: la leyenda de colores de los doctores arriba del calendario (Semana, Mes, Lista y Día por consultorio),
 *   que además filtra por doctor al hacer clic. Los colores en sí (citas, columnas, puntos) siguen viéndose; el filtro
 *   «Doctor» de la barra sigue ahí. Componente: `DoctorLegend` de `@clinica/calendar` (usado en `pages/calendar/page.tsx`).
 * - `attendanceStatus`: las opciones de marcar una cita como «realizada» o «no asistió» (y corregirlo) en el detalle de la cita.
 *   Una cita que ya tenga ese estado lo sigue mostrando; lo que se oculta es poder cambiarlo desde la web. El servidor y la API
 *   no cambian (`PATCH /api/appointments/{id}` con `status` sigue aceptando `realizada` y `no_show`). Está en
 *   `pages/calendar/booking-detail.tsx`.
 */
export type Features = {
  doctorLegend: boolean;
  attendanceStatus: boolean;
};

export const features: Features = {
  doctorLegend: false,
  attendanceStatus: false,
};
