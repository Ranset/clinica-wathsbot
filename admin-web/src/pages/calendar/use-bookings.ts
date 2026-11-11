import { useCallback, useEffect, useRef, useState } from "react";
import { coalesce } from "@clinica/calendar";
import { isAbortError, type Booking } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { messageFor } from "../../lib/errors";

export type BookingsQuery = { from: string; to: string; doctorId?: string; roomId?: string };

const keyOf = (q: BookingsQuery) => `${q.from}|${q.to}|${q.doctorId ?? ""}|${q.roomId ?? ""}`;
const EMPTY: Booking[] = [];

/**
 * Las citas del rango visible, siempre al día. El servidor no tiene WebSockets, así
 * que se pregunta cada `intervalMs`; con `If-None-Match` la respuesta suele ser un
 * 304 sin cuerpo, y un 304 NO toca el estado (la rejilla ni se entera).
 *
 * Los avisos que llegan juntos (el reloj, volver a la pestaña, una cita recién
 * guardada) se juntan con `coalesce` en UNA sola consulta.
 *
 * - `ready`: ya llegaron las citas de ESTE rango (al cambiar de rango vuelve a `false`).
 * - `error`: el último refresco falló; si ya había datos se siguen mostrando.
 */
export function useBookings(query: BookingsQuery | null, opts: { intervalMs?: number; coalesceMs?: number } = {}) {
  const { intervalMs = 5_000, coalesceMs = 250 } = opts;
  const api = useApi();
  const [data, setData] = useState<{ key: string; items: Booking[] } | null>(null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const queryRef = useRef(query);
  queryRef.current = query;
  const etag = useRef<{ key: string; value: string | null }>({ key: "", value: null });
  const inflight = useRef<AbortController | null>(null);
  const trigger = useRef<(() => void) | null>(null);

  const key = query ? keyOf(query) : "";

  const fetchNow = useCallback(async () => {
    const q = queryRef.current;
    if (!q) return;
    const k = keyOf(q);
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    try {
      const sent = etag.current.key === k ? etag.current.value : null;
      const r = await api.appointments.list(q, { etag: sent, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      etag.current = { key: k, value: r.etag };
      if (!r.notModified) setData({ key: k, items: r.data.items });
      setSyncedAt(new Date());
      setError(null);
    } catch (e) {
      if (isAbortError(e) || ctrl.signal.aborted) return;
      setError(messageFor(e));
    }
  }, [api]);

  useEffect(() => {
    if (!key) return;
    etag.current = { key: "", value: null };
    setError(null);
    void fetchNow();

    const merged = coalesce(() => void fetchNow(), coalesceMs);
    trigger.current = merged.trigger;
    const visible = () => document.visibilityState !== "hidden";
    const timer = setInterval(() => visible() && merged.trigger(), intervalMs);
    const onWake = () => visible() && merged.trigger();
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      merged.cancel();
      clearInterval(timer);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
      inflight.current?.abort();
      trigger.current = null;
    };
  }, [key, intervalMs, coalesceMs, fetchNow]);

  const ready = data?.key === key && key !== "";
  return {
    bookings: ready ? data!.items : EMPTY,
    ready,
    error,
    syncedAt,
    /** Pide un refresco; varios seguidos se juntan en uno. */
    refresh: useCallback(() => trigger.current?.(), []),
    /** Refresca ya y espera (después de guardar algo). */
    refreshNow: fetchNow,
  };
}
