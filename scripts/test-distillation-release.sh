#!/bin/bash
set -euo pipefail
: "${OPEN_BRAIN_TEST_PG_BIN:?Release gate requires isolated PostgreSQL; set OPEN_BRAIN_TEST_PG_BIN}"
exec npx vitest run src/distillation/service.test.ts
