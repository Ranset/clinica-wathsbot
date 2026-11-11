import { CloudOff, Download, RefreshCw } from "lucide-react";
import { Button } from "@clinica/calendar";
import { useConnection } from "../lib/connection";
import { ago, fmtSyncTime } from "../lib/fmt";
import { useNow } from "../lib/use-now";
import { applyUpdate, dismissOfflineReady, usePwaState } from "../pwa/register";
import { useAuth } from "../auth";

/**
 * «Actualizado hace 4 s» o, si lo que se ve es una copia o falló el último intento, «Última sincronización:
 * hoy 10:42». Tiene su propio reloj para no repintar toda la página.
 */
export function SyncStatus({ syncedAt, stale }: { syncedAt: Date | null; stale: boolean }) {
  const now = useNow(5_000);
  if (!syncedAt) {
    return (
      <span className="whitespace-nowrap text-xs text-text-3" aria-live="off">
        Cargando…
      </span>
    );
  }
  return stale ? (
    <span className="whitespace-nowrap text-xs font-semibold text-warning-text" data-testid="sync-status">
      Última sincronización: {fmtSyncTime(syncedAt, now)}
    </span>
  ) : (
    <span className="whitespace-nowrap text-xs text-text-3" data-testid="sync-status" aria-live="off">
      Actualizado {ago(syncedAt, now)}
    </span>
  );
}

/** Avisos de estado globales: sin conexión (solo lectura), sesión sin confirmar, versión nueva. */
export function StatusBanners() {
  const { online } = useConnection();
  const { verified } = useAuth();
  const pwa = usePwaState();

  return (
    <>
      {!online && (
        <div role="status" className="flex items-start gap-2 border-b border-warning-soft bg-warning-tint px-4 py-2 text-xs font-semibold text-warning-text sm:px-6">
          <CloudOff className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>Sin conexión. Ves lo último que se guardó en este dispositivo; para registrar ausencias o pedir cambios necesitas internet.</span>
        </div>
      )}
      {online && !verified && (
        <div role="status" className="flex items-center gap-2 border-b bg-subtle px-4 py-1.5 text-xs font-medium text-text-2 sm:px-6">
          Confirmando tu sesión con el servidor…
        </div>
      )}
      {pwa.needRefresh && (
        <div role="status" className="flex flex-wrap items-center gap-2 border-b border-brand-soft bg-brand-tint px-4 py-2 text-xs font-semibold text-brand-text sm:px-6">
          <Download className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">Hay una versión nueva de la app.</span>
          <Button size="sm" onClick={applyUpdate}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Actualizar
          </Button>
        </div>
      )}
      {pwa.offlineReady && (
        <div role="status" className="flex items-center gap-2 border-b border-success-soft bg-success-tint px-4 py-2 text-xs font-semibold text-success-text sm:px-6">
          <span className="min-w-0 flex-1">Lista para abrirse sin conexión.</span>
          <button type="button" onClick={dismissOfflineReady} className="rounded-full px-2 py-0.5 hover:bg-success-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft">
            Entendido
          </button>
        </div>
      )}
    </>
  );
}
