#!/bin/bash
# launchd entry: reads DATABASE_URL from the login Keychain, then execs the hardened server.
# The plist carries only the service name; the value never reaches argv, files or logs.
set -euo pipefail

svc="${OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE:-}"
case "$svc" in
  ''|*[!A-Za-z0-9_./-]*) echo "open-brain: OPEN_BRAIN_DATABASE_URL_KEYCHAIN_SERVICE missing or invalid" >&2; exit 78;;
esac

url=$(/usr/bin/security find-generic-password -a "$(id -un)" -s "$svc" -w "$HOME/Library/Keychains/login.keychain-db" 2>/dev/null) || url=""
case "$url" in
  postgres://*|postgresql://*) ;;
  *) echo "open-brain: DATABASE_URL unavailable or invalid in login Keychain (locked?)" >&2; exit 78;;
esac

cd "$(dirname "$0")/.."
DATABASE_URL="$url" exec /opt/homebrew/bin/node node_modules/.bin/tsx src/server-hardened.ts
