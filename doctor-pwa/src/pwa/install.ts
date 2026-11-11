import { useSyncExternalStore } from "react";
import { isIos, isStandalone } from "./push";

/**
 * Instalación de la app. Chrome/Edge/Android avisan con `beforeinstallprompt` (se guarda el evento y
 * se lanza desde un botón); Safari en iPhone no tiene ese evento: ahí se explica el procedimiento manual.
 */
type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
let version = 0;
const listeners = new Set<() => void>();
const bump = () => {
  version++;
  for (const fn of listeners) fn();
};

let captured = false;
/** Se llama una vez al arrancar: el navegador dispara `beforeinstallprompt` muy pronto. */
export function initInstallCapture(): void {
  if (captured || typeof window === "undefined") return;
  captured = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    bump();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    bump();
  });
}

export type InstallState = {
  /** Ya corre como app instalada (o se acaba de instalar). */
  standalone: boolean;
  /** El navegador ofrece instalar con un botón. */
  canPrompt: boolean;
  ios: boolean;
  prompt: () => Promise<"accepted" | "dismissed" | "unavailable">;
};

async function prompt(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const ev = deferred;
  if (!ev) return "unavailable";
  deferred = null;
  bump();
  await ev.prompt();
  return (await ev.userChoice).outcome;
}

export function useInstall(): InstallState {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
    () => version
  );
  const ios = typeof navigator !== "undefined" && isIos(navigator.userAgent, navigator.platform ?? "", navigator.maxTouchPoints ?? 0);
  return { standalone: installed || isStandalone(), canPrompt: deferred !== null, ios, prompt };
}
