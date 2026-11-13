import { useCallback, useRef, useState } from "react";
import { AlertTriangle, Bot, CalendarOff, Check, Copy, MessageSquareWarning } from "lucide-react";
import { Button, channelLabel, cn } from "@clinica/calendar";
import { isAbortError, type AttentionItem, type Channel } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { messageFor } from "../../lib/errors";
import { fmtDateTime, fmtPhone } from "../../lib/fmt";
import { usePolling } from "../../lib/use-polling";
import { useToast } from "../../toast";
import { BusyButton, PageMessage, Pill, Spinner } from "../../ui/controls";
import { PAGE_SIZE, Pager, pageCountOf } from "../../ui/pager";

const KIND = {
  event_failed: { label: "Mensaje que el bot no pudo atender", icon: MessageSquareWarning, tone: "danger" as const },
  handoff: { label: "El bot pasó la conversación a una persona", icon: Bot, tone: "warn" as const },
  absence_affects_appointments: { label: "Ausencia de doctor con citas agendadas", icon: CalendarOff, tone: "warn" as const },
};

/** Los motivos con los que el bot pasa un caso (`reason` de /api/bot/handoffs), en español. */
const REASON: Record<string, string> = {
  modelo_fallo: "El modelo de lenguaje falló",
  accion_invalida: "El bot intentó una acción inválida",
  pidio_persona: "El paciente pidió hablar con una persona",
  fuera_de_alcance: "La pregunta está fuera de lo que el bot atiende",
  otro: "Otro motivo",
};

/** Los canales del filtro, en orden. */
const CHANNEL_FILTER: readonly Channel[] = ["whatsapp", "facebook", "instagram"];

