#!/bin/bash
# Full database backup. Configuration: OPEN_BRAIN_BACKUP_CONFIG or ~/.open-brain/backup.json.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec "${OPEN_BRAIN_NODE:-node}" "$ROOT/scripts/backup/cli.mjs" backup "$@"
