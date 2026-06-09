#!/bin/bash
# Rotate ~/.open-brain/server.log when it exceeds MAX_SIZE_MB.
# The server holds the log fd open (launchd StandardOutPath), so after
# rotation we kickstart the service to make launchd reopen the file.
set -euo pipefail

LOG="$HOME/.open-brain/server.log"
MAX_SIZE_MB=10
KEEP=3

[ -f "$LOG" ] || exit 0

size_bytes=$(stat -f%z "$LOG")
[ "$size_bytes" -lt $((MAX_SIZE_MB * 1024 * 1024)) ] && exit 0

for ((i = KEEP - 1; i >= 1; i--)); do
  [ -f "$LOG.$i" ] && mv "$LOG.$i" "$LOG.$((i + 1))"
done
mv "$LOG" "$LOG.1"

launchctl kickstart -k "gui/$(id -u)/com.open-brain.server" 2>/dev/null || true
