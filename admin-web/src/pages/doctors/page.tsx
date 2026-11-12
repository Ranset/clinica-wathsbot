import { useCallback, useState } from "react";
import { Check, Clock, UserPlus, X } from "lucide-react";
import { Button, type WeeklyHours } from "@clinica/calendar";
import type { Booking, Doctor, ScheduleChangeRequest } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { useAuth } from "../../auth";
import { useDirectory } from "../../lib/directory";
import { messageFor } from "../../lib/errors";
import { fmtDateTime, fmtDay } from "../../lib/fmt";
import { compactHours, summarizeHours, validateHours } from "../../lib/hours";
import { useNow } from "../../lib/use-now";
import { usePolling } from "../../lib/use-polling";
import { useToast } from "../../toast";
import { BusyButton, FormError, Notice, PageMessage, Pill, Spinner, TextArea, Field } from "../../ui/controls";
import { Modal } from "../../ui/modal";
import { AffectedList } from "./affected-list";
import { DoctorDataForm, DoctorDialog } from "./doctor-dialog";
import { HoursEditor } from "./hours-editor";

/** Horario general de la clínica. Todos lo ven; lo cambian el administrador y el personal de recepción. */
function ClinicHoursCard({ hours, onSaved }: { hours: WeeklyHours; onSaved: () => void }) {
  const api = useApi();
  const toast = useToast();
  const { permissions } = useAuth();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<WeeklyHours>(hours);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = Object.keys(validateHours(draft)).length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.clinicHours.set(compactHours(draft));
      toast.show("Horario de la clínica guardado.");
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="clinic-hours-h" className="rounded-xl border bg-background p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Clock className="h-5 w-5 text-brand" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id="clinic-hours-h" className="text-sm font-bold">
            Horario de la clínica
          </h2>
          <p className="text-sm text-text-2">{summarizeHours(hours)}</p>
        </div>
        {permissions.editClinicHours && !editing && (
          <Button variant="outline" size="sm" onClick={() => { setDraft(structuredClone(hours)); setEditing(true); }}>
            Cambiar
          </Button>
        )}
      </div>
      {editing && (
        <div className="mt-4 flex flex-col gap-3">
          <HoursEditor value={draft} onChange={setDraft} />
          <Notice>Ningún doctor con horario propio puede quedar fuera del horario de la clínica; si pasa, el servidor lo rechaza.</Notice>
          <FormError>{error}</FormError>
          <div className="flex gap-2">
            <BusyButton busy={busy} disabled={invalid} onClick={() => void save()}>
              Guardar
            </BusyButton>
            <Button variant="outline" onClick={() => { setEditing(false); setError(null); }}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Solicitudes de cambio permanente de horario que mandan los doctores desde su app; las decide el personal. */
function ScheduleRequests({ doctors, onApplied }: { doctors: Doctor[]; onApplied: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [items, setItems] = useState<ScheduleChangeRequest[]>([]);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  // Citas que el horario aprobado dejo fuera: el servidor no las cancela, el personal avisa a los pacientes.
  const [affected, setAffected] = useState<Booking[]>([]);

  const load = useCallback(async (signal?: AbortSignal) => setItems(await api.scheduleChanges.list("pending", { signal })), [api]);
  usePolling(load, 20_000);

  const decide = async (r: ScheduleChangeRequest, approve: boolean) => {
    setBusyId(r.id);
    try {
      let left: Booking[] = [];
      if (approve) left = (await api.scheduleChanges.approve(r.id)).affectedAppointments;
      else await api.scheduleChanges.reject(r.id, note.trim() || undefined);
      setAffected(left);
      toast.show(
        approve
          ? left.length
            ? `Solicitud aprobada. ${left.length === 1 ? "1 cita quedó" : `${left.length} citas quedaron`} fuera del nuevo horario: avisa a los pacientes.`
            : "Solicitud aprobada: el nuevo horario ya está vigente."
          : "Solicitud rechazada.",
      );
      setRejecting(null);
      setNote("");
      await load();
      if (approve) onApplied();
    } catch (e) {
      toast.show(messageFor(e), "error");
    } finally {
      setBusyId(null);
    }
  };

  if (items.length === 0 && affected.length === 0) return null;
  return (
    <>
      <AffectedList items={affected} onDismiss={() => setAffected([])} />
      {items.length > 0 && (
        <section aria-labelledby="requests-h" className="rounded-xl border border-warning-soft bg-warning-tint p-4">
          <h2 id="requests-h" className="mb-3 text-sm font-bold text-warning-text">
            Solicitudes de cambio de horario ({items.length})
          </h2>
          <ul className="flex flex-col gap-3">
            {items.map((r) => {
              const doctor = doctors.find((d) => d.id === r.doctorId);
              return (
                <li key={r.id} className="rounded-lg border bg-background p-3">
                  <p className="text-sm font-semibold">{doctor?.name ?? "Doctor"}</p>
                  <p className="text-xs text-text-3">Pide el cambio desde el {fmtDay(r.effectiveFrom)} · enviada {fmtDateTime(r.createdAtUtc)}</p>
                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                    <dt className="text-text-3">Ahora</dt>
                    <dd>{doctor ? summarizeHours(doctor.weeklyHours) : "—"}</dd>
                    <dt className="text-text-3">Pide</dt>
                    <dd className="font-medium">{summarizeHours(r.weeklyHours)}</dd>
                    {r.note && (
                      <>
                        <dt className="text-text-3">Nota</dt>
                        <dd>{r.note}</dd>
                      </>
                    )}
                  </dl>
                  {rejecting === r.id ? (
                    <div className="mt-3 flex flex-col gap-2">
                      <Field label="Motivo (opcional)">
                        <TextArea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
                      </Field>
                      <div className="flex gap-2">
                        <BusyButton busy={busyId === r.id} variant="outline" onClick={() => void decide(r, false)}>
                          Confirmar rechazo
                        </BusyButton>
                        <Button variant="ghost" onClick={() => setRejecting(null)}>
                          Volver
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 flex gap-2">
                      <BusyButton busy={busyId === r.id} size="sm" onClick={() => void decide(r, true)}>
                        <Check className="h-4 w-4" aria-hidden />
                        Aprobar
                      </BusyButton>
                      <Button size="sm" variant="outline" onClick={() => setRejecting(r.id)}>
                        <X className="h-4 w-4" aria-hidden />
                        Rechazar
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}

export function DoctorsPage() {
  const { permissions } = useAuth();
  const { dir, error, reload } = useDirectory();
  const now = useNow(60_000);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  if (error && !dir) {
    return (
      <PageMessage title="No se pudieron cargar los doctores" action={<Button onClick={() => void reload()}>Reintentar</Button>}>
        {error}
      </PageMessage>
    );
  }
  if (!dir) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label="Cargando doctores" />
      </div>
    );
  }

  const open = dir.doctors.find((d) => d.id === openId) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight">Doctores</h1>
        {permissions.manageDoctors && (
          <Button size="sm" className="ml-auto" onClick={() => setCreating(true)}>
            <UserPlus className="h-4 w-4" aria-hidden />
            Nuevo doctor
          </Button>
        )}
      </header>

      <ScheduleRequests doctors={dir.doctors} onApplied={() => void reload()} />
      <ClinicHoursCard key={JSON.stringify(dir.clinicHours)} hours={dir.clinicHours} onSaved={() => void reload()} />

      <ul className="grid gap-3 sm:grid-cols-2" aria-label="Doctores">
        {dir.doctors.map((d) => (
          <li key={d.id} className="flex flex-col gap-2 rounded-xl border bg-background p-4">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-bold">{d.name}</p>
                <p className="text-sm text-text-2">{d.specialty}</p>
              </div>
              {!d.active && <Pill tone="danger">De baja</Pill>}
            </div>
            <p className="text-xs text-text-3">
              {d.usesClinicHours ? "Horario de la clínica" : "Horario propio"}: <span className="font-medium text-text-2">{summarizeHours(d.weeklyHours)}</span>
            </p>
            <div>
              <Button variant="outline" size="sm" onClick={() => setOpenId(d.id)} aria-label={`Horario y ausencias de ${d.name}`}>
                Horario y ausencias
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {open && <DoctorDialog doctor={open} doctors={dir.doctors} clinicHours={dir.clinicHours} now={now} onClose={() => setOpenId(null)} onChanged={() => void reload()} />}

      {creating && (
        <Modal title="Nuevo doctor" onClose={() => setCreating(false)}>
          <DoctorDataForm
            doctor={null}
            others={dir.doctors}
            onCancel={() => setCreating(false)}
            onSaved={(d) => {
              setCreating(false);
              void reload();
              setOpenId(d.id);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

