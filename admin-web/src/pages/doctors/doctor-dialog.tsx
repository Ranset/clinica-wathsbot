import { useState, type FormEvent } from "react";
import { Button, cn, colorOf, doctorColor, type WeeklyHours } from "@clinica/calendar";
import type { Booking, Doctor } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { useAuth } from "../../auth";
import { messageFor } from "../../lib/errors";
import { compactHours, summarizeHours, validateHours } from "../../lib/hours";
import { useToast } from "../../toast";
import { BusyButton, Checkbox, Field, FormError, Notice, TextInput, dangerButton } from "../../ui/controls";
import { Modal } from "../../ui/modal";
import { AbsencesTab } from "./absences-tab";
import { AffectedList } from "./affected-list";
import { ColorField } from "./color-field";
import { HoursEditor } from "./hours-editor";

type Tab = "horario" | "ausencias" | "datos";

/** Horario semanal propio (o el de la clínica) de UN doctor. */
function ScheduleTab({ doctor, clinicHours, onSaved }: { doctor: Doctor; clinicHours: WeeklyHours; onSaved: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [own, setOwn] = useState(!doctor.usesClinicHours);
  const [hours, setHours] = useState<WeeklyHours>(structuredClone(doctor.weeklyHours));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [affected, setAffected] = useState<Booking[]>([]);

  const problems = own ? validateHours(hours, clinicHours) : {};
  const hasProblems = Object.keys(problems).length > 0;
  const empty = own && Object.keys(compactHours(hours)).length === 0;

  const save = async () => {
    if (busy || hasProblems || empty) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.doctors.setWeeklyHours(doctor.id, own ? compactHours(hours) : null);
      setAffected(res.affectedAppointments);
      setHours(structuredClone(res.doctor.weeklyHours));
      toast.show(own ? `Horario de ${doctor.name} guardado.` : `${doctor.name} vuelve al horario de la clínica.`);
      onSaved();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <AffectedList items={affected} onDismiss={() => setAffected([])} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-bold">¿Qué horario tiene?</legend>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="radio" name="hours-mode" checked={!own} onChange={() => setOwn(false)} className="mt-1 accent-[var(--accent)]" />
          <span>
            <span className="font-semibold">El horario de la clínica</span>
            <span className="block text-xs text-text-3">{summarizeHours(clinicHours)}</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="radio" name="hours-mode" checked={own} onChange={() => setOwn(true)} className="mt-1 accent-[var(--accent)]" />
          <span>
            <span className="font-semibold">Un horario propio</span>
            <span className="block text-xs text-text-3">Debe quedar dentro del horario de la clínica.</span>
          </span>
        </label>
      </fieldset>

      {own && <HoursEditor value={hours} onChange={setHours} limit={clinicHours} />}
      {empty && <Notice tone="warn">Marca al menos un día de atención, o usa el horario de la clínica.</Notice>}
      <Notice>
        Las citas que ya estén agendadas fuera del nuevo horario <strong>no se cancelan</strong>: al guardar te mostramos cuáles son para que avises a los pacientes.
      </Notice>
      <FormError>{error}</FormError>
      <div>
        <BusyButton busy={busy} disabled={hasProblems || empty} onClick={() => void save()}>
          Guardar horario
        </BusyButton>
      </div>
    </div>
  );
}

function splitAliases(text: string): string[] {
  return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/** Nombre, especialidad, sinónimos (para que el bot reconozca la especialidad) y baja. Administrador y personal de recepción. */
export function DoctorDataForm({
  doctor,
  others = [],
  onSaved,
  onCancel,
}: {
  doctor: Doctor | null;
  /** Los demás doctores: para avisar si el color elegido ya lo usa alguno. */
  others?: Doctor[];
  onSaved: (d: Doctor) => void;
  onCancel?: () => void;
}) {
  const api = useApi();
  const toast = useToast();
  const [name, setName] = useState(doctor?.name ?? "");
  const [specialty, setSpecialty] = useState(doctor?.specialty ?? "");
  const [aliases, setAliases] = useState(doctor?.aliases.join(", ") ?? "");
  const [active, setActive] = useState(doctor?.active ?? true);
  const [color, setColor] = useState<string | null>(doctor?.color ?? null);
  const autoColor = doctor ? doctorColor(doctor.id) : null;
  const shownColor = color ?? autoColor;
  const usedBy = shownColor ? (others.find((o) => o.id !== doctor?.id && colorOf(o) === shownColor)?.name ?? null) : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim() || !specialty.trim()) return setError("El nombre y la especialidad son obligatorios.");
    setBusy(true);
    setError(null);
    try {
      const input = { name: name.trim(), specialty: specialty.trim(), aliases: splitAliases(aliases), active, color };
      const saved = doctor ? await api.doctors.update(doctor.id, input) : await api.doctors.create(input);
      toast.show(doctor ? "Datos del doctor guardados." : `${saved.name} se dio de alta.`);
      onSaved(saved);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      // al editar el diálogo sigue abierto: el botón vuelve a quedar libre para otro cambio
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate aria-label="Datos del doctor" className="flex flex-col gap-3.5">
      <Field label="Nombre">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Dr. Nombre Apellido" />
      </Field>
      <Field label="Especialidad">
        <TextInput value={specialty} onChange={(e) => setSpecialty(e.target.value)} />
      </Field>
      <Field label="Sinónimos" hint="Separados por comas. Así el bot entiende «proctólogo», «usg»… además del nombre de la especialidad.">
        <TextInput value={aliases} onChange={(e) => setAliases(e.target.value)} />
      </Field>
      <ColorField value={color} onChange={setColor} autoColor={autoColor} usedBy={usedBy} />
      <Checkbox label="Activo" hint="Si se desmarca, el doctor deja de ofrecerse. Sus citas anteriores se conservan." checked={active} onChange={(e) => setActive(e.target.checked)} />
      <FormError>{error}</FormError>
      <div className="flex gap-2">
        <BusyButton type="submit" busy={busy}>
          {doctor ? "Guardar datos" : "Dar de alta"}
        </BusyButton>
        {onCancel && (
          <Button variant="outline" onClick={onCancel}>
            Cancelar
          </Button>
        )}
      </div>
    </form>
  );
}

/**
 * Eliminar un doctor DE VERDAD. Solo el administrador, y el servidor solo lo permite si nunca tuvo citas ni cuenta de
 * usuario (409 con el motivo); lo normal es darlo de baja con «Activo». Pide confirmación porque no se puede deshacer.
 */
function DeleteDoctor({ doctor, onDeleted }: { doctor: Doctor; onDeleted: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.doctors.remove(doctor.id);
      toast.show(`${doctor.name} se eliminó.`);
      onDeleted();
    } catch (e) {
      setError(messageFor(e));
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="delete-doctor-h" className="rounded-lg border border-danger-soft p-4">
      <h3 id="delete-doctor-h" className="text-sm font-bold text-danger-text">
        Eliminar doctor
      </h3>
      <p className="mt-1 text-sm text-text-2">
        Solo sirve si se dio de alta por error: se borra para siempre, con su horario y sus ausencias. Si ya tuvo citas o tiene una cuenta de usuario no se
        puede; en ese caso desmarca «Activo» arriba para darlo de baja.
      </p>
      {!asking ? (
        <Button variant="outline" className="mt-3" onClick={() => setAsking(true)}>
          Eliminar doctor…
        </Button>
      ) : (
        <div role="group" aria-label="Confirmar eliminación" className="mt-3 flex flex-col gap-3">
          <p className="text-sm font-semibold">¿Eliminar definitivamente a {doctor.name}? No se puede deshacer.</p>
          <FormError>{error}</FormError>
          <div className="flex gap-2">
            <BusyButton busy={busy} className={dangerButton} onClick={() => void remove()}>
              Sí, eliminar
            </BusyButton>
            <Button variant="outline" disabled={busy} onClick={() => { setAsking(false); setError(null); }}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

export function DoctorDialog({
  doctor,
  doctors = [],
  clinicHours,
  now,
  onClose,
  onChanged,
}: {
  doctor: Doctor;
  /** Todos los doctores (para avisar si el color elegido ya lo usa otro). */
  doctors?: Doctor[];
  clinicHours: WeeklyHours;
  now: Date;
  onClose: () => void;
  /** Cambió algo del doctor o de su horario: que la lista se recargue. */
  onChanged: () => void;
}) {
  const { permissions } = useAuth();
  const [tab, setTab] = useState<Tab>("horario");
  const tabs: { id: Tab; label: string }[] = [
    { id: "horario", label: "Horario" },
    { id: "ausencias", label: "Ausencias" },
    ...(permissions.manageDoctors ? [{ id: "datos" as const, label: "Datos" }] : []),
  ];

  return (
    <Modal title={doctor.name} description={doctor.specialty} size="lg" onClose={onClose}>
      <div role="tablist" aria-label="Secciones del doctor" className="mb-4 flex gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft",
              tab === t.id ? "border-brand text-brand-text" : "border-transparent text-text-3 hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === "horario" && <ScheduleTab key={doctor.id} doctor={doctor} clinicHours={clinicHours} onSaved={onChanged} />}
        {tab === "ausencias" && <AbsencesTab doctor={doctor} now={now} />}
        {tab === "datos" && (
          <div className="flex flex-col gap-6">
            <DoctorDataForm doctor={doctor} others={doctors} onSaved={onChanged} />
            {permissions.deleteDoctors && <DeleteDoctor doctor={doctor} onDeleted={() => { onChanged(); onClose(); }} />}
          </div>
        )}
      </div>
    </Modal>
  );
}
