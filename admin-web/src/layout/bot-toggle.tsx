import { useCallback, useState } from "react";
import { Facebook, Instagram, MessageCircle } from "lucide-react";
import { Button, channelLabel, cn } from "@clinica/calendar";
import { isAbortError, type BotSettings, type Channel } from "@clinica/api-client";
import { useApi } from "../api-context";
import { useAuth } from "../auth";
import { fmtDateTime } from "../lib/fmt";
import { messageFor } from "../lib/errors";
import { usePolling } from "../lib/use-polling";
import { useToast } from "../toast";
import { BusyButton, dangerButton } from "../ui/controls";
import { Modal } from "../ui/modal";

/** Los canales del bot, en el orden en que se muestran. */
const CHANNELS = [
  { id: "whatsapp", icon: MessageCircle },
  { id: "facebook", icon: Facebook },
  { id: "instagram", icon: Instagram },
] as const satisfies readonly { id: Channel; icon: unknown }[];

/**
 * Lo que dice el servidor de UN canal. Un servidor de la versión anterior solo manda `active` (= WhatsApp) y no conoce los otros dos
 * canales: se muestran apagados (nunca se supone «activo»).
 */
function stateOf(s: BotSettings | null, c: Channel): boolean | null {
  if (!s) return null;
  return s.channels?.[c] ?? (c === "whatsapp" ? s.active : false);
}

function changedBy(s: BotSettings | null, c: Channel): { by: string | null; at: string | null } {
  const u = s?.channelUpdates?.[c] ?? (c === "whatsapp" && s ? { updatedBy: s.updatedBy ?? null, updatedAt: s.updatedAt ?? null } : null);
  return { by: u?.updatedBy ?? null, at: u?.updatedAt ?? null };
}

/**
 * Los botones del bot: UNO POR CANAL (WhatsApp, Messenger, Instagram). Cada uno muestra SIEMPRE si el bot contesta por ese canal y
 * quién lo cambió (al pasar el puntero), y se cambia sin tocar los otros. Se consultan cada 15 s, así que si otra persona apaga uno,
 * aquí se ve. Apagar uno pide confirmación porque el bot deja de contestar a los pacientes de ese canal.
 */
export function BotToggle() {
  const api = useApi();
  const toast = useToast();
  const { permissions } = useAuth();
  const [settings, setSettings] = useState<BotSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<Channel | null>(null);
  const [confirming, setConfirming] = useState<Channel | null>(null);

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

  const apply = async (channel: Channel, active: boolean) => {
    setBusy(channel);
    try {
      setSettings(await api.bot.setChannel(channel, active));
      setFailed(false);
      setConfirming(null);
      const name = channelLabel(channel);
      toast.show(active ? `El bot está activo: contesta los mensajes de ${name}.` : `El bot de ${name} está apagado: ahora atienden las personas.`);
    } catch (e) {
      toast.show(messageFor(e), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div role="group" aria-label="Bot por canal" className="flex items-center gap-1">
        {CHANNELS.map(({ id, icon: ChannelIcon }) => {
          const active = stateOf(settings, id);
          const name = channelLabel(id);
          const { by, at } = changedBy(settings, id);
          const state = active === null ? (failed ? "sin estado" : "…") : active ? "activo" : "apagado";
          const who = by && at ? `Lo cambió ${by} el ${fmtDateTime(at)}` : `Interruptor del bot de ${name}`;
          return (
            <button
              key={id}
              type="button"
              role="switch"
              aria-checked={active ?? false}
              aria-label={`Bot de ${name}`}
              title={`${name}: ${state}. ${who}`}
              data-channel={id}
              disabled={active === null || busy === id || !permissions.toggleBot}
              onClick={() => (active ? setConfirming(id) : void apply(id, true))}
              className={cn(
                "flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft disabled:cursor-not-allowed disabled:opacity-60 sm:px-2.5",
                active === true && "border-success-soft bg-success-tint text-success-text hover:brightness-95",
                active === false && "border-danger-soft bg-danger-tint text-danger-text hover:brightness-95",
                active === null && "border-border bg-secondary text-text-3"
              )}
            >
              <ChannelIcon className="h-4 w-4" aria-hidden />
              <span className="hidden lg:inline">{name}</span>
              <span className="sr-only">{active === null ? (failed ? "Bot sin estado" : "Bot…") : active ? "Bot activo" : "Bot apagado"}</span>
              <span aria-hidden className={cn("relative h-4 w-7 shrink-0 rounded-full transition-colors", active ? "bg-success" : "bg-text-4")}>
                <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all", active ? "left-3.5" : "left-0.5")} />
              </span>
            </button>
          );
        })}
      </div>

      {confirming && (
        <Modal
          title="¿Apagar el bot?"
          description={channelLabel(confirming)}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirming(null)}>
                Cancelar
              </Button>
              <BusyButton busy={busy === confirming} className={dangerButton} onClick={() => void apply(confirming, false)}>
                Sí, apagar el bot
              </BusyButton>
            </>
          }
        >
          <p className="text-sm text-text-2">
            Con el bot apagado <strong>deja de contestar</strong> los mensajes de <strong>{channelLabel(confirming)}</strong>. Esos pacientes serán atendidos por una persona desde Zernio,
            y puedes volver a encenderlo cuando quieras. Los otros canales no cambian.
          </p>
        </Modal>
      )}
    </>
  );
}
