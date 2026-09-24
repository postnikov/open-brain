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

## HTTP local auth (prepared; stage 2 activation)

The production entry point remains `src/server.ts`. The secured entry point is
`src/server-hardened.ts` / `npm run server:hardened`. No live plist or MCP config is
rewritten by stage 1. Both clients currently lack auth, so enabling the secured
entry point before their migration would break them. Shared `json()` no longer
adds wildcard CORS; the running process retains its previously loaded code.

Before starting the secured entry point, set `OPEN_BRAIN_HTTP_TOKEN_FILE` to an
absolute path containing 32 random bytes encoded as 64 lowercase hex characters.
Create it with owner-only mode 0600, backed up before rotation; do not print it,
put it in argv, git, browser storage or logs. Example creation in an approved
activation window (fails if the file already exists):

```python
import os, secrets
path = os.path.expanduser('~/.open-brain/http-token')
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write(secrets.token_hex(32) + '\n')
```

Bind is strictly `127.0.0.1`; `PORT` defaults to 3100. Host authorities are exactly
`127.0.0.1:<port>` and `localhost:<port>`; Origins are exactly their HTTP origins.
Forwarding headers are ignored. Bearer is required on every MCP method, all API
routes and health. MCP session IDs never authenticate. OPTIONS only grants exact
allowed Origins. Directory scan/start is blocked before body parsing and through
the wrapped import service. Upload retains its 50-file / 100 KB-per-content /
6 MB-body limits. Standalone CLI vault indexing is not exposed by this HTTP entry.

The browser receives a data-free shell and asks for the token. The token remains
in page memory; same-origin fetch adds it, redirects are rejected, and Lock/reload
clears it. A 401 prompts login again without automatically replaying mutations.
Existing inline UI handlers require `unsafe-inline` CSP; this is not a full XSS
audit. Native client and full UI acceptance remain release gates.

Client changes for Max's approved stage 2 (edit only the existing open-brain entry,
keep other settings, and back up both files first):

```toml
# ~/.codex/config.toml
[mcp_servers.open-brain]
url = "http://127.0.0.1:3100/mcp"
bearer_token_env_var = "OPEN_BRAIN_HTTP_TOKEN"
```

```json
{
  "type": "http",
  "url": "http://127.0.0.1:3100/mcp",
  "headers": { "Authorization": "Bearer ${OPEN_BRAIN_HTTP_TOKEN}" }
}
```

The JSON is the `mcpServers.open-brain` value in `~/.claude.json`. Ensure the actual
Codex Desktop and Claude Code processes inherit `OPEN_BRAIN_HTTP_TOKEN` securely;
putting it only in the server's `.env` does not do that. Use the existing keychain /
GUI env mechanism after approval, or launch clients from an environment that reads
the token file without echoing it. Validate header expansion in the installed
Claude version before switching the server. Documentation: [Codex MCP](https://developers.openai.com/codex/mcp/),
[Claude Code MCP headers and env expansion](https://code.claude.com/docs/en/mcp).

After clients are ready, back up the server plist, change only the entry path to
`src/server-hardened.ts` and add `OPEN_BRAIN_HTTP_TOKEN_FILE` (path, not token).
Restart during the approved window. Confirm `lsof` shows only 127.0.0.1; in **both
actual clients**, reconnect, list tools and call `brain_recent`/`brain_stats`.
Test UI login/read/upload/lock and wrong token/Origin/Host. SDK smoke tests are not
evidence that the two native clients have been migrated. No external-node LAN
probe has been performed. Docker needs a separate ingress design; this entry is
for local launchd only.

Rotation: securely replace token file, refresh both clients' environment, restart
secured server, reconnect. Old token and old sessions must fail. If activation
fails, stop HTTP and use the existing stdio MCP after verifying it; **do not**
restore wildcard unauthenticated HTTP as a security rollback. Stage 1 itself has
not activated auth, so it requires no application rollback.
