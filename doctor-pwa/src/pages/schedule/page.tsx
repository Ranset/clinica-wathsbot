import { useMemo, useState, type FormEvent } from "react";
import { CalendarClock, Clock, Trash2 } from "lucide-react";
import { Button, WEEKDAYS, addDaysISO, hhmmLabel, isIsoDate, todayInTz, type WeeklyHours } from "@clinica/calendar";
import { isApiError, type ScheduleChangeRequest } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { SyncStatus } from "../../layout/status";
import { useCanWrite } from "../../lib/can-write";
import { isConflict, messageFor } from "../../lib/errors";
import { TZ, fmtDateTime, fmtDay } from "../../lib/fmt";
import { DAY_NAME, compactHours, sameHours, summarizeHours, validateHours } from "../../lib/hours";
import { useNow } from "../../lib/use-now";
import { useResource } from "../../lib/use-resource";
import { useProfile } from "../../profile";
import { useToast } from "../../toast";
import { BusyButton, Field, FormError, Notice, PageMessage, Pill, Spinner, TextArea, TextInput, dangerButton } from "../../ui/controls";
import { Modal } from "../../ui/modal";
import { HoursEditor } from "./hours-editor";

const STATUS: Record<ScheduleChangeRequest["status"], { label: string; tone: "warn" | "ok" | "danger" }> = {
  pending: { label: "Pendiente", tone: "warn" },
  approved: { label: "Aprobada", tone: "ok" },
  rejected: { label: "Rechazada", tone: "danger" },
};

