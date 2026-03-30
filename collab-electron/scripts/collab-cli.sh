#!/usr/bin/env sh
set -eu

SOCKET_FILE="${HOME}/.collaborator/socket-path"

usage() {
  cat <<'EOF'
Usage:
  collab [method] [params-json]
  collab --socket <path> [method] [params-json]

Examples:
  collab ping
  collab rpc.discover
  collab workspace.getConfig
  collab app.notify '{"body":"Build finished"}'
EOF
}

SOCKET_PATH=""
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "${1:-}" = "--socket" ]; then
  if [ $# -lt 2 ]; then
    echo "Missing socket path after --socket" >&2
    exit 1
  fi
  SOCKET_PATH="$2"
  shift 2
fi

METHOD="${1:-ping}"
PARAMS_JSON="${2:-}"

if [ -z "$SOCKET_PATH" ]; then
  if [ ! -f "$SOCKET_FILE" ]; then
    echo "Collaborator is not running. Expected socket breadcrumb at $SOCKET_FILE" >&2
    exit 1
  fi
  SOCKET_PATH="$(cat "$SOCKET_FILE")"
fi

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "Python is required to use the collab CLI on Unix." >&2
  exit 1
fi

"$PYTHON_BIN" - "$SOCKET_PATH" "$METHOD" "$PARAMS_JSON" <<'PY'
import json
import socket
import sys

socket_path = sys.argv[1]
method = sys.argv[2]
params_raw = sys.argv[3] if len(sys.argv) > 3 else ""

if socket_path.startswith("\\\\.\\pipe\\"):
    raise SystemExit("Named pipe endpoints are only supported by collab.cmd / PowerShell.")

params = None
if params_raw:
    try:
        params = json.loads(params_raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid params JSON: {exc}") from exc

payload = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": method,
}
if params is not None:
    payload["params"] = params

client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.connect(socket_path)
client.sendall((json.dumps(payload) + "\n").encode("utf-8"))

buffer = ""
while "\n" not in buffer:
    chunk = client.recv(4096)
    if not chunk:
        break
    buffer += chunk.decode("utf-8")

client.close()
line = buffer.split("\n", 1)[0].strip()
if not line:
    raise SystemExit("No response from Collaborator.")

response = json.loads(line)
if response.get("error"):
    error = response["error"]
    raise SystemExit(f"{error.get('message', 'Unknown error')} (code {error.get('code')})")

result = response.get("result")
if isinstance(result, (dict, list)):
    print(json.dumps(result, indent=2))
elif result is None:
    print("null")
else:
    print(result)
PY
