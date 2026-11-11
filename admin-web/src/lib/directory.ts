import { useCallback, useEffect, useState } from "react";
import { isAbortError, type Doctor, type Room, type WeeklyHours } from "@clinica/api-client";
import { useApi } from "../api-context";
import { messageFor } from "./errors";

/** Lo que casi todas las pantallas necesitan: doctores (con su horario efectivo), consultorios y horario de la clínica. */
export type Directory = {
  doctors: Doctor[];
  rooms: Room[];
  clinicHours: WeeklyHours;
};

export function useDirectory() {
  const api = useApi();
  const [dir, setDir] = useState<Directory | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [doctors, rooms, clinicHours] = await Promise.all([api.doctors.list({ signal }), api.rooms.list({ signal }), api.clinicHours.get({ signal })]);
        setDir({ doctors, rooms, clinicHours });
        setError(null);
      } catch (e) {
        if (!isAbortError(e)) setError(messageFor(e));
      }
    },
    [api]
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  return { dir, error, reload: load };
}
