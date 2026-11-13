import { useEffect } from "react";
import type { ApiClient } from "@clinica/api-client";
import { Button } from "@clinica/calendar";
import { ApiProvider } from "./api-context";
import { AuthProvider, useAuth } from "./auth";
import { BrandProvider } from "./brand";
import { Shell } from "./layout/shell";
import { canOpen } from "./permissions";
import { AttentionPage } from "./pages/attention/page";
import { ClinicPage } from "./pages/clinic/page";
import { CalendarPage } from "./pages/calendar/page";
import { DoctorsPage } from "./pages/doctors/page";
import { LoginPage, type DemoAccount } from "./pages/login";
import { UsersPage } from "./pages/users/page";
import { navigate, useRoute } from "./router";
import { ToastProvider } from "./toast";
import { PageMessage, Spinner } from "./ui/controls";

function Routes() {
  const { user, logout } = useAuth();
  const route = useRoute();

  // "/" (o una ruta que no existe) va al calendario.
  const known = ["/calendario", "/doctores", "/atencion", "/usuarios", "/clinica"].includes(route.path);
  useEffect(() => {
    if (!known) navigate("/calendario", undefined, { replace: true });
  }, [known]);
  if (!known) return null;

  if (!canOpen(user?.role, route.path)) {
    return (
      <PageMessage
        title="Esta sección no está disponible para tu rol"
        action={
          <Button onClick={() => navigate("/calendario")}>
            Ir al calendario
          </Button>
        }
      >
        Pídele al administrador técnico que haga este cambio, o que te dé el acceso.
        <button type="button" className="sr-only" onClick={() => void logout()}>
          Cerrar sesión
        </button>
      </PageMessage>
    );
  }

  switch (route.path) {
    case "/doctores":
      return <DoctorsPage />;
    case "/atencion":
      return <AttentionPage />;
    case "/usuarios":
      return <UsersPage />;
    case "/clinica":
      return <ClinicPage />;
    default:
      return <CalendarPage />;
  }
}

function Gate({ demoAccounts }: { demoAccounts?: DemoAccount[] }) {
  const { state, permissions, retry, logout } = useAuth();

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
      </PageMessage>
    );
  }
  if (state.status === "anonymous") return <LoginPage notice={state.notice} demoAccounts={demoAccounts} />;

  if (!permissions.useAdminWeb) {
    return (
      <PageMessage
        title="Esta página es para el personal de la clínica"
        action={
          <Button variant="outline" onClick={() => void logout()}>
            Cerrar sesión
          </Button>
        }
      >
        Tu cuenta es de doctor: usa la aplicación del doctor para ver tu agenda.
      </PageMessage>
    );
  }
  return (
    <Shell>
      <Routes />
    </Shell>
  );
}

/** La web de administración. Recibe el cliente de la API ya armado (la real o la simulada). */
export function App({ api, demoAccounts }: { api: ApiClient; demoAccounts?: DemoAccount[] }) {
  return (
    <ApiProvider api={api}>
      <ToastProvider>
        <BrandProvider>
          <AuthProvider>
            <Gate demoAccounts={demoAccounts} />
          </AuthProvider>
        </BrandProvider>
      </ToastProvider>
    </ApiProvider>
  );
}
