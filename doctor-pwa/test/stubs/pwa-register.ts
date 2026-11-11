// `virtual:pwa-register` solo existe dentro de vite-plugin-pwa; en las pruebas (jsdom) no hay service worker.
export type RegisterSWOptions = {
  immediate?: boolean;
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  onRegisteredSW?: (url: string, reg: ServiceWorkerRegistration | undefined) => void;
};

export function registerSW(_options?: RegisterSWOptions): (reload?: boolean) => Promise<void> {
  return async () => undefined;
}
