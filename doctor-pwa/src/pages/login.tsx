import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { FlaskConical } from "lucide-react";
import type { LoginDoctor } from "@clinica/api-client";
import { useApi } from "../api-context";
import { useAuth } from "../auth";
import { BrandMark, useBrand } from "../brand";
import { messageFor } from "../lib/errors";
import { Combobox, type ComboOption } from "../ui/combobox";
import { BusyButton, Field, FormError, Notice, Spinner, TextInput } from "../ui/controls";

/** Una cuenta de ejemplo de la API simulada: `code` es el código de 4 dígitos del doctor. */
export type DemoAccount = { label: string; code: string; password: string };

/**
 * Pantalla de entrada: el doctor elige su código o nombre en una lista (que se reduce al escribir) y escribe su contraseña a mano.
 * No lleva correo. La lista sale de la API (`GET /api/auth/doctors`, pública): son los doctores que tienen una cuenta activa.
 * En modo simulado ofrece cuentas de ejemplo; en producción no hay nada de eso.
 */
export function LoginPage({ notice, demoAccounts }: { notice?: string; demoAccounts?: DemoAccount[] }) {
  const api = useApi();
  const { login } = useAuth();
  const { name } = useBrand();
  const [doctors, setDoctors] = useState<LoginDoctor[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [doctorCode, setDoctorCode] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  // La lista de doctores. Si falla (sin red), se avisa y se reintenta con el botón o en cuanto vuelve la conexión.
  useEffect(() => {
    let alive = true;
    setLoadError(null);
    api.auth.loginDoctors().then(
      (list) => alive && setDoctors(list),
      (err) => alive && setLoadError(messageFor(err))
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);
  useEffect(() => {
    if (!loadError) return;
    const retry = () => setAttempt((n) => n + 1);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [loadError]);

  const options = useMemo<ComboOption[]>(() => (doctors ?? []).map((d) => ({ value: d.code, lead: d.code, label: d.name })), [doctors]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!doctorCode) {
      setPickError("Elige tu código o tu nombre en la lista.");
      return;
    }
    setBusy(true);
    try {
      await login(doctorCode, password);
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
    }
  };

  const noDoctors = doctors !== null && doctors.length === 0;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-subtle px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <BrandMark className="h-36 w-36 rounded-2xl" />
          <h1 className="text-xl font-bold tracking-tight">{name}</h1>
          <p className="text-sm text-text-3">Mi agenda · Doctores</p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4 rounded-xl border bg-background p-5 shadow-sm" aria-label="Iniciar sesión">
          {notice && <Notice tone="warn">{notice}</Notice>}

          <Combobox
            label="Usuario"
            options={options}
            value={doctorCode}
            onChange={(code) => {
              setDoctorCode(code);
              if (code) setPickError(null);
            }}
            onPick={() => passwordRef.current?.focus()}
            placeholder="Código o nombre"
            disabled={doctors === null}
            emptyText={(typed) => `Ningún doctor coincide con «${typed}».`}
            error={pickError}
            hint={doctors === null && !loadError ? undefined : "Escribe tu código de 4 dígitos o tu nombre."}
          />
          {doctors === null && !loadError && (
            <p className="-mt-2 flex items-center gap-2 text-xs text-text-3">
              <Spinner label="Cargando la lista de doctores" />
              Cargando la lista de doctores…
            </p>
          )}
          {loadError && (
            <Notice tone="warn" className="-mt-1 flex flex-col gap-2">
              <span>No se pudo cargar la lista de doctores. {loadError}</span>
              <button
                type="button"
                onClick={() => setAttempt((n) => n + 1)}
                className="self-start font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft"
              >
                Reintentar
              </button>
            </Notice>
          )}
          {noDoctors && <Notice tone="warn">Todavía no hay doctores con acceso. Pide a la clínica que cree tu cuenta.</Notice>}

          <Field label="Contraseña">
            <TextInput ref={passwordRef} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <FormError>{error}</FormError>
          <BusyButton type="submit" busy={busy} disabled={doctors === null} className="w-full">
            Entrar
          </BusyButton>
        </form>

        {demoAccounts && demoAccounts.length > 0 && (
          <div className="mt-4 rounded-xl border border-dashed border-border-strong bg-background/60 p-4">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text-2">
              <FlaskConical className="h-3.5 w-3.5" aria-hidden />
              Modo de demostración (API simulada): llena el formulario con
            </p>
            <div className="flex flex-wrap gap-2">
              {demoAccounts.map((a) => (
                <button
                  key={a.code}
                  type="button"
                  disabled={doctors === null}
                  onClick={() => {
                    setDoctorCode(a.code);
                    setPassword(a.password);
                    setPickError(null);
                    setError(null);
                  }}
                  className="rounded-full border bg-background px-3 py-1 text-xs font-semibold hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft disabled:opacity-50"
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
