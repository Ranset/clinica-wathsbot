import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { useApi } from "../../api-context";
import { useCanWrite } from "../../lib/can-write";
import { messageFor } from "../../lib/errors";
import { detectPush, disablePush, enablePush, getPushStatus, isPushError, browserEnv, type PushStatus, type PushUnsupported } from "../../pwa/push";
import { useToast } from "../../toast";
import { BusyButton, FormError, Notice, Spinner } from "../../ui/controls";

const UNSUPPORTED: Record<PushUnsupported, string> = {
  "ios-instalar":
    "En iPhone y iPad los avisos solo funcionan con la app instalada en la pantalla de inicio (iOS o iPadOS 16.4 o superior). En Safari toca Compartir → «Añadir a pantalla de inicio», abre la app desde ahí y vuelve a esta pantalla.",
  "sin-service-worker": "Este navegador no tiene (o aún no activó) el servicio en segundo plano que necesitan los avisos. En la versión de desarrollo no se activa: usa la versión compilada.",
  "sin-push": "Este navegador no admite avisos push.",
  "sin-notificaciones": "Este navegador no admite notificaciones.",
  "sin-clave": "Los avisos todavía no están configurados en el servidor (falta su clave pública).",
};

/**
 * Avisos push de este dispositivo: pedir permiso, suscribir el service worker y registrar la suscripción
 * en el servidor. Solo el lado del cliente; el envío lo hará el servidor más adelante.
 */
export function PushCard() {
  const api = useApi();
  const toast = useToast();
  const { canWrite, reason, reportFailure } = useCanWrite();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getPushStatus());
    } catch {
      setStatus({ kind: "no-soportado", reason: "sin-service-worker" });
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const turnOn = async () => {
    const env = browserEnv();
    const support = detectPush(env);
    if (!support.ok || !env.vapidKey) return;
    setBusy(true);
    setError(null);
    try {
      await enablePush(api, env.vapidKey);
      toast.show("Avisos activados en este dispositivo.");
    } catch (e) {
      if (isPushError(e)) {
        setError(
          e.code === "permiso-denegado"
            ? "No diste permiso para mostrar notificaciones."
            : e.code === "sin-service-worker"
              ? "El servicio en segundo plano de la app aún no está activo. Recarga la página e inténtalo de nuevo."
              : `No se pudo suscribir este dispositivo${e.message && e.message !== e.code ? `: ${e.message}` : "."}`
        );
      } else {
        reportFailure(e);
        setError(messageFor(e));
      }
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setError(null);
    try {
      await disablePush(api);
      toast.show("Avisos desactivados en este dispositivo.");
    } catch (e) {
      reportFailure(e);
      setError(messageFor(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const active = status?.kind === "activo";
  return (
    <section aria-label="Avisos" className="flex flex-col gap-3 rounded-lg border bg-background p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-tint text-brand-text">{active ? <Bell className="h-4 w-4" aria-hidden /> : <BellOff className="h-4 w-4" aria-hidden />}</span>
        <div className="min-w-0">
          <h2 className="text-sm font-bold">Avisos en este dispositivo</h2>
          <p className="text-xs text-text-3">Recibe un aviso cuando cambie tu agenda, aunque la app esté cerrada. Se configura en cada dispositivo.</p>
        </div>
      </div>

      {status === null && <Spinner label="Revisando avisos" />}
      {status?.kind === "no-soportado" && <Notice tone="warn">{UNSUPPORTED[status.reason]}</Notice>}
      {status?.kind === "bloqueado" && <Notice tone="warn">Las notificaciones están bloqueadas para este sitio. Permítelas en los ajustes del navegador (el candado junto a la dirección) y vuelve aquí.</Notice>}
      {status?.kind === "activo" && <Notice tone="ok">Los avisos están activados en este dispositivo.</Notice>}
      <FormError>{error}</FormError>

      {(status?.kind === "inactivo" || status?.kind === "activo") && (
        <div className="flex flex-col items-start gap-2">
          <BusyButton variant={active ? "outline" : "default"} busy={busy} disabled={!canWrite} onClick={() => void (active ? turnOff() : turnOn())}>
            {active ? "Desactivar avisos" : "Activar avisos"}
          </BusyButton>
          {reason && <p className="text-xs font-medium text-warning-text">{reason}</p>}
        </div>
      )}

      <p className="text-xs text-text-3">
        En iPhone y iPad solo funciona con la app instalada en la pantalla de inicio (iOS 16.4 o superior). El servidor de la clínica empezará a enviar avisos más adelante; mientras tanto puedes dejar este dispositivo registrado.
      </p>
    </section>
  );
}
