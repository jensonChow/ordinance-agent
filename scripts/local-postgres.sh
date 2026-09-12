#!/bin/zsh
# Local PostgreSQL 17 cluster for development, kept inside the repo (.local/pgdata, gitignored).
# Usage: scripts/local-postgres.sh init | start | stop | status | psql [args]
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
PGDATA="$ROOT/.local/pgdata"
PORT="${PGPORT:-5433}"
DB="ordinance_agent"
case "$1" in
  init)
    mkdir -p "$ROOT/.local"
    LANG=C LC_ALL=C "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust -E UTF8 --locale=C >/dev/null
    "$0" start
    "$PGBIN/createdb" -p "$PORT" -h 127.0.0.1 -U postgres "$DB"
    echo "created database $DB on 127.0.0.1:$PORT (DATABASE_URL=postgresql://postgres@127.0.0.1:$PORT/$DB)"
    ;;
  start) LANG=C LC_ALL=C "$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -l "$ROOT/.local/postgres.log" start ;;
  stop) "$PGBIN/pg_ctl" -D "$PGDATA" stop -m fast ;;
  status) "$PGBIN/pg_isready" -p "$PORT" -h 127.0.0.1 ;;
  psql) shift; "$PGBIN/psql" -p "$PORT" -h 127.0.0.1 -U postgres -d "$DB" "$@" ;;
  *) echo "usage: $0 init|start|stop|status|psql [args]"; exit 1 ;;
esac
