import { useApi } from "../../api-context";
import { useResource } from "../../lib/use-resource";
import type { Absence } from "@clinica/api-client";

/** Mis ausencias (red primero; sin conexión, la última copia guardada). La usan la agenda y la pantalla de ausencias. */
export function useAbsences() {
  const api = useApi();
  return useResource<Absence[]>("absences", (signal) => api.doctorSelf.absences.list({ signal }), { intervalMs: 60_000 });
}
