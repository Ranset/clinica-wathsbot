/** Lo que se le manda al doctor: corto, para un mensaje de WhatsApp. Lleva su nombre, su código y el enlace (con cuánto dura). */
export function passwordLinkMessage(doctor: { name: string; code: string }, link: { url: string; expiresAtUtc: string }, now: number = Date.now()): string {
  return `${doctor.name} · Código ${doctor.code}\nCrea o cambia tu contraseña aquí (${validity(link.expiresAtUtc, now)}):\n${link.url}`;
}

/** «vale 3 días» / «vale 20 horas»: lo que le queda al enlace. */
export function validity(expiresAtUtc: string, now: number): string {
  const hours = (Date.parse(expiresAtUtc) - now) / 3_600_000;
  if (!Number.isFinite(hours) || hours < 2) return "vale poco tiempo";
  if (hours < 36) return `vale ${Math.round(hours)} horas`;
  return `vale ${Math.round(hours / 24)} días`;
}
