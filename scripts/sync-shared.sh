#!/usr/bin/env bash
# Copy the canonical /shared logic into /functions/shared so Cloud Functions can
# bundle it (functions only deploy their own folder). Runs at predeploy and before
# local emulation. functions/shared is gitignored (generated).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/functions/shared"
cp "$ROOT/shared/"*.js "$ROOT/functions/shared/"
echo "synced shared/ -> functions/shared/"
