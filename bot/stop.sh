#!/bin/bash
# Apaga Wathsbot: desactiva el webhook en Zernio, cierra el servicio y el tunel.
# No borra nada: system_prompt.md, server.py y el webhook (inactivo) quedan listos.
API=https://zernio.com/api/v1
WID=6ae2d24ceb3bbdc69caa54bd

curl -s -X PUT -H "Authorization: Bearer $ZERNIO_API_KEY" -H "Content-Type: application/json" \
  "$API/webhooks/settings" -d "{\"_id\":\"$WID\",\"isActive\":false}" \
  | python3 -c "import sys,json;w=json.load(sys.stdin)['webhook'];print('webhook isActive =',w['isActive'])"

# Mata solo por PID guardado (evita matar otros procesos)
for f in /data/profiles/wathsbot/workspace/wathsbot/server.pid /data/profiles/wathsbot/workspace/wathsbot/tunnel.pid; do
  [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null && echo "detenido $(basename "$f" .pid)"
  rm -f "$f"
done
echo "Wathsbot apagado."
