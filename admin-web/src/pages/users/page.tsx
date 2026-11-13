import { useCallback, useEffect, useState, type FormEvent } from "react";
import { KeyRound, UserPlus } from "lucide-react";
import { Button, cn } from "@clinica/calendar";
import { isAbortError, type Doctor, type Role, type User } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { useAuth } from "../../auth";
import { messageFor } from "../../lib/errors";
import { ROLE_LABEL } from "../../lib/fmt";
import { useQueryState } from "../../router";
import { useToast } from "../../toast";
import { BusyButton, Checkbox, Field, FormError, PageMessage, Pill, Select, Spinner, TextInput } from "../../ui/controls";
import { Modal } from "../../ui/modal";

/** Los roles que se crean (y se cambian) aquí. La cuenta de un doctor nace con el doctor, en Doctores. */
const ROLES: Role[] = ["staff", "admin"];

/** Los filtros de la lista, en el orden en que se ven (el de «Todos» va primero). Nombres cortos y en plural: el rol completo ya sale en cada renglón. */
const ROLE_FILTERS: { role: Role; label: string }[] = [
  { role: "admin", label: "Administradores" },
  { role: "staff", label: "Personal" },
  { role: "doctor", label: "Doctores" },
];

/** El filtro que viene en la dirección (`#/usuarios?rol=doctor`); cualquier otro valor se toma como «Todos». */
export function roleFilterOf(value: string | null): Role | null {
  return ROLE_FILTERS.find((f) => f.role === value)?.role ?? null;
}

