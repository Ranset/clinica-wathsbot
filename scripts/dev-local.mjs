#!/usr/bin/env node
/**
 * `npm run dev:local` — levanta TODO en tu maquina para probar la aplicacion antes de desplegar:
 *   servidor Flask   http://127.0.0.1:5000   (base de desarrollo server/instance/dev.db)
 *   web de administracion  http://127.0.0.1:5180
 *   PWA del doctor         http://127.0.0.1:5181
 * Las dos webs mandan /api al servidor (`dev:real`). Ctrl+C detiene los tres. Si no existe la base de desarrollo, la crea con
 * datos de ejemplo (usuarios, doctores, citas). Solo para desarrollo: nada de esto es la configuracion de produccion.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const python = join(root, "server", ".venv", win ? "Scripts/python.exe" : "bin/python");
const devDb = join(root, "server", "instance", "dev.db");

if (!existsSync(python)) {
  console.error(
    `No encuentro el entorno de Python del servidor (${python}).\nCrealo una sola vez:\n` +
      `  cd server\n  python -m venv .venv\n  ${win ? ".venv\\Scripts\\python" : ".venv/bin/python"} -m pip install -r requirements-dev.txt`,
  );
  process.exit(1);
}
if (!existsSync(join(root, "node_modules"))) {
  console.error("Faltan las dependencias de Node. Corre una sola vez, en la raiz del repo:\n  npm install");
  process.exit(1);
}
if (!existsSync(devDb)) {
  console.log("No hay base de desarrollo: la creo ahora con datos de ejemplo...\n");
  const r = spawnSync(python, [join(root, "server", "scripts", "dev_seed.py")], { cwd: join(root, "server"), stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const services = [
  { name: "servidor", color: 36, cmd: python, args: [join(root, "server", "scripts", "dev_server.py")], shell: false, cwd: join(root, "server") },
  { name: "admin   ", color: 32, cmd: "npm", args: ["run", "dev:real", "-w", "admin-web"], shell: true, cwd: root },
  { name: "doctor  ", color: 35, cmd: "npm", args: ["run", "dev:real", "-w", "doctor-pwa"], shell: true, cwd: root },
];

const children = [];
let stopping = false;

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log("\nDeteniendo servidor y webs...");
  for (const c of children) {
    if (c.exitCode !== null) continue;
    if (win) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });   // npm deja procesos hijos vivos
    else c.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 500);
}

for (const s of services) {
  const child = spawn(s.cmd, s.args, { cwd: s.cwd, shell: s.shell, env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const tag = `\x1b[${s.color}m[${s.name}]\x1b[0m`;
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) console.log(`${tag} ${line}`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => {
    if (stopping) return;
    console.error(`${tag} termino inesperadamente (codigo ${code}). Detengo todo.`);
    stopAll(code || 1);
  });
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

setTimeout(() => {
  if (stopping) return;
  console.log(`
==================================================================
  Listo. Abre en el navegador:
    Web de administracion  http://127.0.0.1:5180   (entra como admin@dev.test o recepcion@dev.test)
    PWA del doctor         http://127.0.0.1:5181   (elige el codigo 1001, 1002 o 1003 en la lista)
    Contrasena de todos: clave-de-desarrollo-1
  Ctrl+C detiene todo.   Guia: docs/desarrollo-local.md
  Ojo: las dos webs comparten la sesion (mismo 127.0.0.1): cierra sesion en una antes de entrar a la otra con otro usuario.
==================================================================`);
}, 4000);
