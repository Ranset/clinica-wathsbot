import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAbortError } from "@clinica/api-client";
import { useAuth } from "../auth";
import { useConnection } from "./connection";
import { messageFor } from "./errors";
import { createSnapshotStore, safeLocalStorage, type SnapshotStore } from "./storage";
import { usePoller } from "./use-poller";

/** Las copias de lectura del usuario de la sesión (sin sesión: no guarda nada). */
export function useSnapshotStore(): SnapshotStore {
  const { user } = useAuth();
  const id = user?.id ?? "";
  return useMemo(() => createSnapshotStore(id ? safeLocalStorage() : null, id), [id]);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Un dato del servidor que se lee primero de la red («network-first») y, si no hay red, de la última
 * copia guardada en el dispositivo: horario, ausencias, solicitudes. Muestra la copia al instante al abrir
 * y la confirma con el servidor enseguida.
 *
 * - `confirmed`: el servidor ya confirmó `data` en esta sesión de la app (si no, es la copia guardada).
 * - `syncedAt`: la última vez que el servidor lo confirmó (de la copia, si aún no hay respuesta).
 * - `error`: el último intento falló; si ya había datos se siguen mostrando.
 *
 * `key` debe ser fija mientras el componente exista.
 */
export function useResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>, opts: { intervalMs?: number; enabled?: boolean } = {}) {
  const { intervalMs = 60_000, enabled = true } = opts;
  const store = useSnapshotStore();
  const { reportSuccess, reportFailure } = useConnection();

  const initial = useMemo(() => store.read<T>(key), [store, key]);
  const [data, setData] = useState<T | null>(initial?.data ?? null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(initial ? new Date(initial.savedAt) : null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRef = useRef(load);
  loadRef.current = load;
  const inflight = useRef<AbortController | null>(null);

  const fetchNow = useCallback(async () => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    try {
      const next = await loadRef.current(ctrl.signal);
      if (ctrl.signal.aborted) return;
      const now = new Date();
      setData((prev) => (same(prev, next) ? prev : next));
      setSyncedAt(now);
      setConfirmed(true);
      setError(null);
      reportSuccess();
      store.write(key, { savedAt: now.toISOString(), data: next });
    } catch (e) {
      if (isAbortError(e) || ctrl.signal.aborted) return;
      reportFailure(e);
      setError(messageFor(e));
    }
  }, [store, key, reportSuccess, reportFailure]);

  usePoller(() => void fetchNow(), key, { intervalMs, enabled });
  useEffect(() => () => inflight.current?.abort(), []);

  /** Cambia lo que se ve al instante (p. ej. tras crear algo); el siguiente `reload` trae la versión del servidor. */
  const apply = useCallback((update: (current: T | null) => T) => setData((prev) => update(prev)), []);

  return { data, error, confirmed, syncedAt, loading: data === null && error === null, reload: fetchNow, apply };
}
