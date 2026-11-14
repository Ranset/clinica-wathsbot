import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Bot, BotOff, ChevronDown, Clock, Facebook, Instagram, MessageCircle } from "lucide-react";
import { Button, channelLabel, cn } from "@clinica/calendar";
import { isAbortError, type BotMode, type BotSchedule, type BotSettings, type Channel } from "@clinica/api-client";
import { useApi } from "../api-context";
import { useAuth } from "../auth";
import { fmtDateTime } from "../lib/fmt";
import { messageFor } from "../lib/errors";
import { usePolling } from "../lib/use-polling";
import { useToast } from "../toast";
import { BusyButton, dangerButton } from "../ui/controls";
import { Modal } from "../ui/modal";
import { ScheduleDialog, scheduleLabel, type ScheduleChange } from "./bot-schedule";

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

/** El modo del canal y su horario guardado. Un servidor de la versión anterior no manda `modes`: todo es manual. */
function modeOf(s: BotSettings | null, c: Channel): BotMode {
  return s?.modes?.[c] ?? "manual";
}
function scheduleOf(s: BotSettings | null, c: Channel): BotSchedule | null {
  return s?.schedules?.[c] ?? null;
}

function changedBy(s: BotSettings | null, c: Channel): { by: string | null; at: string | null } {
  const u = s?.channelUpdates?.[c] ?? (c === "whatsapp" && s ? { updatedBy: s.updatedBy ?? null, updatedAt: s.updatedAt ?? null } : null);
  return { by: u?.updatedBy ?? null, at: u?.updatedAt ?? null };
}

/**
 * El bot, UN solo elemento en el encabezado: dice por qué canales contesta (WhatsApp, Messenger, Instagram) y, al darle clic, despliega
 * un panel con un interruptor por canal, que se cambian de forma independiente. Cada fila dice si el bot está activo en ese canal y quién
 * lo cambió. Se consulta cada 15 s, así que si otra persona cambia un canal, aquí se ve (también con el panel abierto). Apagar un canal pide
 * confirmación porque el bot deja de contestar a los pacientes de ese canal; encenderlo, no.
 */
