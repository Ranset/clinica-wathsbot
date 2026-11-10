#!/bin/bash
# Starts Wathsbot using the secret stored in the Zernio webhook (never printed).
cd /data/profiles/wathsbot/workspace/wathsbot
export WATHSBOT_PORT=8791
export WATHSBOT_WEBHOOK_SECRET=$(curl -s -H "Authorization: Bearer $ZERNIO_API_KEY" https://zernio.com/api/v1/webhooks/settings | python3 -c "import sys,json;print([w for w in json.load(sys.stdin)['webhooks'] if w['name'].startswith('WhatsApp auto-reply')][0]['secret'])")
exec /opt/venv/bin/python server.py
