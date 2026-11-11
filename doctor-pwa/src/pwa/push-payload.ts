/**
 * El contenido de un aviso push, tal como lo va a mandar el servidor (F8; hoy el contrato solo define
 * el registro de la suscripción, no el envío). Se acepta un JSON `{ title, body, url?, tag? }` o, si
 * el aviso llega como texto plano, ese texto como cuerpo. Todo es opcional: un push sin datos igual
 * muestra un aviso genérico (el navegador exige mostrar algo cuando llega un push).
 *
 * Vive aparte del service worker para poder probarlo y compartir el tipo.
 */
export type PushNotice = {
  title: string;
  body: string;
  /** A dónde lleva tocar el aviso (relativo al alcance de la app). */
  url: string;
  /** Avisos con el mismo `tag` se reemplazan en vez de apilarse. */
  tag?: string;
};

const DEFAULT_TITLE = "Mi agenda";
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Solo se aceptan destinos dentro de la app: "#/hoy", "./", "./#/semana?dia=2026-11-12". Nada de otros sitios. */
export function safeUrl(v: unknown): string {
  if (typeof v !== "string") return "./";
  const u = v.trim();
  if (u.startsWith("#/")) return `./${u}`;
  if (u === "./" || /^\.\/#\/[\w\-./?=&%]*$/.test(u)) return u;
  return "./";
}

export function parsePushPayload(raw: unknown): PushNotice {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { body: raw };
    }
  }
  const o = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const tag = text(o.tag, 80);
  return {
    title: text(o.title, 120) || DEFAULT_TITLE,
    body: text(o.body, 300) || "Tienes novedades en tu agenda.",
    url: safeUrl(o.url),
    ...(tag ? { tag } : {}),
  };
}
