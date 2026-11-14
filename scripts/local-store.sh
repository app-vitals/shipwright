#!/usr/bin/env bash
#
# scripts/local-store.sh — one-command local Shipwright task store
#
# Usage:
#   ./scripts/local-store.sh                # boot (idempotent), write the env file, print `source <file>`
#   ./scripts/local-store.sh --show-token   # same, but also print the raw token
#   ./scripts/local-store.sh --down         # tear down containers, volume, token and env file
#   ./scripts/local-store.sh --help
#
# What it does:
#   1. Generates a docker compose file (Postgres + the published task-store image)
#   2. Starts it and waits for GET /health/ready
#   3. Mints an unscoped token with POST /tokens (cached in a token file, reused on re-run)
#   4. Writes SHIPWRIGHT_TASK_STORE_URL / SHIPWRIGHT_TASK_STORE_TOKEN as `export` lines to an
#      env file (mode 600, rewritten on every run) and ends with the one line to run:
#      source <env file>. The raw token is not printed unless --show-token is passed.
#
# Requires only Docker (with the compose plugin) and curl.
#
# Env overrides:
#   SHIPWRIGHT_LOCAL_STORE_PORT   host port (default 3002)
#   SHIPWRIGHT_LOCAL_STORE_IMAGE  image ref (default ghcr.io/app-vitals/shipwright-task-store:latest)
#   SHIPWRIGHT_LOCAL_STORE_DIR    state dir (default ~/.shipwright/local-store)
#   SHIPWRIGHT_LOCAL_STORE_ENV_FILE  env file (default ~/.shipwright/local-store.env)

set -euo pipefail

PORT="${SHIPWRIGHT_LOCAL_STORE_PORT:-3002}"
IMAGE="${SHIPWRIGHT_LOCAL_STORE_IMAGE:-ghcr.io/app-vitals/shipwright-task-store:latest}"
STATE_DIR="${SHIPWRIGHT_LOCAL_STORE_DIR:-$HOME/.shipwright/local-store}"
PROJECT="shipwright-local-store"
ENV_FILE="${SHIPWRIGHT_LOCAL_STORE_ENV_FILE:-$HOME/.shipwright/local-store.env}"
COMPOSE_FILE="$STATE_DIR/docker-compose.yml"
TOKEN_FILE="$STATE_DIR/token"
BOOTSTRAP_FILE="$STATE_DIR/bootstrap-token"
URL="http://localhost:$PORT"
READY_TIMEOUT="${SHIPWRIGHT_LOCAL_STORE_READY_TIMEOUT:-120}"

usage() {
  sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

MODE=up
SHOW_TOKEN=0
for arg in "$@"; do
  case "$arg" in
    --down) MODE=down ;;
    --show-token) SHOW_TOKEN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

compose() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

require_docker() {
  command -v docker >/dev/null 2>&1 \
    || die "Docker is not installed or not on PATH. Install it from https://docs.docker.com/get-docker/ and re-run."
  docker info >/dev/null 2>&1 \
    || die "Docker is installed but the daemon is not running. Start Docker and re-run."
  docker compose version >/dev/null 2>&1 \
    || die "The Docker Compose plugin is missing. Install it from https://docs.docker.com/compose/install/."
}

port_in_use() {
  if command -v nc >/dev/null 2>&1; then
    nc -z localhost "$PORT" >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1
  fi
}

ready() {
  curl -fsS "$URL/health/ready" >/dev/null 2>&1
}

# Rewrite the env file (mode 600) and finish with the single line to run.
write_env_file() {
  mkdir -p "$(dirname "$ENV_FILE")"
  (
    umask 077
    {
      echo "export SHIPWRIGHT_TASK_STORE_URL=$URL"
      echo "export SHIPWRIGHT_TASK_STORE_TOKEN=$(cat "$TOKEN_FILE")"
    } >"$ENV_FILE"
  )
  chmod 600 "$ENV_FILE"
  if [ "$SHOW_TOKEN" = 1 ]; then
    echo "Token: $(cat "$TOKEN_FILE")"
  fi
  echo "source $ENV_FILE"
}

if [ "$MODE" = down ]; then
  require_docker
  if [ -f "$COMPOSE_FILE" ]; then
    compose down -v --remove-orphans
  fi
  rm -rf "$STATE_DIR"
  rm -f "$ENV_FILE"
  echo "Local task store removed."
  exit 0
fi

require_docker
command -v curl >/dev/null 2>&1 || die "curl is required but not installed."

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

# Idempotent fast path: already running and a token is saved.
if ready && [ -s "$TOKEN_FILE" ]; then
  echo "Local task store already running at $URL" >&2
  write_env_file
  exit 0
fi

# Port taken by something that is not our stack (ours would have been ready above).
if ! compose ps -q task-store 2>/dev/null | grep -q . && port_in_use; then
  die "Port $PORT is already in use. Free it or set SHIPWRIGHT_LOCAL_STORE_PORT to another port."
fi

# Bootstrap admin token seeds the store so we can call POST /tokens; persisted so the
# generated compose file is stable across re-runs.
if [ ! -s "$BOOTSTRAP_FILE" ]; then
  umask 077
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$BOOTSTRAP_FILE"
fi
BOOTSTRAP="$(cat "$BOOTSTRAP_FILE")"

cat >"$COMPOSE_FILE" <<YAML
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: shipwright
      POSTGRES_PASSWORD: shipwright
      POSTGRES_DB: task_store
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U shipwright -d task_store"]
      interval: 2s
      timeout: 3s
      retries: 30
  task-store:
    image: $IMAGE
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      PORT: "3000"
      DATABASE_URL_SHIPWRIGHT_TASK_STORE: postgresql://shipwright:shipwright@postgres:5432/task_store
      TASK_STORE_SEED_ADMIN_TOKEN: $BOOTSTRAP
    ports:
      - "127.0.0.1:$PORT:3000"
volumes:
  pgdata:
YAML
chmod 600 "$COMPOSE_FILE"

echo "Starting local task store ($IMAGE)..." >&2
compose up -d >&2 \
  || die "docker compose up failed (image pull or container start). If the image pull failed, set SHIPWRIGHT_LOCAL_STORE_IMAGE to a published tag (e.g. ghcr.io/app-vitals/shipwright-task-store:task-store-vX.Y.Z). See output above."

echo "Waiting for $URL/health/ready (up to ${READY_TIMEOUT}s)..." >&2
waited=0
until ready; do
  if [ "$waited" -ge "$READY_TIMEOUT" ]; then
    compose logs --tail 30 task-store >&2 || true
    die "Task store did not become ready within ${READY_TIMEOUT}s."
  fi
  sleep 2
  waited=$((waited + 2))
done

if [ ! -s "$TOKEN_FILE" ]; then
  resp="$(curl -fsS -X POST "$URL/tokens" \
    -H "Authorization: Bearer $BOOTSTRAP" \
    -H 'Content-Type: application/json' \
    -d '{"label":"local-store"}')" || die "Failed to mint a token via POST /tokens."
  raw="$(printf '%s' "$resp" | sed -n 's/.*"rawToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  [ -n "$raw" ] || die "POST /tokens response did not contain a rawToken."
  (umask 077; printf '%s' "$raw" >"$TOKEN_FILE")
fi

echo "Local task store ready at $URL" >&2
write_env_file
