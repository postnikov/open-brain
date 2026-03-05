#!/bin/bash
# Open Brain database backup
# Usage: ./backup.sh [output_dir]

OUTPUT_DIR="${1:-$HOME/.open-brain/backups}"
mkdir -p "$OUTPUT_DIR"

TIMESTAMP=$(date +%Y-%m-%d_%H%M)
BACKUP_FILE="$OUTPUT_DIR/open-brain-$TIMESTAMP.sql.gz"

PGPASSWORD="${PGPASSWORD:-open_brain_local}" pg_dump \
  -U "${PGUSER:-open_brain}" \
  -h "${PGHOST:-localhost}" \
  -d "${PGDATABASE:-open_brain}" \
  --no-owner \
  --no-privileges \
  | gzip > "$BACKUP_FILE"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "Backup saved: $BACKUP_FILE ($SIZE)"

# Keep only last 10 backups
ls -t "$OUTPUT_DIR"/open-brain-*.sql.gz 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null

REMAINING=$(ls "$OUTPUT_DIR"/open-brain-*.sql.gz 2>/dev/null | wc -l | tr -d ' ')
echo "Total backups: $REMAINING"
