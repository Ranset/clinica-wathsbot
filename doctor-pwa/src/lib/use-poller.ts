import { useCallback, useEffect, useRef } from "react";
import { coalesce } from "@clinica/calendar";

/**
 * Ejecuta `task` al montar (y cuando cambia `key`) y luego cada `intervalMs`, con la pestaña visible.
 * El servidor no tiene WebSockets, así que esto es lo que mantiene la pantalla al día. Los avisos que
 * llegan juntos (el reloj, volver a la pestaña, volver la red) se juntan con `coalesce` en UNA sola llamada.
 *
 * Devuelve `trigger`: pide un refresco (varios seguidos se juntan en uno).
 */
export function usePoller(task: () => void, key: string, opts: { intervalMs: number; coalesceMs?: number; enabled?: boolean }): () => void {
  const { intervalMs, coalesceMs = 250, enabled = true } = opts;
  const taskRef = useRef(task);
  taskRef.current = task;
  const triggerRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled) return;
    taskRef.current();

    const merged = coalesce(() => taskRef.current(), coalesceMs);
    triggerRef.current = merged.trigger;
    const visible = () => document.visibilityState !== "hidden";
    const timer = setInterval(() => visible() && merged.trigger(), intervalMs);
    const onWake = () => visible() && merged.trigger();
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      merged.cancel();
      clearInterval(timer);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onWake);
      triggerRef.current = () => undefined;
    };
  }, [key, enabled, intervalMs, coalesceMs]);

  return useCallback(() => triggerRef.current(), []);
}
