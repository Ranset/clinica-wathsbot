import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// `base: "./"`: los archivos se piden relativos al index.html, asi el mismo build
// sirve cuando Flask lo monte en "/" o en "/doctor/" (F8 decide). La navegacion
// usa "#/ruta", por lo que el servidor no necesita reglas de reescritura. Por lo
// mismo el manifiesto usa `start_url`/`scope` relativos ("./").
//
// Modos (ver .env.*): `npm run dev` usa la API SIMULADA; `npm run dev:real`
// manda /api a Flask en 127.0.0.1:5000; `npm run build` prepara el bundle real.
//
// Service worker: `injectManifest` con src/sw.ts (precache del shell + avisos push).
// En las pruebas (vitest) el plugin PWA no se carga.
const testing = !!process.env.VITEST;

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    !testing &&
      VitePWA({
        strategies: "injectManifest",
        srcDir: "src",
        filename: "sw.ts",
        // "prompt": el service worker nuevo espera a que el doctor toque «Actualizar»
        // (asi no se recarga la agenda a media consulta).
        registerType: "prompt",
        injectRegister: false,
        manifest: {
          id: "./",
          name: "Clínica CUBAMEX · Doctor",
          short_name: "Mi agenda",
          description: "Agenda del doctor de la Clínica CUBAMEX: citas, ausencias y horario.",
          lang: "es-MX",
          dir: "ltr",
          start_url: "./",
          scope: "./",
          display: "standalone",
          background_color: "#f6f8fa",
          theme_color: "#0f766e",
          categories: ["medical", "productivity"],
          icons: [
            { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            { src: "icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
        injectManifest: {
          globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest,woff2}"],
        },
        devOptions: { enabled: false },
      }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5181,
    // `changeOrigin: false` A PROPOSITO: el servidor rechaza (403, csrf) las escrituras cuyo `Origin` no coincide con el
    // `Host` que recibe. El atajo de cadena de Vite pone changeOrigin en true y reescribe el Host a :5000 (ver admin-web).
    proxy: { "/api": { target: "http://127.0.0.1:5000", changeOrigin: false } },
  },
  preview: { host: "127.0.0.1", port: 5181 },
  build: { outDir: "dist", emptyOutDir: true },
  // @ts-expect-error `test` lo lee vitest; vite no lo tipa
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    css: false,
    // Solo nuestras pruebas: no las de los otros paquetes del workspace.
    include: ["test/**/*.test.{ts,tsx}"],
    // `virtual:pwa-register` solo existe dentro del plugin PWA (que no se carga en pruebas).
    alias: { "virtual:pwa-register": fileURLToPath(new URL("./test/stubs/pwa-register.ts", import.meta.url)) },
  },
});