export function BotToggle() {
  const api = useApi();
  const toast = useToast();
  const { permissions } = useAuth();
  const [settings, setSettings] = useState<BotSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<Channel | null>(null);
  const [confirming, setConfirming] = useState<Channel | null>(null);
  const [scheduling, setScheduling] = useState<Channel | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

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

  // El panel se cierra con un clic fuera, con Esc (y el foco vuelve al botón) o al salir de él con el teclado. Mientras se pide la
  // confirmación de apagar, no se toca: esa ventana tiene su propio Esc y sus clics no son "fuera".
  const dialog = confirming !== null || scheduling !== null;
  useEffect(() => {
    if (!open || dialog) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, dialog]);

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

  /** Guarda el modo y el horario de un canal desde la ventana de «Horario». */
  const saveSchedule = async (channel: Channel, change: ScheduleChange) => {
    setBusy(channel);
    setScheduleError(null);
    try {
      setSettings(await api.bot.configure(channel, change));
      setFailed(false);
      setScheduling(null);
      const name = channelLabel(channel);
      toast.show(change.mode === "schedule" ? `El bot de ${name} se encenderá y apagará solo con el horario.` : `El bot de ${name} vuelve a manejarse con su interruptor.`);
    } catch (e) {
      setScheduleError(messageFor(e));
    } finally {
      setBusy(null);
    }
  };

  const states = CHANNELS.map((c) => ({ ...c, name: channelLabel(c.id), active: stateOf(settings, c.id), mode: modeOf(settings, c.id), schedule: scheduleOf(settings, c.id) }));
  const on = states.filter((c) => c.active === true);
  const loading = settings === null;
  // Lo que dice el botón de un vistazo: los canales activos (o «todos»), o que está apagado.
  const summary = loading ? (failed ? "Bot sin estado" : "Bot…") : on.length === 0 ? "Bot apagado" : on.length === states.length ? "Todos los canales" : on.map((c) => c.name).join(" · ");
  const spoken = loading ? summary : on.length === 0 ? "todos apagados" : on.length === states.length ? "todos activos" : `activos: ${on.map((c) => c.name).join(", ")}`;

  return (
    <>
      <div
        ref={box}
        className="relative"
        onBlur={(e) => {
          // Tab hacia fuera del panel lo cierra (no si el foco pasa a una ventana: confirmación u horario)
          if (open && !dialog && !e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget) setOpen(false);
        }}
      >
        <button
          ref={trigger}
          type="button"
          aria-haspopup="true"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label={`Canales del bot: ${spoken}`}
          title={loading ? summary : `Bot: ${spoken}`}
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft",
            loading && "border-border bg-secondary text-text-3",
            !loading && on.length > 0 && "border-success-soft bg-success-tint text-success-text hover:brightness-95",
            !loading && on.length === 0 && "border-danger-soft bg-danger-tint text-danger-text hover:brightness-95"
          )}
        >
          {!loading && on.length === 0 ? <BotOff className="h-4 w-4" aria-hidden /> : <Bot className="h-4 w-4" aria-hidden />}
          {/* en pantallas chicas: los iconos de los canales activos; en las grandes, sus nombres */}
          <span aria-hidden className="flex items-center gap-1 lg:hidden">
            {on.map(({ id, icon: ChannelIcon }) => (
              <ChannelIcon key={id} className="h-3.5 w-3.5" />
            ))}
          </span>
          <span aria-hidden className="hidden lg:inline">
            {summary}
          </span>
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden />
        </button>

        {open && (
          <div id={panelId} role="group" aria-label="Bot por canal" className="fixed inset-x-3 top-14 z-50 rounded-lg border bg-background p-1.5 shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-11 sm:w-[22rem]">
            <p className="px-2.5 pb-1 pt-1.5 text-xs text-text-3">El bot contesta solo por los canales encendidos. Cada uno se maneja a mano o por horario, por separado.</p>
            <ul className="flex flex-col gap-1">
              {states.map(({ id, icon: ChannelIcon, name, active, mode, schedule }) => {
                const { by, at } = changedBy(settings, id);
                const state = active === null ? (failed ? "sin estado" : "…") : active ? "activo" : "apagado";
                const timed = mode === "schedule";
                const who = by && at ? `Lo cambió ${by} el ${fmtDateTime(at)}` : `Interruptor del bot de ${name}`;
                return (
                  <li key={id} className="flex items-stretch gap-1">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={active ?? false}
                      aria-label={`Bot de ${name}`}
                      title={timed ? `${name}: ${state}. Por horario${schedule ? `: ${scheduleLabel(schedule)}` : ""}. Para usar el interruptor, cambia a Manual en «Horario».` : `${name}: ${state}. ${who}`}
                      data-channel={id}
                      disabled={active === null || busy === id || !permissions.toggleBot || timed}
                      onClick={() => (active ? setConfirming(id) : void apply(id, true))}
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-3 rounded-md border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft disabled:cursor-not-allowed disabled:opacity-60",
                        active === true && "border-success-soft bg-success-tint text-success-text hover:brightness-95",
                        active === false && "border-border bg-background text-foreground hover:bg-accent",
                        active === null && "border-border bg-secondary text-text-3"
                      )}
                    >
                      <ChannelIcon className="h-4 w-4 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold">{name}</span>
                        <span className="block text-xs font-medium">
                          {active === null ? (failed ? "Bot sin estado" : "Bot…") : active ? "Bot activo" : "Bot apagado"}
                          {timed && active !== null && " · por horario"}
                        </span>
                        <span className="block truncate text-[11px] font-normal opacity-80">{timed ? (schedule ? scheduleLabel(schedule) : "Sin horario definido") : who}</span>
                      </span>
                      <span aria-hidden className={cn("relative h-4 w-7 shrink-0 rounded-full transition-colors", active ? "bg-success" : "bg-text-4")}>
                        <span className={cn("absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all", active ? "left-3.5" : "left-0.5")} />
                      </span>
                    </button>
                    {permissions.toggleBot && (
                      <button
                        type="button"
                        aria-label={`Horario de ${name}`}
                        title={`Horario del bot de ${name}`}
                        disabled={active === null}
                        onClick={() => {
                          setScheduleError(null);
                          setScheduling(id);
                        }}
                        className={cn(
                          "flex w-10 shrink-0 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft disabled:cursor-not-allowed disabled:opacity-60",
                          timed ? "border-brand bg-brand-tint text-brand-text hover:brightness-95" : "bg-background text-text-3 hover:bg-accent hover:text-foreground"
                        )}
                      >
                        <Clock className="h-4 w-4" aria-hidden />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {scheduling && (
        <ScheduleDialog
          channel={scheduling}
          mode={modeOf(settings, scheduling)}
          schedule={scheduleOf(settings, scheduling)}
          busy={busy === scheduling}
          error={scheduleError}
          onSave={(change) => void saveSchedule(scheduling, change)}
          onClose={() => setScheduling(null)}
        />
      )}

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
