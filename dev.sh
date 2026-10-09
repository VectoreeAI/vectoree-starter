#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 20+ and npm are required." >&2
  exit 1
fi

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [[ "${node_major}" -lt 20 ]]; then
  echo "Node.js 20+ is required (found $(node -v))." >&2
  exit 1
fi

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn | grep -qE "[.:]${port}([^0-9]|$)"
    return
  fi
  return 1
}

for port in 5173 8787; do
  if port_in_use "${port}"; then
    echo "Port ${port} is already in use. Stop the process listening there, then run ./dev.sh again." >&2
    exit 1
  fi
done

if [[ ! -d node_modules ]] || [[ package-lock.json -nt node_modules ]]; then
  npm install
fi

echo "Web  http://127.0.0.1:5173"
echo "BFF  http://127.0.0.1:8787"
exec npm run dev
