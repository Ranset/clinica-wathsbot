import { useCallback, useState } from "react";
import { Bot, BotOff } from "lucide-react";
import { Button, cn } from "@clinica/calendar";
import { isAbortError, type BotSettings } from "@clinica/api-client";
import { useApi } from "../api-context";
import { useAuth } from "../auth";
import { fmtDateTime } from "../lib/fmt";
import { messageFor } from "../lib/errors";
import { usePolling } from "../lib/use-polling";
import { useToast } from "../toast";
import { BusyButton, dangerButton } from "../ui/controls";
import { Modal } from "../ui/modal";

/**
 * El botón del bot: muestra SIEMPRE si está activo y lo cambia. Se consulta cada
 * 15 s, así que si otra persona lo apaga, aquí se ve. Apagarlo pide confirmación
 * porque el bot deja de contestar a los pacientes.
 */
export function BotToggle() {
  const api = useApi();
  const toast = useToast();
  const { permissions } = useAuth();
  const [settings, setSettings] = useState<BotSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  usePolling(
    useCallback(
      async (signal) => {
        try {
          setSettings(await api.bot.get({ signal }));
          setFailed(false);
        } catch (e) {
          if (!isAbortError(e)) setFailed(true);
        }
      },
      [api]
    ),
    15_000
  );

  const apply = async (active: boolean) => {
    setBusy(true);
    try {
      setSettings(await api.bot.set(active));
      setFailed(false);
      setConfirming(false);
      toast.show(active ? "El bot está activo: contesta los mensajes de WhatsApp." : "El bot está apagado: ahora atienden las personas.");
    } catch (e) {
      toast.show(messageFor(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const active = settings?.active ?? null;
  const label = active === null ? (failed ? "Bot sin estado" : "Bot…") : active ? "Bot activo" : "Bot apagado";
  const who = settings?.updatedBy && settings.updatedAt ? `Lo cambió ${settings.updatedBy} el ${fmtDateTime(settings.updatedAt)}` : "Interruptor del bot de WhatsApp";

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={active ?? false}
        aria-label="Bot de WhatsApp"
        title={who}
        disabled={active === null || busy || !permissions.toggleBot}
        onClick={() => (active ? setConfirming(true) : void apply(true))}
        className={cn(
          "flex h-9 items-center gap-2 whitespace-nowrap rounded-full border px-3 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft disabled:cursor-not-allowed disabled:opacity-60",
          active === true && "border-success-soft bg-success-tint text-success-text hover:brightness-95",
          active === false && "border-danger-soft bg-danger-tint text-danger-text hover:brightness-95",
          active === null && "border-border bg-secondary text-text-3"
        )}
      >
        {active === false ? <BotOff className="h-4 w-4" aria-hidden /> : <Bot className="h-4 w-4" aria-hidden />}
        <span>{label}</span>
        <span aria-hidden className={cn("relative h-4 w-7 rounded-full transition-colors", active ? "bg-success" : "bg-text-4")}>
          <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all", active ? "left-3.5" : "left-0.5")} />
        </span>
      </button>

      {confirming && (
        <Modal
          title="¿Apagar el bot?"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Cancelar
              </Button>
              <BusyButton busy={busy} className={dangerButton} onClick={() => void apply(false)}>
                Sí, apagar el bot
              </BusyButton>
            </>
          }
        >
          <p className="text-sm text-text-2">
            Con el bot apagado <strong>deja de contestar</strong> los mensajes de WhatsApp. Los pacientes serán atendidos por una persona desde Zernio, y puedes volver a encenderlo
            cuando quieras.
          </p>
        </Modal>
      )}
    </>
  );
}
