#!/bin/bash
# Enciende Wathsbot: servicio + tunel temporal nuevo + webhook de Zernio actualizado y activo.
# Ejecutar con terminal(background=true) o: bash start.sh (queda en primer plano; Ctrl+C no apaga el webhook, usa stop.sh).
cd /data/profiles/wathsbot/workspace/wathsbot
API=https://zernio.com/api/v1
WID=6ae2d24ceb3bbdc69caa54bd
PORT=8791

./run.sh >> server.log 2>&1 &
echo $! > server.pid

: > tunnel.log
/data/tools/bin/cloudflared tunnel --no-autoupdate --url http://localhost:$PORT >> tunnel.log 2>&1 &
echo $! > tunnel.pid

for i in $(seq 30); do
  URL=$(grep -o "https://[a-z0-9-]*\.trycloudflare\.com" tunnel.log | head -1)
  [ -n "$URL" ] && break; sleep 1
done
[ -z "$URL" ] && { echo "No se obtuvo URL del tunel"; exit 1; }
sleep 2

# Verifica que el tunel apunta a ESTE servicio (no a otro)
curl -s -m10 "$URL/health" | grep -q '"status":"ok"' || { echo "Tunel no responde"; exit 1; }
[ "$(curl -s -m10 -o /dev/null -w '%{http_code}' -X POST -d '{}' "$URL/webhooks/zernio")" = "401" ] || { echo "El tunel no apunta a Wathsbot"; exit 1; }

curl -s -X PUT -H "Authorization: Bearer $ZERNIO_API_KEY" -H "Content-Type: application/json" \
  "$API/webhooks/settings" -d "{\"_id\":\"$WID\",\"url\":\"$URL/webhooks/zernio\",\"isActive\":true,\"events\":[\"message.received\"]}" \
  | python3 -c "import sys,json;w=json.load(sys.stdin)['webhook'];print('webhook activo =',w['isActive'],w['url'])"
echo "Wathsbot encendido."
wait
