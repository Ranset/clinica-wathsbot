import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base: "./"`: los archivos se piden relativos al index.html, asi el mismo build
// sirve cuando Flask lo monte en "/" o en "/admin/" (F8 decide). La navegacion
// usa "#/ruta", por lo que el servidor no necesita reglas de reescritura.
//
// Modos (ver .env.*): `npm run dev` usa la API SIMULADA; `npm run dev:real`
// manda /api a Flask en 127.0.0.1:5000; `npm run build` prepara el bundle real.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5180,
    proxy: { "/api": "http://127.0.0.1:5000" },
  },
  build: { outDir: "dist", emptyOutDir: true },
  // @ts-expect-error `test` lo lee vitest; vite no lo tipa
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    css: false,
    // Solo nuestras pruebas: no las de los otros paquetes del workspace.
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
