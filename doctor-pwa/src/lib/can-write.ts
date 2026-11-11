import { useAuth } from "../auth";
import { useConnection } from "./connection";

/**
 * Sin conexión la app es de SOLO LECTURA: crear o borrar (ausencias, solicitudes, avisos) se
 * deshabilita y dice por qué. También mientras la sesión abierta sin red no se haya confirmado
 * (todavía no hay token CSRF).
 */
export function useCanWrite(): { canWrite: boolean; reason: string | null; reportFailure: (err: unknown) => void } {
  const { online, reportFailure } = useConnection();
  const { verified } = useAuth();
  if (!online) return { canWrite: false, reason: "Sin conexión: esto necesita internet. Mientras tanto la app es de solo lectura.", reportFailure };
  if (!verified) return { canWrite: false, reason: "Confirmando tu sesión con el servidor…", reportFailure };
  return { canWrite: true, reason: null, reportFailure };
}
