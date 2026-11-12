import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError, type PersonalEvent } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { useConnection } from "../../lib/connection";
import { messageFor } from "../../lib/errors";
import { usePoller } from "../../lib/use-poller";
import { useSnapshotStore } from "../../lib/use-resource";

/** El rango pedido: instantes UTC `[from, to)`, el mismo de la agenda de esa semana. */
export type EventsQuery = { from: string; to: string };

const keyOf = (q: EventsQuery) => `${q.from}|${q.to}`;
const EMPTY: PersonalEvent[] = [];
/** Una copia por rango, junto a la de la agenda de esa semana (comparten el tope de copias `agenda:*` del dispositivo). */
const snapshotKey = (q: EventsQuery) => `agenda:events:${q.from}_${q.to}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * MIS eventos personales del rango visible: siempre al día y legibles sin conexión. Mismo patrón que `useAgenda`
 * (red primero; se muestra al instante la última copia guardada de ESE rango y se confirma con el servidor; con la pestaña
 * oculta no consulta), sin ETag: la lista es chica. Son privados: solo salen de la API del propio doctor.
 *
 *  - `ready`: ya hay datos de ESTE rango (de la red o de la copia).
 *  - `stale`: lo que se ve NO está confirmado (viene de la copia, o el último intento falló).
 */
export function usePersonalEvents(query: EventsQuery | null, opts: { intervalMs?: number; coalesceMs?: number } = {}) {
  const { intervalMs = 20_000, coalesceMs = 250 } = opts;
  const api = useApi();
  const store = useSnapshotStore();
  const { reportSuccess, reportFailure } = useConnection();

  const key = query ? keyOf(query) : "";
  const [data, setData] = useState<{ key: string; items: PersonalEvent[] } | null>(null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryRef = useRef(query);
  queryRef.current = query;
  const inflight = useRef<AbortController | null>(null);

  // Al abrir un rango (o cambiar de rango): lo guardado de ESE rango; si no hay, nada. Durante el render del cambio de clave,
  // para que no haya un cuadro con los eventos del rango anterior.
  const [loadedKey, setLoadedKey] = useState("");
  if (loadedKey !== key) {
    setLoadedKey(key);
    const snap = query ? store.read<PersonalEvent[]>(snapshotKey(query)) : null;
    setData(snap && Array.isArray(snap.data) ? { key, items: snap.data } : null);
    setSyncedAt(snap ? new Date(snap.savedAt) : null);
    setConfirmed(false);
    setError(null);
  }

  const fetchNow = useCallback(async () => {
    const q = queryRef.current;
    if (!q) return;
    const k = keyOf(q);
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    try {
      const items = await api.doctorSelf.personalEvents.list(q, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      const now = new Date();
      setData((prev) => (prev && prev.key === k && same(prev.items, items) ? prev : { key: k, items }));
      setSyncedAt(now);
      setConfirmed(true);
      setError(null);
      reportSuccess();
      store.write(snapshotKey(q), { savedAt: now.toISOString(), data: items });
    } catch (e) {
      if (isAbortError(e) || ctrl.signal.aborted) return;
      reportFailure(e);
      setError(messageFor(e));
    }
  }, [api, store, reportSuccess, reportFailure]);

  const refresh = usePoller(() => void fetchNow(), key, { intervalMs, coalesceMs, enabled: !!key });
  useEffect(() => () => inflight.current?.abort(), [key]);

  const ready = data?.key === key && key !== "";
  return {
    events: ready ? data!.items : EMPTY,
    ready,
    error,
    stale: ready && (!confirmed || error !== null),
    syncedAt,
    /** Pide un refresco; varios seguidos se juntan en uno. */
    refresh,
    /** Refresca ya y espera (tras crear, editar o borrar). */
    reload: fetchNow,
  };
}
