import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isApiError, type SessionInfo, type User } from "@clinica/api-client";
import { useApi } from "./api-context";
import { useConnection } from "./lib/connection";
import { isTransientError, messageFor } from "./lib/errors";
import { clearStoredData, readStoredSession, safeLocalStorage, writeStoredSession } from "./lib/storage";
import { releasePush } from "./pwa/push";

type AuthState =
  | { status: "loading" }
  | { status: "anonymous"; notice?: string }
  | { status: "error"; message: string }
  /** `verified: false`: la app se abrió SIN conexión con la sesión guardada; solo lectura hasta confirmarla con el servidor. */
  | { status: "authenticated"; user: User; verified: boolean };

type AuthContextValue = {
  state: AuthState;
  user: User | null;
  /** El servidor confirmó la sesión (y hay token CSRF): solo así se puede escribir. */
  verified: boolean;
  /** Entra con el código de 4 dígitos del doctor (el «usuario») y su contraseña. */
  login: (doctorCode: string, password: string) => Promise<void>;
  /** Establece la contraseña con el enlace que mandó la clínica (la primera vez, o una nueva si olvidó la suya) y deja la sesión abierta. */
  setPassword: (token: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

/** Cada cuánto se reintenta confirmar la sesión mientras la app sigue abierta sin conexión. */
export const VERIFY_MS = 10_000;

const EXPIRED = "Tu sesión terminó. Inicia sesión de nuevo.";

export function AuthProvider({ children, verifyMs = VERIFY_MS }: { children: ReactNode; verifyMs?: number }) {
  const api = useApi();
  const conn = useConnection();
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const storage = useMemo(safeLocalStorage, []);

  /** Solo se recuerda a un doctor: es lo único que esta app deja abrir sin conexión. */
  const remember = useCallback(
    (user: User) => {
      if (user.role === "doctor") writeStoredSession(storage, { user, savedAt: new Date().toISOString() });
    },
    [storage]
  );

  // Al abrir (y al reintentar) se pregunta quién soy: la cookie de sesión la manda el navegador.
  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    api.auth.me().then(
      (info) => {
        if (!alive) return;
        conn.reportSuccess();
        remember(info.user);
        setState({ status: "authenticated", user: info.user, verified: true });
      },
      (err) => {
        if (!alive) return;
        if (isApiError(err) && err.status === 401) {
          writeStoredSession(storage, null);
          setState({ status: "anonymous" });
          return;
        }
        if (isTransientError(err)) {
          conn.reportFailure(err);
          // Sin red al abrir: si este dispositivo ya conocía a un doctor, se abre en solo lectura con lo guardado.
          const stored = readStoredSession(storage);
          if (stored && stored.user.role === "doctor") {
            setState({ status: "authenticated", user: stored.user, verified: false });
            return;
          }
        }
        setState({ status: "error", message: messageFor(err) });
      }
    );
    return () => {
      alive = false;
    };
    // `conn` y `remember` son estables; solo debe repetirse al reintentar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, attempt]);

  // Abierta sin conexión: se intenta confirmar la sesión cada rato y en cuanto vuelve la red.
  const unverified = state.status === "authenticated" && !state.verified;
  useEffect(() => {
    if (!unverified) return;
    let alive = true;
    const verify = () => {
      api.auth.me().then(
        (info) => {
          if (!alive) return;
          conn.reportSuccess();
          remember(info.user);
          setState({ status: "authenticated", user: info.user, verified: true });
        },
        (err) => {
          if (!alive) return;
          if (isApiError(err) && err.status === 401) {
            writeStoredSession(storage, null);
            setState({ status: "anonymous", notice: EXPIRED });
          } else conn.reportFailure(err);
        }
      );
    };
    const timer = setInterval(() => document.visibilityState !== "hidden" && verify(), verifyMs);
    window.addEventListener("online", verify);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("online", verify);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unverified, api, verifyMs]);

  // Si en pleno uso el servidor responde 401, la sesión venció: de vuelta al login.
  useEffect(() => api.onUnauthenticated(() => setState({ status: "anonymous", notice: EXPIRED })), [api]);

  /** Una sesión nueva (por el login o por el enlace de contraseña): se guarda quién es y se entra. */
  const enter = useCallback(
    (info: SessionInfo) => {
      conn.reportSuccess();
      // Otro doctor en el mismo dispositivo: nada de lo del anterior se queda.
      clearStoredData(storage, { exceptUser: info.user.id });
      remember(info.user);
      setState({ status: "authenticated", user: info.user, verified: true });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storage, remember]
  );

  const login = useCallback(async (doctorCode: string, password: string) => enter(await api.auth.loginDoctor(doctorCode, password)), [api, enter]);

  const setPassword = useCallback(async (token: string, password: string) => enter(await api.auth.usePasswordLink(token, password)), [api, enter]);

  const logout = useCallback(async () => {
    // Que este dispositivo deje de recibir avisos de la agenda (con paciente) de quien sale.
    await releasePush(api);
    try {
      await api.auth.logout();
    } catch {
      /* si el servidor no contesta, igual se sale de la pantalla */
    }
    clearStoredData(storage);
    setState({ status: "anonymous" });
  }, [api, storage]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const user = state.status === "authenticated" ? state.user : null;
  const verified = state.status === "authenticated" && state.verified;
  const value = useMemo<AuthContextValue>(
    () => ({ state, user, verified, login, setPassword, logout, retry }),
    [state, user, verified, login, setPassword, logout, retry]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth fuera de <AuthProvider>");
  return v;
}

/** El usuario de la sesión (solo dentro de las pantallas que exigen sesión). */
export function useUser(): User {
  const { user } = useAuth();
  if (!user) throw new Error("useUser sin sesión");
  return user;
}