/** Los botones del filtro por rol («Todos» + uno por rol, cada uno con cuántos hay). Exactamente uno está activo. */
function RoleChips({ options, value, onChange }: { options: { value: Role | null; label: string; count: number }[]; value: Role | null; onChange: (v: Role | null) => void }) {
  return (
    <div role="group" aria-label="Filtrar por rol" className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value ?? "todos"}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft",
              on ? "border-brand bg-brand text-brand-fg" : "bg-background text-text-2 hover:bg-secondary hover:text-foreground"
            )}
          >
            {o.label}
            <span className={cn("text-xs font-medium tabular-nums", on ? "opacity-90" : "text-text-3")}>{o.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function UserForm({
  user,
  doctors,
  selfId,
  onSaved,
  onClose,
}: {
  user: User | null;
  doctors: Doctor[];
  selfId: string;
  onSaved: (u: User) => void;
  onClose: () => void;
}) {
  const api = useApi();
  const toast = useToast();
  const creating = user === null;
  const isSelf = user?.id === selfId;

  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "staff");
  const [active, setActive] = useState(user?.active ?? true);
  // La cuenta de un doctor (sin correo, ligada a su doctor) solo se edita aquí en lo básico: su rol y su doctor no cambian.
  const isDoctorAccount = user?.role === "doctor";
  const accountDoctor = isDoctorAccount ? doctors.find((d) => d.id === user.doctorId) : undefined;
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<{ name?: string; email?: string; password?: string }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs: typeof fe = {};
    if (!name.trim()) errs.name = "Escribe el nombre.";
    if (creating && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = "Escribe un correo válido.";
    if ((creating || password) && password.length < 10) errs.password = "La contraseña debe tener al menos 10 caracteres.";
    setFe(errs);
    if (Object.keys(errs).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      const saved = creating
        ? await api.users.create({ email: email.trim(), name: name.trim(), role: role as "admin" | "staff", password })
        : await api.users.update(user.id, {
            name: name.trim(),
            ...(isSelf ? {} : { active }),
            ...(isSelf || isDoctorAccount ? {} : { role }),
            ...(password ? { password } : {}),
          });
      toast.show(creating ? `Usuario ${saved.name} creado.` : "Usuario guardado.");
      onSaved(saved);
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
    }
  };

  const id = "user-form";
  return (
    <Modal
      title={creating ? "Nuevo usuario" : `Editar a ${user.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <BusyButton type="submit" form={id} busy={busy}>
            {creating ? "Crear usuario" : "Guardar"}
          </BusyButton>
        </>
      }
    >
      <form id={id} onSubmit={submit} noValidate className="flex flex-col gap-3.5">
        <Field label="Nombre" error={fe.name}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <Field
          label="Correo"
          error={fe.email}
          hint={isDoctorAccount ? "Los doctores no usan correo: entran con su código." : creating ? "Con este correo entra al sistema." : "El correo no se puede cambiar."}
        >
          <TextInput type="email" value={email} disabled={!creating} placeholder={isDoctorAccount ? "Sin correo" : undefined} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </Field>
        <Field
          label="Rol"
          hint={isDoctorAccount ? "La cuenta de un doctor se crea sola al darlo de alta y se maneja desde Doctores." : isSelf ? "No puedes cambiar tu propio rol." : creating ? "Los doctores no se crean aquí: su cuenta nace al darlos de alta en Doctores." : undefined}
        >
          <Select value={role} disabled={isSelf || isDoctorAccount} onChange={(e) => setRole(e.target.value as Role)}>
            {(isDoctorAccount ? (["doctor"] as Role[]) : ROLES).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        </Field>
        {isDoctorAccount && (
          <Field label="Doctor" hint="Entra a la app del doctor eligiendo su código y nombre, con su contraseña. Para que la cree (o ponga otra), genera su enlace en Doctores, pestaña «Datos».">
            <TextInput value={accountDoctor ? `${accountDoctor.code} · ${accountDoctor.name} · ${accountDoctor.specialty}` : ""} readOnly disabled />
          </Field>
        )}
        <Field
          label={creating ? "Contraseña" : "Nueva contraseña (opcional)"}
          error={fe.password}
          hint={
            creating
              ? "Mínimo 10 caracteres. Compártela con la persona por un medio privado."
              : isDoctorAccount
                ? "Déjala vacía para no cambiarla. Lo normal es que el doctor la cree con su enlace; aquí puedes fijarla a mano."
                : "Déjala vacía para no cambiarla. Mínimo 10 caracteres."
          }
        >
          <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        {!creating && (
          <Checkbox
            label="Activo"
            hint={isSelf ? "No puedes quitarte el acceso a ti mismo." : "Si se desmarca, la persona ya no puede entrar y su sesión se cierra."}
            checked={active}
            disabled={isSelf}
            onChange={(e) => setActive(e.target.checked)}
          />
        )}
        <FormError>{error}</FormError>
      </form>
    </Modal>
  );
}

/** Usuarios del sistema. Solo el administrador técnico (el servidor responde 403 a los demás). */
export function UsersPage() {
  const api = useApi();
  const { user: me } = useAuth();
  const [users, setUsers] = useState<User[] | null>(null);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<User | "new" | null>(null);
  // Los filtros viajan en la dirección (`#/usuarios?rol=doctor&bajas=1`): se pueden compartir y sobreviven a recargar. Los usuarios sin acceso (dados de baja)
  // no salen por defecto, igual que los doctores inactivos; el check los muestra.
  const [query, setQuery] = useQueryState();
  const roleFilter = roleFilterOf(query.get("rol"));
  const showInactive = query.get("bajas") === "1";

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [u, d] = await Promise.all([api.users.list({ signal }), api.doctors.list({ signal })]);
        setUsers(u);
        setDoctors(d);
        setError(null);
      } catch (e) {
        if (!isAbortError(e)) setError(messageFor(e));
      }
    },
    [api]
  );
  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  if (error && !users) {
    return (
      <PageMessage title="No se pudieron cargar los usuarios" action={<Button onClick={() => void load()}>Reintentar</Button>}>
        {error}
      </PageMessage>
    );
  }
  if (!users || !me) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner label="Cargando usuarios" />
      </div>
    );
  }

  const doctorName = (id: string | null) => doctors.find((d) => d.id === id)?.name ?? null;
  const doctorCode = (id: string | null) => doctors.find((d) => d.id === id)?.code ?? null;
  const matchesRole = (u: User) => !roleFilter || u.role === roleFilter;
  const visible = (u: User) => showInactive || u.active;
  const shown = users.filter((u) => matchesRole(u) && visible(u));
  // Las cuentas respetan el otro filtro: el número de un botón es lo que se vería al pulsarlo.
  const byVisibility = users.filter(visible);
  const roleOptions = [
    { value: null, label: "Todos", count: byVisibility.length },
    ...ROLE_FILTERS.map((f) => ({ value: f.role, label: f.label, count: byVisibility.filter((u) => u.role === f.role).length })),
  ];
  const inactiveCount = users.filter((u) => matchesRole(u) && !u.active).length;
  const emptyText = !roleFilter
    ? "Todavía no hay usuarios."
    : showInactive
      ? `No hay usuarios con el rol «${ROLE_LABEL[roleFilter]}».`
      : `No hay usuarios con acceso con el rol «${ROLE_LABEL[roleFilter]}».${inactiveCount > 0 ? " Marca «Mostrar usuarios sin acceso» para verlos." : ""}`;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight">Usuarios</h1>
        <Button size="sm" className="ml-auto" onClick={() => setEditing("new")}>
          <UserPlus className="h-4 w-4" aria-hidden />
          Nuevo usuario
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <RoleChips options={roleOptions} value={roleFilter} onChange={(rol) => setQuery({ rol })} />
        <Checkbox
          label={`Mostrar usuarios sin acceso (${inactiveCount})`}
          className="text-text-2 sm:ml-auto"
          checked={showInactive}
          onChange={(e) => setQuery({ bajas: e.target.checked ? "1" : null })}
        />
      </div>

      {shown.length === 0 && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-dashed p-4 text-sm text-text-3">
          {emptyText}
          {roleFilter && (
            <button type="button" onClick={() => setQuery({ rol: null })} className="font-semibold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft">
              Quitar filtro de rol
            </button>
          )}
        </p>
      )}

      <ul aria-label="Usuarios" className="divide-y overflow-hidden rounded-xl border bg-background empty:hidden">
        {shown.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
            <div className="min-w-0 flex-1 basis-56">
              <p className="truncate text-sm font-semibold">
                {u.name}
                {u.id === me.id && <span className="ml-2 text-xs font-medium text-text-3">(tú)</span>}
              </p>
              <p className="truncate text-xs text-text-3">{u.email ?? "Sin correo: entra con su código"}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={u.role === "admin" ? "brand" : "neutral"}>{ROLE_LABEL[u.role]}</Pill>
              {u.role === "doctor" && doctorName(u.doctorId) && (
                <span className="text-xs text-text-2">
                  {doctorName(u.doctorId)} · código <span className="font-mono font-semibold tabular-nums">{doctorCode(u.doctorId)}</span>
                </span>
              )}
              {!u.passwordSet && <Pill tone="warn">Sin contraseña</Pill>}
              {!u.active && <Pill tone="danger">Sin acceso</Pill>}
            </div>
            <Button variant="outline" size="sm" onClick={() => setEditing(u)} aria-label={`Editar a ${u.name}`}>
              <KeyRound className="h-3.5 w-3.5" aria-hidden />
              Editar
            </Button>
          </li>
        ))}
      </ul>

      {editing && (
        <UserForm
          user={editing === "new" ? null : editing}
          doctors={doctors}
          selfId={me.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
