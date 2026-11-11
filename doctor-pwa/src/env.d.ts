/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** `mock`: API simulada en memoria. `real`: la API del mismo origen. */
  readonly VITE_API_MODE?: "mock" | "real";
  /** Clave pública VAPID del servidor (base64url), para suscribir los avisos push. */
  readonly VITE_VAPID_PUBLIC_KEY?: string;
}

interface Window {
  /** Solo en modo mock: controles del simulador para probar a mano (ver README). */
  __clinicaMock?: import("@clinica/api-client/mock").MockApi;
}
