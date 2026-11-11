import { useCallback, useEffect, useRef, useState } from "react";
import { isAbortError, type Booking } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { useConnection } from "../../lib/connection";
import { messageFor } from "../../lib/errors";
import { usePoller } from "../../lib/use-poller";
import { useSnapshotStore } from "../../lib/use-resource";

/** El rango pedido: instantes UTC `[from, to)`, ver `rangeToUtc`. */
export type AgendaQuery = { from: string; to: string };

const keyOf = (q: AgendaQuery) => `${q.from}|${q.to}`;
const EMPTY: Booking[] = [];

/** Clave de la copia guardada: una por rango. */
const snapshotKey = (q: AgendaQuery) => `agenda:${q.from}_${q.to}`;

/**
 * MI agenda del rango visible, siempre al día y legible sin conexión. Es el patrón de `useBookings` de
 * admin-web (sondeo con `If-None-Match`: un 304 NO toca el estado; avisos juntados con `coalesce`; con la
 * pestaña oculta no consulta) con la copia en el dispositivo:
 *
 *  - Red primero («network-first»): cada consulta va al servidor; solo si falla se queda lo que hay.
 *  - Al abrir un rango se muestra enseguida la última copia guardada de ESE rango, y se confirma con el
 *    servidor. El ETag guardado viaja junto con los datos que describe (si no, un 304 dejaría la pantalla
 *    sin datos): al volver el servidor puede contestar 304 y la copia queda confirmada sin descargar nada.
 *  - `syncedAt`: la última vez que el servidor confirmó esta agenda (la hora de la copia mientras tanto).
 *  - `stale`: lo que se ve NO está confirmado (viene de la copia, o el último intento falló).
 *  - `ready`: ya hay agenda de ESTE rango (de la red o de la copia).
 *
 * El doctor no recibe el teléfono del paciente (contrato v0.2): `patient.id` es el id de la cita.
 */
export function useAgenda(query: AgendaQuery | null, opts: { intervalMs?: number; coalesceMs?: number } = {}) {
  const { intervalMs = 15_000, coalesceMs = 250 } = opts;
  const api = useApi();
  const store = useSnapshotStore();
  const { reportSuccess, reportFailure } = useConnection();

  const key = query ? keyOf(query) : "";
  const [data, setData] = useState<{ key: string; items: Booking[] } | null>(null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryRef = useRef(query);
  queryRef.current = query;
  const etag = useRef<{ key: string; value: string | null }>({ key: "", value: null });
  const dataRef = useRef(data);
  dataRef.current = data;
  const inflight = useRef<AbortController | null>(null);

  // Al abrir un rango (o cambiar de rango): lo guardado de ESE rango, con su ETag y su hora; si no hay, nada.
  // Se hace durante el render del cambio de clave para que no haya un cuadro con la agenda del rango anterior.
  const [loadedKey, setLoadedKey] = useState("");
  if (loadedKey !== key) {
    setLoadedKey(key);
    const snap = query ? store.read<Booking[]>(snapshotKey(query)) : null;
    etag.current = snap && Array.isArray(snap.data) ? { key, value: snap.etag ?? null } : { key: "", value: null };
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
      const sent = etag.current.key === k ? etag.current.value : null;
      const r = await api.doctorSelf.appointments(q, { etag: sent, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      const now = new Date();
      etag.current = { key: k, value: r.etag };
      let items: Booking[];
      if (r.notModified) {
        // 304: lo que ya se tiene sigue vigente; el estado de las citas no cambia (la rejilla ni se entera).
        const have = dataRef.current;
        if (!have || have.key !== k) return;
        items = have.items;
      } else {
        items = r.data.items;
        setData({ key: k, items });
      }
      setSyncedAt(now);
      setConfirmed(true);
      setError(null);
      reportSuccess();
      store.write(snapshotKey(q), { savedAt: now.toISOString(), data: items, etag: r.etag });
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
    bookings: ready ? data!.items : EMPTY,
    ready,
    error,
    stale: ready && (!confirmed || error !== null),
    syncedAt,
    /** Pide un refresco; varios seguidos se juntan en uno. */
    refresh,
    /** Refresca ya y espera. */
    refreshNow: fetchNow,
  };
}
