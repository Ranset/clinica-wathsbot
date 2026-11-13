import { useCallback, useEffect, useState, type FormEvent } from "react";
import { isApiError, type PasswordLinkInfo } from "@clinica/api-client";
import { Button } from "@clinica/calendar";
import { useApi } from "../api-context";
import { useAuth } from "../auth";
import { BrandMark, useBrand } from "../brand";
import { messageFor } from "../lib/errors";
import { navigate } from "../router";
import { BusyButton, Field, FormError, Spinner, TextInput } from "../ui/controls";

/** Largo mínimo de la contraseña (el mismo que exige el servidor). */
export const MIN_PASSWORD = 10;

type Phase =
  | { name: "checking" }
  | { name: "ready"; info: PasswordLinkInfo }
  /** El enlace no existe, ya venció o ya se usó (no se distingue cuál). */
  | { name: "invalid" }
  | { name: "error"; message: string };

/**
 * La página que abre el doctor con el enlace que le mandó la clínica (`#/contrasena?t=…`): ahí crea su contraseña por primera vez, o
 * pone una nueva si olvidó la suya. Se abre aunque no haya sesión. Al guardarla queda dentro y va a su agenda; el enlace se gasta.
 */
export function SetPasswordPage({ token }: { token: string | null }) {
  const api = useApi();
  const { setPassword: save } = useAuth();
  const { name } = useBrand();
  const [phase, setPhase] = useState<Phase>(token ? { name: "checking" } : { name: "invalid" });
  const [attempt, setAttempt] = useState(0);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [fieldError, setFieldError] = useState<{ password?: string; repeat?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // De quién es el enlace (para decirle «Hola, Dr. X · tu código es 1001» antes de pedirle nada).
  useEffect(() => {
    if (!token) {
      setPhase({ name: "invalid" });
      return;
    }
    let alive = true;
    setPhase({ name: "checking" });
    api.auth.checkPasswordLink(token).then(
      (info) => alive && setPhase({ name: "ready", info }),
      (err) => {
        if (!alive) return;
        // 404 = el enlace ya no sirve; cualquier otra cosa (sin red, servidor caído) es pasajera y se puede reintentar
        setPhase(isApiError(err) && err.status === 404 ? { name: "invalid" } : { name: "error", message: messageFor(err) });
      }
    );
    return () => {
      alive = false;
    };
  }, [api, token, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || phase.name !== "ready" || !token) return;
    const errs: typeof fieldError = {};
    if (password.length < MIN_PASSWORD) errs.password = `Escribe una contraseña de al menos ${MIN_PASSWORD} caracteres.`;
    if (repeat !== password) errs.repeat = "Las contraseñas no coinciden.";
    setFieldError(errs);
    setError(null);
    if (errs.password || errs.repeat) return;
    setBusy(true);
    try {
      await save(token, password);
      navigate("/hoy", undefined, { replace: true }); // el enlace ya no vale: fuera de la dirección
    } catch (err) {
      if (isApiError(err) && err.status === 404) setPhase({ name: "invalid" }); // lo usaron o venció mientras escribía
      else setError(messageFor(err));
      setBusy(false);
    }
  };

  const toLogin = () => navigate("/hoy", undefined, { replace: true });

  return (
    <div className="flex min-h-dvh items-center justify-center bg-subtle px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <BrandMark className="h-36 w-36 rounded-2xl" />
          <h1 className="text-xl font-bold tracking-tight">{name}</h1>
          <p className="text-sm text-text-3">Mi agenda · Doctores</p>
        </div>

        {phase.name === "checking" && (
          <div className="flex items-center justify-center gap-2 rounded-xl border bg-background p-5 text-sm text-text-2 shadow-sm">
            <Spinner label="Comprobando el enlace" />
            Comprobando el enlace…
          </div>
        )}

        {phase.name === "error" && (
          <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border bg-background p-5 shadow-sm">
            <h2 className="text-base font-bold">No se pudo comprobar el enlace</h2>
            <p className="text-sm text-text-2">{phase.message}</p>
            <Button onClick={retry}>Reintentar</Button>
          </div>
        )}

        {phase.name === "invalid" && (
          <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border bg-background p-5 shadow-sm">
            <h2 className="text-base font-bold">Este enlace ya no sirve</h2>
            <p className="text-sm text-text-2">
              Puede haber vencido (duran 3 días), ya se usó, o la clínica generó uno nuevo. Pídele a la clínica que te mande otro enlace.
            </p>
            <p className="text-sm text-text-2">Si ya tienes tu contraseña, entra con tu código.</p>
            <Button variant="outline" onClick={toLogin}>
              Ir al inicio
            </Button>
          </div>
        )}

        {phase.name === "ready" && (
          <form onSubmit={submit} noValidate aria-label="Crear contraseña" className="flex flex-col gap-4 rounded-xl border bg-background p-5 shadow-sm">
            <div>
              <h2 className="text-base font-bold">Crea tu contraseña</h2>
              <p className="mt-1 text-sm text-text-2">
                Hola, <strong>{phase.info.doctorName}</strong>. Con ella y tu código entrarás a tu agenda.
              </p>
            </div>
            <Field label="Usuario (tu código)">
              <TextInput value={phase.info.doctorCode} readOnly autoComplete="username" className="bg-subtle font-mono font-bold tabular-nums" />
            </Field>
            <Field label="Contraseña nueva" error={fieldError.password} hint={fieldError.password ? undefined : `Mínimo ${MIN_PASSWORD} caracteres.`}>
              <TextInput type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Repite la contraseña" error={fieldError.repeat}>
              <TextInput type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
            </Field>
            <FormError>{error}</FormError>
            <BusyButton type="submit" busy={busy} className="w-full">
              Guardar contraseña y entrar
            </BusyButton>
          </form>
        )}
      </div>
    </div>
  );
}