function Case({ item, onResolve, busy }: { item: AttentionItem; onResolve?: () => void; busy: boolean }) {
  const kind = KIND[item.kind];
  const Icon = kind.icon;
  const channel: Channel = item.channel ?? "whatsapp";
  const [copied, setCopied] = useState(false);
  const [copiedConv, setCopiedConv] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.phone ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* el número queda visible para copiarlo a mano */
    }
  };
  const copyConversation = async () => {
    try {
      await navigator.clipboard.writeText(item.conversationId ?? "");
      setCopiedConv(true);
      setTimeout(() => setCopiedConv(false), 2000);
    } catch {
      /* el id queda visible para copiarlo a mano */
    }
  };
  return (
    <li className={cn("flex flex-col gap-2 rounded-xl border bg-background p-4", item.status === "resolved" && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("flex h-7 w-7 items-center justify-center rounded-full", kind.tone === "danger" ? "bg-danger-tint text-danger-text" : "bg-warning-tint text-warning-text")}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <span className="text-sm font-bold">{kind.label}</span>
        {item.kind !== "absence_affects_appointments" && (
          <Pill tone={channel === "whatsapp" ? "neutral" : "brand"}>
            <span className="sr-only">Canal: </span>
            {channelLabel(channel)}
          </Pill>
        )}
        <span className="ml-auto text-xs text-text-3">{fmtDateTime(item.createdAtUtc)}</span>
      </div>
      <p className="text-sm">{REASON[item.reason] ?? item.reason}</p>
      {item.detail && <p className="text-sm text-text-2">{item.detail}</p>}
      <div className="flex flex-wrap items-center gap-3">
        {item.phone && (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium">
            {fmtPhone(item.phone)}
            <button
              type="button"
              onClick={() => void copy()}
              aria-label={`Copiar el teléfono ${fmtPhone(item.phone)}`}
              className="flex h-7 w-7 items-center justify-center rounded text-text-3 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
            </button>
          </span>
        )}
        {/* Messenger e Instagram no dan telefono: se contesta desde el inbox de Zernio, buscando la conversacion */}
        {!item.phone && channel !== "whatsapp" && item.kind !== "absence_affects_appointments" && (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium">
            Contestar desde el inbox de Zernio
            {item.conversationId && (
              <button
                type="button"
                onClick={() => void copyConversation()}
                aria-label={`Copiar el id de la conversación ${item.conversationId}`}
                className="flex h-7 w-7 items-center justify-center rounded text-text-3 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft"
              >
                {copiedConv ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
              </button>
            )}
          </span>
        )}
        {item.conversationId && <span className="font-mono text-[11px] text-text-4">{item.conversationId}</span>}
        {onResolve ? (
          <BusyButton busy={busy} size="sm" className="ml-auto" onClick={onResolve}>
            <Check className="h-4 w-4" aria-hidden />
            Marcar como atendido
          </BusyButton>
        ) : (
          <Pill tone="ok">Atendido</Pill>
        )}
      </div>
    </li>
  );
}

/**
 * Lo que el bot no pudo resolver y necesita a una persona. Se atiende desde Zernio; aquí solo se lleva la cuenta.
 * Los pendientes salen todos; los ATENDIDOS (que se acumulan sin fin) se piden al servidor DE 10 EN 10, de los más recientes a
 * los más antiguos: solo viaja la página que se está viendo (`limit`/`offset`) y el total para pintar la paginación.
 */
export function AttentionPage() {
  const api = useApi();
  const toast = useToast();
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [channel, setChannel] = useState<Channel | null>(null);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [total, setTotal] = useState(0);
  /** De qué estado y página son `items` (al pasar de página se siguen viendo los de antes hasta que llegan los nuevos). */
  const [loadedKey, setLoadedKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const key = `${status}:${page}:${channel ?? "todos"}`;
  const goToPage = (p: number) => {
    setPage(p);
    listRef.current?.scrollIntoView?.({ block: "start" });
  };

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        if (status === "open") {
          const all = await api.attention.list("open", { signal, channel: channel ?? undefined });
          setItems(all);
          setTotal(all.length);
        } else {
          const offset = (page - 1) * PAGE_SIZE;
          const res = await api.attention.page("resolved", { limit: PAGE_SIZE, offset, channel: channel ?? undefined }, { signal });
          // Un servidor que todavía no se actualizó (versión anterior: sin reiniciar) ignora `limit`/`offset` y no manda `total`:
          // se sigue viendo bien, con la lista completa y la paginación hecha aquí, en vez de «Página 1 de NaN».
          const total = Number.isInteger(res.total) ? res.total : res.items.length;
          const rows = res.items.length > PAGE_SIZE ? res.items.slice(offset, offset + PAGE_SIZE) : res.items;
          // Si la lista se achicó mientras se miraba (esta página ya no existe), se pasa a la última que sí.
          if (rows.length === 0 && total > 0 && page > 1) {
            setPage(pageCountOf(total));
            return;
          }
          setItems(rows);
          setTotal(total);
        }
        setLoadedKey(`${status}:${page}:${channel ?? "todos"}`);
        setError(null);
      } catch (e) {
        if (!isAbortError(e)) setError(messageFor(e));
      }
    },
    [api, status, page, channel]
  );
  usePolling(load, 15_000, true, key);

  const resolve = async (item: AttentionItem) => {
    setBusyId(item.id);
    try {
      await api.attention.resolve(item.id);
      toast.show("Caso marcado como atendido.");
      await load();
    } catch (e) {
      toast.show(messageFor(e), "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight">Atención</h1>
        <div role="group" aria-label="Estado" className="ml-auto inline-flex rounded-full border bg-secondary p-0.5">
          {(["open", "resolved"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
              onClick={() => {
                setItems(null);
                setPage(1);
                setStatus(s);
              }}
              className={cn(
                "h-7 rounded-full px-3 text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft",
                status === s ? "bg-background text-foreground shadow-sm" : "text-text-3 hover:text-foreground"
              )}
            >
              {s === "open" ? "Pendientes" : "Atendidos"}
            </button>
          ))}
        </div>
      </header>

      <p className="text-sm text-text-3">Casos que el bot no pudo resolver solo. Contesta a cada paciente desde Zernio y márcalo aquí como atendido.</p>

      <div role="group" aria-label="Canal" className="flex flex-wrap items-center gap-1.5">
        {([null, ...CHANNEL_FILTER] as const).map((c) => (
          <button
            key={c ?? "todos"}
            type="button"
            aria-pressed={channel === c}
            onClick={() => {
              setItems(null);
              setPage(1);
              setChannel(c);
            }}
            className={cn(
              "h-7 rounded-full border px-3 text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft",
              channel === c ? "border-brand bg-brand-tint text-brand-text" : "bg-background text-text-3 hover:text-foreground"
            )}
          >
            {c === null ? "Todos los canales" : channelLabel(c)}
          </button>
        ))}
      </div>

      {error && !items && (
        <PageMessage title="No se pudieron cargar los casos" action={<Button onClick={() => void load()}>Reintentar</Button>}>
          {error}
        </PageMessage>
      )}
      {!items && !error && (
        <div className="flex justify-center py-10">
          <Spinner label="Cargando casos" />
        </div>
      )}
      {items && items.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-background px-6 py-12 text-center">
          <AlertTriangle className="h-6 w-6 text-text-4" aria-hidden />
          <p className="text-sm font-semibold">{status === "open" ? "No hay casos pendientes" : "Todavía no hay casos atendidos"}</p>
          {status === "open" && <p className="text-xs text-text-3">Cuando el bot necesite a una persona, aparecerá aquí.</p>}
        </div>
      )}
      {items && items.length > 0 && (
        <ul
          ref={listRef}
          aria-label={status === "open" ? "Casos pendientes" : "Casos atendidos"}
          aria-busy={loadedKey !== key || undefined}
          className={cn("flex scroll-mt-4 flex-col gap-3 transition-opacity", loadedKey !== key && "opacity-60")}
        >
          {items.map((it) => (
            <Case key={it.id} item={it} busy={busyId === it.id} onResolve={status === "open" ? () => void resolve(it) : undefined} />
          ))}
        </ul>
      )}
      {status === "resolved" && items && <Pager label="Paginación de casos atendidos" page={page} total={total} onPage={goToPage} />}
    </div>
  );
}
