# Operations: staged P0 hardening

## Full local backup (stage 1)

`npm run backup`, `npm run backup:check`, `npm run backup:restore` use
`OPEN_BRAIN_BACKUP_CONFIG` (default `~/.open-brain/backup.json`). This JSON contains
paths/thresholds, never credentials:

```json
{
  "directory": "/absolute/private/backups",
  "pgBin": "/absolute/postgresql/bin",
  "serverPlist": "/absolute/com.open-brain.server.plist",
  "envFile": "/absolute/open-brain/.env",
  "appConfig": "/absolute/.open-brain/config.json",
  "restoreDirectory": "/absolute/private/restore-checks",
  "maxBackupHours": 36,
  "maxRestoreHours": 192,
  "minFreeBytes": 1073741824,
  "minBackupIntervalHours": 20
}
```

Connection precedence matches the installed server: launchd DATABASE_URL, then
repository dotenv DATABASE_URL, then explicit application database config. Invalid
configuration fails; there is no database fallback. Source is local-only. The
server plist is read in memory; libpq receives a temporary 0600 PGPASSFILE, never a
password in argv. PostgreSQL errors are not printed. Custom dumps contain the full
database, including vector extensions, indexes and all tables. No retention/deletion.

Counts and pg_dump use the **same exported repeatable-read snapshot**. The dump is
fsynced, renamed, then its checksum manifest and latest pointer are atomically
published. Only complete, checksum-valid sets count as success. A crash can leave
an unreferenced file or a lock; neither is silently treated as a valid backup.

`ops/install-backup-launchd.py` installs three owner-only jobs with absolute paths:
daily backup 04:00, hourly watchdog, weekly Sunday restore 05:00, all RunAtLoad.
Backup/restore skip recent successful work. Existing plists are never overwritten.
Register all three in the local Mission Control services registry. Check their
`launchctl print gui/$(id -u)/com.open-brain.<backup|backup-check|restore-check>`
exit codes and `backups/logs/`. Watchdog has persistent `watchdog.json`, nonzero
exit until repaired, and deduplicated stderr alerts. It runs independently of the
application and producer; Mission Control can inspect job exit/logs. No external
notification delivery is configured.

Restore creates a fresh **separate PostgreSQL cluster** with a 0700 Unix socket
and no TCP listener, restores into `open_brain_restorecheck`, compares every user
table count, indexes/constraints/extensions/sequences and runs vector queries.
It never accepts a production target DSN. A successful drill records the exact
archive hash, then stops its cluster. Data directories are retained, including on
failure; no application scheduler is started. Socket paths must fit PostgreSQL's
Unix socket path limit. The full dump does not include cluster roles/passwords;
restore deliberately uses a new owner and ignores grants. This is database-data
recovery, not a byte-identical cluster/credential backup.

Run `OPEN_BRAIN_TEST_PG_BIN=/absolute/postgresql/bin npm run test:backup` for the
isolated synthetic PostgreSQL suite (also tests concurrent writes, failed dump,
missing binaries, insufficient disk and last-good preservation). Without that env,
only pure file/lock/age tests run. Real test clusters are retained under `/tmp/ob-pg-*`
and stopped. Never run `scripts/test-api.sh` on production for this work.

Recovery: inspect `<name>.lock/owner.json`; verify that PID is no longer the job and
no matching pg_dump/restore is running, then remove only that stale lock and rerun.
Do not remove valid or orphaned archives automatically. Missing/corrupt/stale
backup or restore proof means failure, even if a scheduled job once exited zero.
Mac sleep/logout can delay execution; a local disk backup does not cover disk loss.

Rollback backup scheduling without touching data:

```sh
for label in backup backup-check restore-check; do
  launchctl bootout "gui/$(id -u)/com.open-brain.$label"
done
```

Keep backup files and proof. Restore the registry from its task snapshot (or remove
only these three entries if it has since changed). Do not restore the old automatic
deleting backup script into scheduled use.
