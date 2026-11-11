import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useApi } from "../api-context";
import { isTransientError } from "./errors";

/**
 * ¿Hay conexión con el servidor? Dos señales: lo que dice el navegador (`navigator.onLine`,
 * que se equivoca a veces) y lo que pasó en la última petición (sin red / 5xx). Las pantallas
 * que leen o escriben avisan el resultado con `reportSuccess` / `reportFailure`; con eso la app
 * pasa sola a «sin conexión» (solo lectura) y vuelve cuando una petición sale bien.
 *
 * Mientras está en «sin conexión» por una petición fallida, una sonda barata (`GET /api/health`) vuelve
 * a preguntar cada pocos segundos y al volver la red o la pestaña: así, tras un fallo pasajero del servidor
 * no hay que esperar al siguiente refresco de la pantalla para poder reintentar.
 */
type ConnectionValue = {
  online: boolean;
  reportSuccess: () => void;
  reportFailure: (err: unknown) => void;
};

const ConnectionContext = createContext<ConnectionValue | null>(null);

const browserOnline = () => (typeof navigator === "undefined" ? true : navigator.onLine !== false);

/** Cada cuánto se vuelve a preguntar si hay servidor mientras se está sin conexión. */
export const PROBE_MS = 5_000;

export function ConnectionProvider({ children, probeMs = PROBE_MS }: { children: ReactNode; probeMs?: number }) {
  const api = useApi();
  const [browser, setBrowser] = useState(browserOnline);
  const [failing, setFailing] = useState(false);

  useEffect(() => {
    const on = () => setBrowser(true);
    const off = () => setBrowser(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const reportSuccess = useCallback(() => setFailing(false), []);
  const reportFailure = useCallback((err: unknown) => {
    if (isTransientError(err)) setFailing(true);
  }, []);

  // La sonda: solo corre mientras una petición real falló.
  useEffect(() => {
    if (!failing) return;
    let alive = true;
    const probe = () => {
      api.health().then(
        () => alive && setFailing(false),
        () => undefined // sigue sin servidor: se vuelve a intentar en el siguiente turno
      );
    };
    const timer = setInterval(() => document.visibilityState !== "hidden" && probe(), probeMs);
    window.addEventListener("online", probe);
    window.addEventListener("focus", probe);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("online", probe);
      window.removeEventListener("focus", probe);
    };
  }, [failing, api, probeMs]);

  const value = useMemo<ConnectionValue>(() => ({ online: browser && !failing, reportSuccess, reportFailure }), [browser, failing, reportSuccess, reportFailure]);
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionValue {
  const v = useContext(ConnectionContext);
  if (!v) throw new Error("useConnection fuera de <ConnectionProvider>");
  return v;
}
