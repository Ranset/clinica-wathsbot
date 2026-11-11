import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Doctor } from "@clinica/api-client";
import { useApi } from "./api-context";
import { useResource } from "./lib/use-resource";

type ProfileValue = {
  /** Mi registro de doctor: nombre, especialidad y horario semanal efectivo. `null` hasta que llega (o hay copia). */
  doctor: Doctor | null;
  error: string | null;
  confirmed: boolean;
  syncedAt: Date | null;
  reload: () => Promise<void>;
};

const ProfileContext = createContext<ProfileValue | null>(null);

/**
 * El doctor de la sesión (`GET /api/doctor/hours`). Lo usan la agenda (carril con su nombre y su horario
 * sombreado) y la pantalla de horario. Cambia poco (el personal puede aprobar un cambio de horario), así
 * que se revisa cada minuto; también queda guardado para abrir sin conexión.
 */
export function ProfileProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const r = useResource<Doctor>("profile", (signal) => api.doctorSelf.hours({ signal }), { intervalMs: 60_000 });
  const value = useMemo<ProfileValue>(() => ({ doctor: r.data, error: r.error, confirmed: r.confirmed, syncedAt: r.syncedAt, reload: r.reload }), [r.data, r.error, r.confirmed, r.syncedAt, r.reload]);
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile(): ProfileValue {
  const v = useContext(ProfileContext);
  if (!v) throw new Error("useProfile fuera de <ProfileProvider>");
  return v;
}
