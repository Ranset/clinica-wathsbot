#!/usr/bin/env python3
"""Chat de PRUEBA en la terminal: tu eres el paciente y contesta el bot de verdad (mismo codigo que en produccion).

Usa el modelo del propio bot (el CLI `claude` con tu suscripcion; NO hace falta ANTHROPIC_API_KEY) y la API de la
clinica para todo lo demas: interruptor del bot, doctores y horarios, disponibilidad y citas. No usa WhatsApp ni Zernio
(nada se envia a nadie): la conversacion vive solo aqui.

  1. Arranca el servidor local:      npm run dev:local           (desde la raiz del repositorio)
  2. Enciende el boton "Bot" en la web de administracion (http://127.0.0.1:5180) o el bot no contestara.
  3. En otra terminal:               python bot/dev_chat.py

Comandos dentro del chat:  /nuevo (conversacion nueva)   /tel 5299... (cambia el telefono del paciente: prueba que otro
paciente no ve tus citas)   /salir

Variables opcionales: CLINICA_API_URL (http://127.0.0.1:5000), CLINICA_BOT_TOKEN (token-de-desarrollo),
WATHSBOT_MODEL (sonnet), CLAUDE_BIN (se busca solo). Argumentos: --phone, --once "texto" (un solo mensaje).
OJO: las citas que agendes aqui son REALES en la base a la que apunte CLINICA_API_URL.
"""
import argparse
import glob
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def find_claude():
    """Ruta del CLI `claude`. En Windows evita el atajo .cmd de npm (pasa por cmd.exe, que no es seguro con texto
    de pacientes) y usa el ejecutable nativo que trae el paquete."""
    env = os.environ.get("CLAUDE_BIN")
    if env:
        return env
    found = shutil.which("claude")
    if found and not found.lower().endswith((".cmd", ".bat", ".ps1")):
        return found
    bases = []
    if found:
        bases.append(os.path.dirname(found))
    if os.environ.get("APPDATA"):
        bases.append(os.path.join(os.environ["APPDATA"], "npm"))
    for b in bases:
        for pat in ("node_modules/@anthropic-ai/claude-code/bin/claude.exe", "node_modules/@anthropic-ai/claude-code/bin/claude"):
            hits = glob.glob(os.path.join(b, pat))
            if hits:
                return hits[0]
    return found  # puede ser None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--phone", default="529981112233", help="telefono del paciente de prueba (solo digitos)")
    ap.add_argument("--once", metavar="TEXTO", help="enviar un solo mensaje y salir")
    args = ap.parse_args()

    os.environ.setdefault("WATHSBOT_BACKEND", "api")
    if os.environ["WATHSBOT_BACKEND"] != "api":
        sys.exit("dev_chat.py solo trabaja con WATHSBOT_BACKEND=api")
    os.environ.setdefault("CLINICA_API_URL", "http://127.0.0.1:5000")
    os.environ.setdefault("CLINICA_BOT_TOKEN", "token-de-desarrollo")
    os.environ.setdefault("ZERNIO_API_KEY", "no-se-usa-en-el-chat-local")
    os.environ["WATHSBOT_DRY_RUN"] = "1"  # nada sale hacia Zernio
    if os.environ.get("WATHSBOT_LLM", "cli") == "cli":
        claude = find_claude()
        if not claude:
            sys.exit("No encuentro el CLI `claude`. Instala Claude Code o define CLAUDE_BIN con su ruta.")
        os.environ["CLAUDE_BIN"] = claude

    import server  # despues de fijar el entorno

    phone = "".join(ch for ch in args.phone if ch.isdigit())
    conv = "chat-local-" + str(int(time.time()))
    msgs = []
    print(f"API: {os.environ['CLINICA_API_URL']}   paciente de prueba: {phone}")
    print(server.startup_report())
    if not args.once:
        print("Escribe como si fueras el paciente. /nuevo  /tel NUMERO  /salir\n")

    def turno(texto):
        nonlocal msgs
        msgs.append({"role": "user", "content": texto})
        t0 = time.time()
        reply = server.reply_for(msgs, phone, conv, first=len(msgs) == 1)
        seg = time.time() - t0
        if reply is None:
            print(f"\n[el bot esta APAGADO: no contesta; atenderia una persona]  ({seg:.0f}s)")
            print("Para encenderlo: boton \"Bot\" de la web de administracion (http://127.0.0.1:5180).\n")
            return
        msgs.append({"role": "assistant", "content": reply})
        print(f"\nBot> {reply}\n   ({seg:.0f}s)\n")

    if args.once:
        turno(args.once)
        return
    while True:
        try:
            linea = input("Paciente> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not linea:
            continue
        if linea in ("/salir", "/exit", "/q"):
            return
        if linea == "/nuevo":
            msgs, conv = [], "chat-local-" + str(int(time.time()))
            print("(conversacion nueva)\n")
            continue
        if linea.startswith("/tel"):
            digitos = "".join(ch for ch in linea[4:] if ch.isdigit())
            if len(digitos) < 10:
                print("Uso: /tel 529981112233 (solo digitos, con lada)\n")
                continue
            phone, msgs, conv = digitos, [], "chat-local-" + str(int(time.time()))
            print(f"(ahora eres el paciente {phone}; conversacion nueva)\n")
            continue
        turno(linea)


if __name__ == "__main__":
    main()
