import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  document.body.style.overflow = "";
  // Lo guardado en el "dispositivo" (copias de lectura, sesión recordada) no debe pasar de una prueba a otra.
  try {
    window.localStorage.clear();
  } catch {
    /* sin almacenamiento */
  }
  // `setBrowserOnline` define `navigator.onLine` en la instancia: se quita para volver al valor del navegador.
  delete (window.navigator as { onLine?: boolean }).onLine;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
