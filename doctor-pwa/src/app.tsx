import { useEffect } from "react";
import type { ApiClient } from "@clinica/api-client";
import { Button } from "@clinica/calendar";
import { ApiProvider } from "./api-context";
import { AuthProvider, useAuth } from "./auth";
import { Shell } from "./layout/shell";
import { ConnectionProvider } from "./lib/connection";
import { AbsencesPage } from "./pages/absences/page";
import { AccountPage } from "./pages/account/page";
import { AgendaPage } from "./pages/agenda/page";
import { LoginPage, type DemoAccount } from "./pages/login";
import { SchedulePage } from "./pages/schedule/page";
import { ProfileProvider } from "./profile";
import { navigate, useRoute } from "./router";
import { ToastProvider } from "./toast";
import { PageMessage, Spinner } from "./ui/controls";

const ROUTES = ["/hoy", "/semana", "/ausencias", "/horario", "/cuenta"];

function Routes() {
  const route = useRoute();
  // "/" (o una ruta que no existe) va a Hoy.
  const known = ROUTES.includes(route.path);
  useEffect(() => {
    if (!known) navigate("/hoy", undefined, { replace: true });
  }, [known]);
  if (!known) return null;

  switch (route.path) {
    case "/semana":
      return <AgendaPage view="semana" />;
    case "/ausencias":
      return <AbsencesPage />;
    case "/horario":
      return <SchedulePage />;
    case "/cuenta":
      return <AccountPage />;
    default:
      return <AgendaPage view="hoy" />;
  }
}

function Gate({ demoAccounts }: { demoAccounts?: DemoAccount[] }) {
  const { state, retry, logout } = useAuth();

  if (state.status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner label="Cargando" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <PageMessage title="No se pudo conectar" action={<Button onClick={retry}>Reintentar</Button>}>
        {state.message}
        <span className="mt-1 block text-xs text-text-3">La primera vez que entras en este dispositivo se necesita conexión.</span>
      </PageMessage>
    );
  }
  if (state.status === "anonymous") return <LoginPage notice={state.notice} demoAccounts={demoAccounts} />;

  // Esta app es de los doctores: el personal y el administrador usan la web de administración.
  if (state.user.role !== "doctor") {
    return (
      <PageMessage
        title="Esta app es para los doctores"
        action={
          <Button variant="outline" onClick={() => void logout()}>
            Cerrar sesión
          </Button>
        }
      >
        Tu cuenta es del personal de la clínica: usa la web de administración para ver y manejar la agenda.
      </PageMessage>
    );
  }

  return (
    <ProfileProvider>
      <Shell>
        <Routes />
      </Shell>
    </ProfileProvider>
  );
}

/** La PWA del doctor. Recibe el cliente de la API ya armado (la real o la simulada). */
export function App({ api, demoAccounts }: { api: ApiClient; demoAccounts?: DemoAccount[] }) {
  return (
    <ApiProvider api={api}>
      <ToastProvider>
        <ConnectionProvider>
          <AuthProvider>
            <Gate demoAccounts={demoAccounts} />
          </AuthProvider>
        </ConnectionProvider>
      </ToastProvider>
    </ApiProvider>
  );
}
