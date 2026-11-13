import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient, type ApiClient } from "@clinica/api-client";
import "@clinica/calendar/src/styles.css";
import "./app.css";
import { App } from "./app";
import type { DemoAccount } from "./pages/login";
import { initInstallCapture } from "./pwa/install";
import { initPwa } from "./pwa/register";

async function boot() {
  let api: ApiClient;
  let demoAccounts: DemoAccount[] | undefined;

  if (import.meta.env.VITE_API_MODE === "mock") {
    // La API simulada se importa solo en este modo: el bundle de producción no la lleva.
    const { createMockApi, DEMO_ACCOUNTS } = await import("@clinica/api-client/mock");
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* almacenamiento bloqueado: la sesión simulada no sobrevive a recargar */
    }
    const mock = createMockApi({ latencyMs: 120, storage });
    window.__clinicaMock = mock;
    api = createApiClient({ fetch: mock.fetch });
    // Esta app es solo de doctores: se ofrecen las cuentas de doctor del simulador, con su código de 4 dígitos.
    demoAccounts = DEMO_ACCOUNTS.filter((a) => a.role === "doctor" && a.doctorCode).map((a) => ({ label: a.name, code: a.doctorCode!, password: a.password }));
  } else {
    api = createApiClient();
  }

  initInstallCapture();
  initPwa();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App api={api} demoAccounts={demoAccounts} />
    </StrictMode>
  );
}

void boot();
