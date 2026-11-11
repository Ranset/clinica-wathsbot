/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `mock`: API simulada en memoria. `real`: la API del mismo origen. */
  readonly VITE_API_MODE?: "mock" | "real";
}

interface Window {
  /** Solo en modo mock: controles del simulador para probar a mano (ver README). */
  __clinicaMock?: import("@clinica/api-client/mock").MockApi;
}
