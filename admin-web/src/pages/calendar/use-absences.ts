import { useCallback, useState } from "react";
import { isAbortError, type Absence, type ApiClient, type BusyTime } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { usePolling } from "../../lib/use-polling";

type Range = { from: string; to: string };
const EMPTY: never[] = [];

/**
 * Una lista de TODOS los doctores que toca `[from, to)`, para pintarla en la rejilla del calendario. Se consulta solo cuando
 * `enabled` (la vista la usa) y se refresca cada `intervalMs` y al volver a la pestaña, igual que el resto de la pantalla
 * (sin WebSockets). Si falla un refresco se siguen mostrando las últimas que llegaron: lo que no se ve no cambia lo que el
 * servidor permite agendar, solo lo que se alcanza a notar.
 */
function useRangeList<T>(
  range: Range | null,
  enabled: boolean,
  intervalMs: number,
  fetchList: (api: ApiClient, range: Range, signal: AbortSignal) => Promise<T[]>
): T[] {
  const api = useApi();
  const key = range ? `${range.from}|${range.to}` : "";
  const [data, setData] = useState<{ key: string; items: T[] } | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!range) return;
      try {
        const items = await fetchList(api, range, signal);
        if (!signal.aborted) setData({ key, items });
      } catch (e) {
        if (isAbortError(e) || signal.aborted) return;
        // se conservan las últimas que llegaron
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, key]
  );

  usePolling(load, intervalMs, enabled && key !== "", key);
  // los datos de OTRO rango no se pintan (al cambiar de día no se ven un instante los del día anterior)
  return enabled && data?.key === key ? data.items : (EMPTY as T[]);
}

/** Las ausencias de TODOS los doctores que tocan `[from, to)` (franjas ámbar con su motivo). */
export function useAbsences(range: Range | null, enabled: boolean, intervalMs = 30_000): Absence[] {
  return useRangeList(range, enabled, intervalMs, (api, r, signal) => api.absences.list(r, { signal }));
}

/**
 * Cuándo está ocupado cada doctor por un evento PERSONAL (franjas grises «No disponible»). Solo trae doctor y horario: el
 * título y las notas del evento son privados del doctor y no llegan aquí.
 */
export function useBusyTimes(range: Range | null, enabled: boolean, intervalMs = 30_000): BusyTime[] {
  return useRangeList(range, enabled, intervalMs, (api, r, signal) => api.busyTimes.list(r, { signal }));
}
