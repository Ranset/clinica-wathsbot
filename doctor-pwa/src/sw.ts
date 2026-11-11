/// <reference lib="webworker" />
// Service worker de la PWA del doctor (estrategia `injectManifest` de vite-plugin-pwa).
//
//  - Precache del «shell» (HTML, JS, CSS, iconos): la app abre sin conexión.
//  - Navegación a index.html para cualquier ruta de la app (el enrutado es por hash, pero así
//    también abre «a la fuerza» desde un enlace guardado). NUNCA intercepta /api ni /webhooks.
//  - La agenda NO se guarda aquí: es la propia app quien conserva la última copia (con su ETag y la
//    hora de sincronización) y la borra al cerrar sesión; ver src/lib/storage.ts.
//  - Avisos push: el servidor (más adelante) manda un JSON; ver src/pwa/push-payload.ts.
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { parsePushPayload } from "./pwa/push-payload";

declare const self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html"), { denylist: [/\/api\//, /\/webhooks\//] }));

// `registerType: "prompt"`: la versión nueva espera hasta que el doctor toca «Actualizar» (mensaje SKIP_WAITING).
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") void self.skipWaiting();
});
clientsClaim();

self.addEventListener("push", (event) => {
  let raw: unknown = null;
  try {
    raw = event.data ? event.data.text() : null;
  } catch {
    raw = null;
  }
  const n = parsePushPayload(raw);
  event.waitUntil(
    self.registration.showNotification(n.title, {
      body: n.body,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      lang: "es-MX",
      tag: n.tag,
      data: { url: n.url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data as { url?: string } | null)?.url ?? "./", self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => w.url.startsWith(self.registration.scope));
      if (open) {
        await open.focus();
        if ("navigate" in open) await (open as WindowClient).navigate(target).catch(() => undefined);
      } else {
        await self.clients.openWindow(target);
      }
    })()
  );
});
