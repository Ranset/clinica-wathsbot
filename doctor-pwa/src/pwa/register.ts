import { useSyncExternalStore } from "react";
import { registerSW } from "virtual:pwa-register";

/**
 * Registro del service worker y estado de actualización. `registerType: "prompt"`: cuando hay una
 * versión nueva se avisa y el doctor decide cuándo actualizar (no se recarga la agenda a media consulta).
 * Solo se registra en el build de producción (en desarrollo no hay service worker).
 */
type PwaState = { needRefresh: boolean; offlineReady: boolean };

let state: PwaState = { needRefresh: false, offlineReady: false };
const listeners = new Set<() => void>();
let updateSW: ((reload?: boolean) => Promise<void>) | null = null;

function set(next: Partial<PwaState>) {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

export function initPwa(): void {
  if (!import.meta.env.PROD || updateSW) return;
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh: () => set({ needRefresh: true }),
    onOfflineReady: () => set({ offlineReady: true }),
    // Con la app abierta muchas horas (un doctor la deja en la pantalla de inicio), se busca versión nueva cada hora.
    onRegisteredSW: (_url, reg) => {
      if (reg) setInterval(() => void reg.update().catch(() => undefined), 60 * 60 * 1000);
    },
  });
}

/** Activa la versión nueva y recarga. */
export function applyUpdate(): void {
  void updateSW?.(true);
}

export function dismissOfflineReady(): void {
  set({ offlineReady: false });
}

export function usePwaState(): PwaState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
    () => state
  );
}
