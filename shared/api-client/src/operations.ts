/**
 * Las operaciones de `docs/openapi.yaml` que usan la web de administracion y la
 * PWA del doctor (todo menos `/api/bot/*` y el webhook). La clave es el
 * `operationId` del contrato; `test/contract.test.ts` comprueba que cada
 * (metodo, ruta) existe en el YAML con ese mismo `operationId`, asi que si el
 * contrato cambia, la prueba avisa antes que el navegador.
 */
export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export const OPERATIONS = {
  health: ["get", "/api/health"],

  // auth
  login: ["post", "/api/auth/login"],
  logout: ["post", "/api/auth/logout"],
  me: ["get", "/api/me"],

  // agenda
  listAppointments: ["get", "/api/appointments"],
  createAppointment: ["post", "/api/appointments"],
  getAppointment: ["get", "/api/appointments/{appointmentId}"],
  updateAppointment: ["patch", "/api/appointments/{appointmentId}"],
  listRooms: ["get", "/api/rooms"],
  getClinicHours: ["get", "/api/clinic-hours"],
  setClinicHours: ["put", "/api/clinic-hours"],
  listDoctors: ["get", "/api/doctors"],
  createDoctor: ["post", "/api/doctors"],
  updateDoctor: ["patch", "/api/doctors/{doctorId}"],
  setDoctorWeeklyHours: ["put", "/api/doctors/{doctorId}/weekly-hours"],
  listDoctorAbsences: ["get", "/api/doctors/{doctorId}/absences"],
  createDoctorAbsence: ["post", "/api/doctors/{doctorId}/absences"],
  deleteDoctorAbsence: ["delete", "/api/doctors/{doctorId}/absences/{absenceId}"],
  listScheduleChangeRequests: ["get", "/api/schedule-change-requests"],
  approveScheduleChange: ["post", "/api/schedule-change-requests/{requestId}/approve"],
  rejectScheduleChange: ["post", "/api/schedule-change-requests/{requestId}/reject"],

  // admin
  getBotSettings: ["get", "/api/settings/bot"],
  setBotSettings: ["put", "/api/settings/bot"],
  listAttention: ["get", "/api/attention"],
  resolveAttention: ["post", "/api/attention/{attentionId}/resolve"],
  listUsers: ["get", "/api/users"],
  createUser: ["post", "/api/users"],
  updateUser: ["patch", "/api/users/{userId}"],

  // doctor (PWA)
  doctorAppointments: ["get", "/api/doctor/appointments"],
  doctorHours: ["get", "/api/doctor/hours"],
  doctorListAbsences: ["get", "/api/doctor/absences"],
  doctorCreateAbsence: ["post", "/api/doctor/absences"],
  doctorDeleteAbsence: ["delete", "/api/doctor/absences/{absenceId}"],
  doctorListScheduleChanges: ["get", "/api/doctor/schedule-change-requests"],
  doctorCreateScheduleChange: ["post", "/api/doctor/schedule-change-requests"],
  doctorSubscribePush: ["post", "/api/doctor/push-subscriptions"],
  doctorUnsubscribePush: ["delete", "/api/doctor/push-subscriptions"],
} as const satisfies Record<string, readonly [HttpMethod, string]>;

export type OperationId = keyof typeof OPERATIONS;

/** Metodos que escriben: llevan `X-CSRF-Token` cuando la sesion es por cookie. */
export const CSRF_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Rellena `/api/doctors/{doctorId}` con valores ya escapados. */
export function fillPath(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Falta el parametro de ruta "${name}" en ${template}`);
    return encodeURIComponent(value);
  });
}
