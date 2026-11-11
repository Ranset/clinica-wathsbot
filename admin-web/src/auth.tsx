import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isApiError, type User } from "@clinica/api-client";
import { useApi } from "./api-context";
import { messageFor } from "./lib/errors";
import { permissionsFor, type Permissions } from "./permissions";

type AuthState =
  | { status: "loading" }
  | { status: "anonymous"; notice?: string }
  | { status: "error"; message: string }
  | { status: "authenticated"; user: User };

type AuthContextValue = {
  state: AuthState;
  user: User | null;
  permissions: Permissions;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // Al abrir (y al reintentar) se pregunta quién soy: la cookie de sesión la manda el navegador.
  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    api.auth.me().then(
      (info) => alive && setState({ status: "authenticated", user: info.user }),
      (err) => {
        if (!alive) return;
        if (isApiError(err) && err.status === 401) setState({ status: "anonymous" });
        else setState({ status: "error", message: messageFor(err) });
      }
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  // Si en pleno uso el servidor responde 401, la sesión venció: de vuelta al login.
  useEffect(
    () => api.onUnauthenticated(() => setState({ status: "anonymous", notice: "Tu sesión terminó. Inicia sesión de nuevo." })),
    [api]
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const info = await api.auth.login(email, password);
      setState({ status: "authenticated", user: info.user });
    },
    [api]
  );

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* si el servidor no contesta, igual se sale de la pantalla */
    }
    setState({ status: "anonymous" });
  }, [api]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const user = state.status === "authenticated" ? state.user : null;
  const value = useMemo<AuthContextValue>(
    () => ({ state, user, permissions: permissionsFor(user?.role), login, logout, retry }),
    [state, user, login, logout, retry]
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
