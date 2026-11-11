import { useState, type FormEvent } from "react";
import { FlaskConical } from "lucide-react";
import { useAuth } from "../auth";
import { messageFor } from "../lib/errors";
import { BusyButton, Field, FormError, Notice, TextInput } from "../ui/controls";

export type DemoAccount = { label: string; email: string; password: string };

/** Pantalla de entrada. En modo simulado ofrece cuentas de ejemplo; en producción no hay nada de eso. */
export function LoginPage({ notice, demoAccounts }: { notice?: string; demoAccounts?: DemoAccount[] }) {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-subtle px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-brand-fg">
            <svg viewBox="0 0 32 32" className="h-7 w-7" fill="currentColor">
              <path d="M14 7h4v7h7v4h-7v7h-4v-7H7v-4h7z" />
            </svg>
          </span>
          <h1 className="text-xl font-bold tracking-tight">Clínica CUBAMEX</h1>
          <p className="text-sm text-text-3">Mi agenda · Doctores</p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4 rounded-xl border bg-background p-5 shadow-sm" aria-label="Iniciar sesión">
          {notice && <Notice tone="warn">{notice}</Notice>}
          <Field label="Correo">
            <TextInput type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Contraseña">
            <TextInput type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <FormError>{error}</FormError>
          <BusyButton type="submit" busy={busy} className="w-full">
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
                  key={a.email}
                  type="button"
                  onClick={() => {
                    setEmail(a.email);
                    setPassword(a.password);
                    setError(null);
                  }}
                  className="rounded-full border bg-background px-3 py-1 text-xs font-semibold hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-soft"
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