/** Mi horario semanal vigente: un renglón por día. */
function CurrentHours({ hours }: { hours: WeeklyHours }) {
  return (
    <ul className="divide-y rounded-lg border bg-background" aria-label="Mi horario semanal">
      {WEEKDAYS.map((d) => {
        const ivs = hours[d] ?? [];
        return (
          <li key={d} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
            <span className="font-semibold">{DAY_NAME[d]}</span>
            <span className={ivs.length ? "tabular-nums" : "text-text-3"}>{ivs.length ? ivs.map((i) => `${hhmmLabel(i.start)} – ${hhmmLabel(i.end)}`).join(", ") : "No atiendo"}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Mi horario semanal (el vigente, solo lectura) y mis solicitudes de cambio PERMANENTE de horario: las
 * crea el doctor y las aprueba el personal. Para faltar un día suelto se usa «Ausencias». Sin conexión se ve
 * lo último guardado y no se puede pedir un cambio.
 */
export function SchedulePage() {
  const api = useApi();
  const toast = useToast();
  const { canWrite, reason, reportFailure } = useCanWrite();
  const { doctor, error: profileError, confirmed, syncedAt, reload: reloadProfile } = useProfile();
  const now = useNow(60_000);
  const today = todayInTz(now, TZ);

  const requests = useResource<ScheduleChangeRequest[]>("schedule-requests", (signal) => api.doctorSelf.scheduleChanges.list({ signal }), { intervalMs: 30_000 });
  const clinic = useResource<WeeklyHours>("clinic-hours", (signal) => api.clinicHours.get({ signal }), { intervalMs: 300_000 });

  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState<WeeklyHours>({});
  const [from, setFrom] = useState(addDaysISO(today, 1));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Eliminar una solicitud pendiente (con confirmación, como «Quitar ausencia»)
  const [removing, setRemoving] = useState<ScheduleChangeRequest | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const start = () => {
    setHours(doctor ? structuredClone(doctor.weeklyHours) : {});
    setFrom(addDaysISO(today, 1));
    setNote("");
    setError(null);
    setOpen(true);
  };

  const problems = useMemo(() => validateHours(hours, clinic.data ?? undefined), [hours, clinic.data]);
  const hasPending = (requests.data ?? []).some((r) => r.status === "pending");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !canWrite || !doctor) return;
    const weeklyHours = compactHours(hours);
    if (Object.keys(problems).length > 0) return setError("Revisa los horarios marcados en rojo.");
    if (Object.keys(weeklyHours).length === 0) return setError("Elige al menos un día en que atiendas. Para no atender unos días, registra una ausencia.");
    if (sameHours(weeklyHours, doctor.weeklyHours)) return setError("Ese es el horario que ya tienes: haz algún cambio.");
    if (!isIsoDate(from) || from <= today) return setError("La fecha de inicio debe ser futura.");

    setBusy(true);
    setError(null);
    try {
      const created = await api.doctorSelf.scheduleChanges.create({ weeklyHours, effectiveFrom: from, ...(note.trim() ? { note: note.trim() } : {}) });
      setOpen(false);
      toast.show("Solicitud enviada: el personal la revisará.");
      requests.apply((list) => [created, ...(list ?? [])]); // sale ya en «Pendiente»; la copia del servidor llega enseguida
      await requests.reload();
    } catch (err) {
      reportFailure(err);
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Elimina una solicitud MIA que sigue pendiente. Si el personal ya la aprobó o rechazó (409) o ya no existe (404), no se
   * puede: se dice por qué y se recarga la lista para que se vea su estado real.
   */
  const confirmRemove = async () => {
    if (!removing || removeBusy || !canWrite) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await api.doctorSelf.scheduleChanges.remove(removing.id);
      setRemoving(null);
      toast.show("Solicitud eliminada: el personal ya no la verá.");
      requests.apply((list) => (list ?? []).filter((r) => r.id !== removing.id));
      await requests.reload();
    } catch (err) {
      reportFailure(err);
      if (isConflict(err)) setRemoveError("El personal ya resolvió esta solicitud, así que ya no se puede eliminar. Se actualizó la lista.");
      else if (isApiError(err) && err.status === 404) setRemoveError("Esa solicitud ya no existe. Se actualizó la lista.");
      else setRemoveError(messageFor(err));
      if (isConflict(err) || (isApiError(err) && err.status === 404)) await requests.reload();
    } finally {
      setRemoveBusy(false);
    }
  };

  if (!doctor) {
    return profileError ? (
      <PageMessage title="No se pudo cargar tu horario" action={<Button onClick={() => void reloadProfile()}>Reintentar</Button>}>
        {profileError}
      </PageMessage>
    ) : (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label="Cargando tu horario" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-4 sm:py-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-bold tracking-tight">Mi horario</h1>
        <SyncStatus syncedAt={syncedAt} stale={!confirmed || profileError !== null} />
      </div>

      <section aria-label="Horario vigente" className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-text-3" aria-hidden />
          <div>
            <h2 className="text-sm font-bold">Horario vigente</h2>
            <p className="text-xs text-text-3">
              {doctor.usesClinicHours ? "Usas el horario general de la clínica." : "Tienes un horario propio."} {summarizeHours(doctor.weeklyHours)}
            </p>
          </div>
        </div>
        <CurrentHours hours={doctor.weeklyHours} />
      </section>

      <section aria-label="Solicitar un cambio" className="flex flex-col gap-2 rounded-lg border bg-background p-4">
        <h2 className="text-sm font-bold">Cambiar mi horario de forma permanente</h2>
        <p className="text-xs text-text-3">
          La solicitud la revisa el personal de la clínica. Por ahora el cambio entra en vigor en cuanto la aprueban. Para faltar un día o unos días, usa{" "}
          <a className="font-semibold text-brand-text underline" href="#/ausencias">
            Ausencias
          </a>
          .
        </p>
        {hasPending && <Notice tone="warn">Ya tienes una solicitud pendiente. Puedes enviar otra, pero el personal verá las dos; si te equivocaste, elimina la pendiente en «Mis solicitudes».</Notice>}
        {reason && <Notice tone="warn">{reason}</Notice>}
        <div>
          <Button onClick={start} disabled={!canWrite}>
            <CalendarClock className="h-4 w-4" aria-hidden />
            Solicitar cambio de horario
          </Button>
        </div>
      </section>

      <section aria-label="Mis solicitudes" className="flex flex-col gap-2">
        <h2 className="text-sm font-bold">Mis solicitudes</h2>
        {requests.data === null && !requests.error && <Spinner label="Cargando solicitudes" />}
        {requests.error && <FormError>{requests.data ? `${requests.error} Se muestra la última copia guardada.` : requests.error}</FormError>}
        {requests.data && requests.data.length === 0 && <p className="rounded-md border border-dashed px-3 py-3 text-sm text-text-3">Todavía no has pedido cambios de horario.</p>}
        <ul className="flex flex-col gap-2">
          {[...(requests.data ?? [])].sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc)).map((r) => (
            <li key={r.id} className="flex flex-col gap-1.5 rounded-lg border bg-background px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Pill tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Pill>
                <span className="flex items-center gap-1 text-xs text-text-3">
                  Enviada {fmtDateTime(r.createdAtUtc)}
                  {/* solo una PENDIENTE se puede eliminar: una aprobada o rechazada es historial */}
                  {r.status === "pending" && (
                    <button
                      type="button"
                      disabled={!canWrite}
                      title={reason ?? "Eliminar esta solicitud"}
                      onClick={() => {
                        setRemoveError(null);
                        setRemoving(r);
                      }}
                      aria-label={`Eliminar la solicitud enviada ${fmtDateTime(r.createdAtUtc)}`}
                      className="-my-1 -mr-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-3 hover:bg-accent hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  )}
                </span>
              </div>
              <p className="text-sm">{summarizeHours(r.weeklyHours)}</p>
              <p className="text-xs text-text-3">
                Inicio pedido: {fmtDay(r.effectiveFrom)}
                {r.decidedAtUtc ? ` · Resuelta ${fmtDateTime(r.decidedAtUtc)}` : ""}
              </p>
              {r.note && <p className="text-xs text-text-2">Nota: {r.note}</p>}
            </li>
          ))}
        </ul>
      </section>

      {removing && (
        <Modal
          title="¿Eliminar esta solicitud?"
          onClose={() => setRemoving(null)}
          initialFocus="panel"
          footer={
            <>
              <Button variant="outline" onClick={() => setRemoving(null)}>
                Cancelar
              </Button>
              <BusyButton className={dangerButton} busy={removeBusy} disabled={!canWrite} onClick={() => void confirmRemove()}>
                Eliminar solicitud
              </BusyButton>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-sm">
            <p>
              <span className="font-semibold">{summarizeHours(removing.weeklyHours)}</span>
              <span className="block text-xs text-text-3">
                Enviada {fmtDateTime(removing.createdAtUtc)} · Inicio pedido: {fmtDay(removing.effectiveFrom)}
              </span>
            </p>
            <p className="text-text-2">El personal ya no la verá y no se aplicará ningún cambio. Si quieres, puedes enviar otra cuando quieras.</p>
            <FormError>{removeError}</FormError>
            {reason && <Notice tone="warn">{reason}</Notice>}
          </div>
        </Modal>
      )}

      {open && (
        <Modal
          title="Solicitar cambio de horario"
          description="El personal de la clínica lo revisa y lo aprueba o rechaza."
          size="lg"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <BusyButton type="submit" form="schedule-request-form" busy={busy} disabled={!canWrite}>
                Enviar solicitud
              </BusyButton>
            </>
          }
        >
          <form id="schedule-request-form" onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label="Solicitud de cambio de horario">
            <HoursEditor value={hours} onChange={setHours} limit={clinic.data ?? undefined} />
            <Field label="Quiero que empiece el" hint="Una fecha futura. Por ahora el cambio se aplica al aprobarse.">
              <TextInput type="date" value={from} min={addDaysISO(today, 1)} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Nota para el personal (opcional)">
              <TextArea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Motivo del cambio, qué días prefieres…" />
            </Field>
            <FormError>{error}</FormError>
            {reason && <Notice tone="warn">{reason}</Notice>}
          </form>
        </Modal>
      )}
    </div>
  );
}
