import type { ApiClient } from "@clinica/api-client";

/**
 * Avisos push, SOLO el lado del cliente: pedir permiso, suscribir este dispositivo en el service
 * worker y registrar la suscripción en el servidor (`doctorSubscribePush` / `doctorUnsubscribePush`).
 * El envío real lo hará el servidor más adelante.
 *
 * Límites de la plataforma que la pantalla debe explicar:
 *  - iPhone/iPad: solo funciona con la app INSTALADA en la pantalla de inicio (iOS/iPadOS 16.4 o superior);
 *    en Safari normal no existe `PushManager`.
 *  - Hace falta la clave pública VAPID del servidor (`VITE_VAPID_PUBLIC_KEY`; el contrato aún no tiene un
 *    endpoint que la entregue).
 */

export type PushUnsupported = "sin-service-worker" | "sin-push" | "sin-notificaciones" | "ios-instalar" | "sin-clave";
export type PushSupport = { ok: true } | { ok: false; reason: PushUnsupported };

export type PushEnv = {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  ios: boolean;
  standalone: boolean;
  vapidKey: string | undefined;
};

/** iPhone, iPad (también el iPad que se anuncia como Mac) o iPod. */
export function isIos(ua: string, platform: string, maxTouchPoints: number): boolean {
  return /iPad|iPhone|iPod/.test(ua) || (platform === "MacIntel" && maxTouchPoints > 1);
}

/** ¿Está abierta como app instalada (sin barra del navegador)? */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return !!window.matchMedia?.("(display-mode: standalone)").matches || nav.standalone === true;
}

export function browserEnv(): PushEnv {
  const hasWindow = typeof window !== "undefined" && typeof navigator !== "undefined";
  return {
    hasServiceWorker: hasWindow && "serviceWorker" in navigator,
    hasPushManager: hasWindow && "PushManager" in window,
    hasNotification: hasWindow && "Notification" in window,
    ios: hasWindow && isIos(navigator.userAgent, navigator.platform ?? "", navigator.maxTouchPoints ?? 0),
    standalone: isStandalone(),
    vapidKey: (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) || undefined,
  };
}

/** ¿Este dispositivo puede recibir avisos? Si no, por qué (para decírselo al doctor). */
export function detectPush(env: PushEnv = browserEnv()): PushSupport {
  // En iPhone, Safari normal ni siquiera tiene PushManager: lo útil es decir que hay que instalar la app.
  if (env.ios && !env.standalone) return { ok: false, reason: "ios-instalar" };
  if (!env.hasServiceWorker) return { ok: false, reason: "sin-service-worker" };
  if (!env.hasPushManager) return { ok: false, reason: "sin-push" };
  if (!env.hasNotification) return { ok: false, reason: "sin-notificaciones" };
  if (!env.vapidKey) return { ok: false, reason: "sin-clave" };
  return { ok: true };
}

export type PushErrorCode = "permiso-denegado" | "sin-service-worker" | "suscripcion-fallida";
export class PushError extends Error {
  readonly code: PushErrorCode;
  constructor(code: PushErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = "PushError";
    this.code = code;
  }
}
export const isPushError = (e: unknown): e is PushError => e instanceof PushError;

/** La clave VAPID llega en base64url; `subscribe` la pide como bytes. */
export function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const padded = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const sleep = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms));

/** El service worker registrado (en desarrollo sin SW no hay: se espera un momento y se da por ausente). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  return Promise.race([navigator.serviceWorker.ready, sleep(1500)]);
}

export type PushStatus =
  | { kind: "no-soportado"; reason: PushUnsupported }
  | { kind: "bloqueado" }
  | { kind: "inactivo" }
  | { kind: "activo"; endpoint: string };

export async function getPushStatus(env: PushEnv = browserEnv()): Promise<PushStatus> {
  const support = detectPush(env);
  if (!support.ok) return { kind: "no-soportado", reason: support.reason };
  if (Notification.permission === "denied") return { kind: "bloqueado" };
  const reg = await registration();
  if (!reg) return { kind: "no-soportado", reason: "sin-service-worker" };
  const sub = await reg.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? { kind: "activo", endpoint: sub.endpoint } : { kind: "inactivo" };
}

/** Pide permiso, suscribe este dispositivo y registra la suscripción en el servidor. Devuelve el `endpoint`. */
export async function enablePush(api: ApiClient, vapidKey: string): Promise<string> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PushError("permiso-denegado");
  const reg = await registration();
  if (!reg) throw new PushError("sin-service-worker");

  let sub = await reg.pushManager.getSubscription();
  const created = !sub;
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) });
    } catch (e) {
      // `DOMException` no siempre es `instanceof Error` (otro "realm"): se lee el mensaje sin depender de eso.
      const message = (e as { message?: unknown } | null)?.message;
      throw new PushError("suscripcion-fallida", typeof message === "string" ? message : undefined);
    }
  }
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) throw new PushError("suscripcion-fallida", "La suscripción no trae claves.");
  try {
    await api.doctorSelf.push.subscribe({ endpoint: json.endpoint, keys: { p256dh, auth } });
  } catch (e) {
    // Que la pantalla no diga «activados» con el servidor sin enterarse: se deshace lo que se acaba de crear
    // (el permiso ya concedido se conserva, así que reintentar no vuelve a preguntar).
    if (created) await sub.unsubscribe().catch(() => undefined);
    throw e;
  }
  return json.endpoint;
}

/** Quita el registro en el servidor y luego la suscripción del navegador. Si el servidor falla, lanza y NO toca el navegador. */
export async function disablePush(api: ApiClient): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api.doctorSelf.push.unsubscribe(sub.endpoint);
  await sub.unsubscribe();
}

/**
 * Al cerrar sesión: que este dispositivo deje de recibir avisos de la agenda de quien sale.
 * Mejor esfuerzo y con tope de tiempo (sin red el registro del servidor se limpia solo cuando el push
 * service responda «suscripción caducada»); la suscripción local se quita siempre.
 */
export async function releasePush(api: ApiClient): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (!sub) return;
    await Promise.race([api.doctorSelf.push.unsubscribe(sub.endpoint).catch(() => undefined), sleep(3000)]);
    await sub.unsubscribe();
  } catch {
    /* cerrar sesión nunca debe fallar por esto */
  }
}
