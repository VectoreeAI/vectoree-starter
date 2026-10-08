#!/usr/bin/env bash
# 服务器上拉 GitLab 镜像并重启 compose。不在服务器上构建，也不删数据卷。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.deploy.yml}"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "Missing .env"
  exit 1
fi

read_dotenv() {
  local key="$1"
  local line value
  line="$(grep -E "^[[:space:]]*${key}=" .env | tail -n 1 || true)"
  [[ -z "$line" ]] && return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "$value" =~ ^\"(.*)\"$ ]]; then
    value="${BASH_REMATCH[1]}"
  elif [[ "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

apply_dotenv() {
  local var="$1"
  local from_file
  from_file="$(read_dotenv "$var")"
  if [[ -n "$from_file" ]]; then
    printf -v "$var" '%s' "$from_file"
  fi
}

apply_dotenv STARTER_SERVER_IMAGE
apply_dotenv STARTER_WEB_IMAGE
apply_dotenv VECTOREE_API_URL
apply_dotenv STARTER_WEB_PORT

if [[ -z "${STARTER_SERVER_IMAGE:-}" || -z "${STARTER_WEB_IMAGE:-}" ]]; then
  echo "Set STARTER_SERVER_IMAGE and STARTER_WEB_IMAGE in .env"
  exit 1
fi

export STARTER_SERVER_IMAGE STARTER_WEB_IMAGE
export VECTOREE_API_URL="${VECTOREE_API_URL:-https://vectoree.ai}"
export STARTER_WEB_PORT="${STARTER_WEB_PORT:-5173}"

COMPOSE_BIN=()
setup_compose() {
  export DOCKER_CLI_PLUGIN_EXTRA_DIRS="${DOCKER_CLI_PLUGIN_EXTRA_DIRS:-/usr/libexec/docker/cli-plugins:/usr/lib/docker/cli-plugins}"
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_BIN=(docker compose)
    return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_BIN=(docker-compose)
    return
  fi
  echo "[remote] ERROR: Docker Compose is not installed."
  exit 1
}
dc() {
  "${COMPOSE_BIN[@]}" -f "$COMPOSE_FILE" "$@"
}

setup_compose
echo "[remote] Using: ${COMPOSE_BIN[*]}"

for svc in server web; do
  attempt=1
  max=5
  while true; do
    echo "[remote] Pull ${svc} (${attempt}/${max})..."
    if dc pull "$svc"; then
      break
    fi
    if [[ "$attempt" -ge "$max" ]]; then
      echo "[remote] ERROR: pull ${svc} failed after ${max} attempts"
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep 15
  done
done

echo "[remote] Starting stack..."
dc up -d --remove-orphans --no-build

echo "[remote] Waiting for http://127.0.0.1:${STARTER_WEB_PORT}/starter/ ..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${STARTER_WEB_PORT}/starter/" >/dev/null 2>&1; then
    echo "[remote] OK — http://127.0.0.1:${STARTER_WEB_PORT}/starter/"
    exit 0
  fi
  sleep 5
done

echo "[remote] Health check failed:"
dc logs --tail=80 server web || true
exit 1
