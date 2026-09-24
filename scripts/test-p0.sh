#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
: "${OPEN_BRAIN_TEST_PG_BIN:?Set OPEN_BRAIN_TEST_PG_BIN to an absolute PostgreSQL bin directory; no production DSN is used}"
for binary in initdb pg_ctl pg_dump pg_restore; do
  test -x "$OPEN_BRAIN_TEST_PG_BIN/$binary"
done
npx tsc --noEmit
npx vitest run
