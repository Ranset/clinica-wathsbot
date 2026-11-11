import { useCallback, useEffect, useState, type FormEvent } from "react";
import { KeyRound, UserPlus } from "lucide-react";
import { Button } from "@clinica/calendar";
import { isAbortError, type Doctor, type Role, type User } from "@clinica/api-client";
import { useApi } from "../../api-context";
import { useAuth } from "../../auth";
import { messageFor } from "../../lib/errors";
import { ROLE_LABEL } from "../../lib/fmt";
import { useToast } from "../../toast";
import { BusyButton, Checkbox, Field, FormError, PageMessage, Pill, Select, Spinner, TextInput } from "../../ui/controls";
import { Modal } from "../../ui/modal";

const ROLES: Role[] = ["staff", "admin", "doctor"];

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
  const [doctorId, setDoctorId] = useState(user?.doctorId ?? "");
  const [active, setActive] = useState(user?.active ?? true);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<{ name?: string; email?: string; password?: string; doctor?: string }>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs: typeof fe = {};
    if (!name.trim()) errs.name = "Escribe el nombre.";
    if (creating && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = "Escribe un correo válido.";
    if ((creating || password) && password.length < 10) errs.password = "La contraseña debe tener al menos 10 caracteres.";
    if (role === "doctor" && !doctorId) errs.doctor = "Elige a qué doctor corresponde este usuario.";
    setFe(errs);
    if (Object.keys(errs).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      const saved = creating
        ? await api.users.create({ email: email.trim(), name: name.trim(), role, password, ...(role === "doctor" ? { doctorId } : {}) })
        : await api.users.update(user.id, {
            name: name.trim(),
            ...(isSelf ? {} : { role, active }),
            ...(role === "doctor" ? { doctorId } : { doctorId: null }),
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
        <Field label="Correo" error={fe.email} hint={creating ? "Con este correo entra al sistema." : "El correo no se puede cambiar."}>
          <TextInput type="email" value={email} disabled={!creating} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Rol" hint={isSelf ? "No puedes cambiar tu propio rol." : undefined}>
          <Select value={role} disabled={isSelf} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        </Field>
        {role === "doctor" && (
          <Field label="Doctor" error={fe.doctor} hint="Verá solo la agenda de este doctor, en la app del doctor.">
            <Select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
              <option value="">Elige un doctor…</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.specialty}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field
          label={creating ? "Contraseña" : "Nueva contraseña (opcional)"}
          error={fe.password}
          hint={creating ? "Mínimo 10 caracteres. Compártela con la persona por un medio privado." : "Déjala vacía para no cambiarla. Mínimo 10 caracteres."}
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

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight">Usuarios</h1>
        <Button size="sm" className="ml-auto" onClick={() => setEditing("new")}>
          <UserPlus className="h-4 w-4" aria-hidden />
          Nuevo usuario
        </Button>
      </header>

      <ul aria-label="Usuarios" className="divide-y overflow-hidden rounded-xl border bg-background">
        {users.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
            <div className="min-w-0 flex-1 basis-56">
              <p className="truncate text-sm font-semibold">
                {u.name}
                {u.id === me.id && <span className="ml-2 text-xs font-medium text-text-3">(tú)</span>}
              </p>
              <p className="truncate text-xs text-text-3">{u.email}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={u.role === "admin" ? "brand" : "neutral"}>{ROLE_LABEL[u.role]}</Pill>
              {u.role === "doctor" && doctorName(u.doctorId) && <span className="text-xs text-text-2">{doctorName(u.doctorId)}</span>}
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
