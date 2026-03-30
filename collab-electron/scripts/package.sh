#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
exec bun ./scripts/package.mjs "$@"
