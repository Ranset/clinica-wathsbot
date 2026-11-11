#!/usr/bin/env bash
# MySQL 8 desechable para las pruebas (Docker Desktop abierto). Idempotente.
#   scripts/mysql_test_db.sh up      arranca (o reutiliza) el contenedor y espera a que acepte conexiones
#   scripts/mysql_test_db.sh down    lo borra
#   scripts/mysql_test_db.sh url     imprime la URL para TEST_MYSQL_URL
# Luego:  TEST_MYSQL_URL="$(scripts/mysql_test_db.sh url)" .venv/Scripts/python -m pytest tests -q
# Puerto 33307 en el host (no choca con un MySQL local). utf8mb4 como en produccion.
set -euo pipefail
NAME=clinica-mysql-test
PORT=${TEST_MYSQL_PORT:-33307}
PASS=clinica_test_pw
URL="mysql+pymysql://root:${PASS}@127.0.0.1:${PORT}/clinica_test?charset=utf8mb4"

case "${1:-up}" in
  up)
    if ! docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
      docker run -d --name "$NAME" -e MYSQL_ROOT_PASSWORD="$PASS" -e MYSQL_DATABASE=clinica_test \
        -p "${PORT}:3306" mysql:8 --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci \
        --skip-log-bin --innodb-flush-log-at-trx-commit=0 --innodb-doublewrite=OFF >/dev/null  # sin fsync: es desechable
    else
      docker start "$NAME" >/dev/null
    fi
    for _ in $(seq 1 90); do
      if docker exec "$NAME" mysqladmin ping -h 127.0.0.1 -uroot -p"$PASS" --silent >/dev/null 2>&1; then
        echo "MySQL listo en 127.0.0.1:${PORT}"; exit 0
      fi
      sleep 2
    done
    echo "MySQL no respondio a tiempo" >&2; exit 1 ;;
  down) docker rm -f "$NAME" >/dev/null && echo "contenedor borrado" ;;
  url) echo "$URL" ;;
  *) echo "uso: $0 up|down|url" >&2; exit 2 ;;
esac
