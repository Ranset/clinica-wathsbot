import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Demo local del calendario. La libreria se consume por `src/index.ts`
// desde la app del doctor (PWA) y desde la pagina de administracion (Flask).
export default defineConfig({
  root: "demo",
  plugins: [react()],
  build: { outDir: "../dist-demo", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5199 },
});
