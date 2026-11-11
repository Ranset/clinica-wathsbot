import { useEffect, useRef } from "react";

/**
 * Ejecuta `task` al montar y luego cada `ms`, mientras la pestaña esté visible
 * (una pestaña en segundo plano no consulta) y de inmediato al volver a ella.
 * Si cambia `restartKey` (p. ej. el filtro que usa la tarea) se vuelve a ejecutar al instante.
 * Sin WebSockets en el servidor, esto es lo que mantiene la pantalla al día.
 */
export function usePolling(task: (signal: AbortSignal) => Promise<unknown>, ms: number, enabled = true, restartKey?: unknown) {
  const taskRef = useRef(task);
  taskRef.current = task;

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    const run = (force = false) => {
      // Los sondeos periódicos se saltan con la pestaña oculta; la primera carga, no (hay que mostrar datos).
      if (!force && document.visibilityState === "hidden") return;
      taskRef.current(ctrl.signal).catch(() => {
        /* cada tarea maneja sus errores; aqui no debe escapar una promesa rechazada */
      });
    };
    run(true);
    const timer = setInterval(() => run(), ms);
    const onVisible = () => {
      if (document.visibilityState === "visible") run(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      ctrl.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms, enabled, restartKey]);
}
