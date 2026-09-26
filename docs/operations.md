# Operations: P0 hardening

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

## HTTP local auth (stage 2 deployed on the local Mac)

The local launchd job runs `src/server-hardened.ts`. `src/server.ts` is the legacy
entry and must not be used as a rollback: it exposes unauthenticated HTTP.
`ops/http-rollout.py` performs the approved cutover with dated adjacent 0600
backups of both client configs and the server plist. Its private manifest lives
outside git. Other client entries/settings are preserved and concurrent config
changes are rejected. P0-3 removes `OPEN_BRAIN_DISABLE_CLEANUP=1` after the durable SQL guard is
installed. Cleanup now requires a completed durable job; legacy distilled blocks
remain retained.
Distillation itself retains the existing model, prompt and cron policy.

### Secret and clients

The local token is stored **only in login Keychain**, using `secret set`:

```sh
python3 -c 'import secrets; print(secrets.token_hex(32))' | secret set OPEN_BRAIN_HTTP_TOKEN open-brain
```

Run creation only after checking whether this entry already exists; do not rotate
an existing token accidentally. Never print the token, pass it yourself in argv,
save it in a report/config file, or capture auth-helper stdout in a log. The
existing `secret` CLI writes the keychain item; its at-rest protection is not an
isolation boundary against programs running as the same logged-in user.

The server plist names `OPEN_BRAIN_HTTP_KEYCHAIN_SERVICE` (locally
`vibe/open-brain/OPEN_BRAIN_HTTP_TOKEN`); `src/security/keychain.ts` reads that
entry using `/usr/bin/security` with a five-second timeout. A locked/unavailable
Keychain, malformed value or ambiguous source fails closed **before bootstrap**.
The portable owner-only `OPEN_BRAIN_HTTP_TOKEN_FILE` mode remains supported for
other deployments, but exactly one source is allowed and this Mac uses no token
file. Keychain must be unlocked after GUI login.

Both installed clients support a dynamic headers helper. They read Keychain when
they connect; no GUI environment injection or persistent plaintext token is used:

```toml
# ~/.codex/config.toml — actual absolute node/tsx/repo paths required
[mcp_servers.open-brain]
url = "http://127.0.0.1:3100/mcp"
http_headers_helper = "/absolute/node /absolute/tsx /absolute/open-brain/src/security/headers.ts vibe/open-brain/OPEN_BRAIN_HTTP_TOKEN"
```

```json
{
  "type": "http",
  "url": "http://127.0.0.1:3100/mcp",
  "headersHelper": "/absolute/node /absolute/tsx /absolute/open-brain/src/security/headers.ts vibe/open-brain/OPEN_BRAIN_HTTP_TOKEN"
}
```

The JSON is only the `mcpServers.open-brain` entry in `~/.claude.json`.
`ops/http-rollout.py` derives absolute executable paths from the existing plist.
The helper's JSON stdout is a credential channel directly to the client, never a
diagnostic command. References: [Codex MCP headers helper](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Claude Code dynamic headers](https://code.claude.com/docs/en/mcp#dynamic-headers).

Existing client processes may retain their old configuration. Reconnect after
reloading MCP settings, or restart Claude Code / Codex Desktop if necessary.
Fresh Claude Code and Codex app-server processes were verified with live
`brain_search`; CLI config listings alone are not proof of a working connection.
No restart of another person's active client session is done by the rollout.

### Security boundary and acceptance

Bind is strictly `127.0.0.1`; `PORT` defaults to 3100. Host authorities are exactly
`127.0.0.1:<port>` and `localhost:<port>`; Origins are exactly their HTTP origins.
Forwarding headers are ignored. Bearer is required on every MCP method, API route
and health endpoint. Session IDs never authenticate. OPTIONS only grants exact
allowed Origins. Directory scan/start is blocked before body parsing and through
the upload-only service wrapper. Upload retains its 50-file / 100 KB-per-content /
6 MB-body limits. Standalone CLI vault indexing is not exposed by this HTTP entry.

The browser gets a data-free shell and asks for the token. It stays in page
memory; same-origin fetch adds it, redirects are rejected, and Lock/reload clears
it. A 401 prompts login without automatically replaying mutations. Existing
inline UI handlers require `unsafe-inline` CSP; this is not a full XSS audit.
Automated HTTP/MCP tests use synthetic data and fake services. Full live browser
CRUD/upload/export acceptance is separate from the native-client rollout smoke.

Acceptance: verify `lsof` shows only 127.0.0.1, correct bearer gives 200,
missing/wrong bearer gives 401, hostile Host/Origin and directory import give 403.
Probe every non-loopback address on the Mac; this is not a probe from a second
machine. Reconnect and call a read tool from **both native clients**, not only an
SDK. A live semantic search invokes the embedding API and writes an activity log.
Other HTTP callers must supply auth too; health endpoints are deliberately not
exempt. Docker/remote access need a separate ingress design.

### Cutover and rollback

After an approved window, fresh full backup/restore and green tests:

```sh
python3 ops/http-rollout.py activate --state /absolute/private/activation.json --apply
python3 ops/http-rollout.py check-rollback --state /absolute/private/activation.json
```

Run `PYTHONDONTWRITEBYTECODE=1 python3 ops/test_http_rollout.py` for isolated
config/fault tests. A nonzero bootout response is judged by whether launchd
actually removed the old job; starting a second listener is refused.

One-command security rollback:

```sh
python3 ops/http-rollout.py rollback --state /absolute/private/activation.json --apply
```

Rollback verifies backups and unchanged Open Brain entries/plist, disables and
unloads HTTP, and changes only the two client entries to `ops/stdio-maintenance.py`.
This wrapper passes the same server environment/DB to `src/index.ts`; it runs no
HTTP listener, distillation scheduler or startup cleanup. Reconnect both clients.
All data, snapshots, Keychain token and additive schema remain. It also handles
an interrupted cutover, without replacing unrelated concurrent client settings.
No legacy HTTP restart, git reset, database rewind, data deletion or token deletion.
The stage-1 `scratchpad/rollback-open-brain-p0.py` is obsolete after this cutover.

For rotation, update the same Keychain entry securely, restart the hardened
server, and reconnect clients so their helpers fetch the new token. Old tokens
must fail. Do not restore the previous unauthenticated plist as a recovery step.

## Durable distillation (P0-3)

Every entry point uses the same `bootstrapServices()` → `createDistillationService()`
→ `RetryStore`/`replayDistillation()` path: hardened HTTP manual runs, scheduled
cron, CLI and stdio. Startup requires the migration and enabled stream guard;
there is no silent fallback to the legacy distiller. Extraction prompt, models,
metadata enums and normal capture tagging are unchanged.

Jobs reserve immutable source snapshots before any AI request. Validated extraction
is persisted before capture. Each extracted item has a stable UUID; thought insertion
and item outcome commit together under a fenced lease. Partial failures retain the
source and successful item IDs; subsequent attempts prepare only missing items.
Final input marking, successful log and job completion commit together. Valid empty
extraction and too-short inputs terminate successfully. Tombstone outcomes survive
intentional thought deletion. Multiple processes cannot commit the same item twice.

### TTL and input lifecycle

`ops/sql/distillation-retry.sql` installs a database trigger used by every client:

- Existing `(session_id, block_number)` content, topic, participants and source are
  immutable. Identical writes can refresh TTL; corrections need a new block number.
- Reserved unfinished inputs cannot be pinned or deleted. Snapshots remain in jobs.
- Automatic **and explicit** stream deletion require a completed durable job.
  Pending, partial, blocked and **legacy-distilled** blocks remain retained even
  after TTL expires. Old `distilled_at` alone is not proof of lossless processing.

This deliberately trades additional disk retention for safety. Do not bulk re-mark
or replay legacy blocks to make them deletable. Their audit/release is separate work.
Completed jobs, snapshots, item outcomes and usage ledger have no automatic retention
policy yet. Compost cleanup retains its previous policy; the P0-3 cutover checks
its due count before enabling the existing timer.

### Backoff, blocked jobs and usage

Config keys under `distillation` (milliseconds): `retry_base_ms=60000`,
`retry_max_ms=3600000`, `retry_max_attempts=8`, `retry_poll_ms=60000`.
Failures use persisted exponential backoff capped at the maximum. Exhaustion,
including repeated lease-expiry crashes, blocks the job and retains its inputs.
The retry timer runs only when distillation is enabled and processes **existing
jobs only**; it never initiates historical extraction. The original daily cron
and explicit manual/CLI calls can reserve new input. Each call handles one batch.
Manual runs do not bypass backoff or blocked state.

`GET /api/distillation/status` exposes up to 100 unfinished jobs with attempts,
next retry time, remaining items, known tokens/cost and unknown-usage counts.
The stream UI status shows retained/blocked jobs and the next retry. To unblock,
first diagnose the cause, then explicitly set the selected job's `blocked=false`,
`attempts=0`, `next_attempt_at=now()` in an approved maintenance action. Never erase
its extraction/items/outcomes or create a new overlapping job.

`distillation_ai_calls` records intent before extraction, embedding and metadata
requests, and observed usage before response validation. Thus invalid metadata
still has recorded usage. SDK retries are disabled inside durable requests;
the job owns retries. Calls interrupted before the response/DB acknowledgement
remain **unknown**, not zero-cost. Pricing uses the existing estimate table;
unknown prices remain NULL in the ledger. A successful run log includes all known
job usage across retries; partial logs do not repeat those cumulative costs.
For unfinished work or billing reconciliation use the ledger, not just successful
run logs. Exact provider billing across a crash cannot be established locally.

### Gates and deployment

```sh
OPEN_BRAIN_TEST_PG_BIN=/absolute/postgresql/bin npm run test:p0
OPEN_BRAIN_TEST_PG_BIN=/absolute/postgresql/bin npm run test:distillation-release
PYTHONDONTWRITEBYTECODE=1 python3 ops/test_distillation_rollout.py
```

The release command refuses to run without an isolated PostgreSQL binary path.
Its mixed-failure assertion now exercises the **wired production service** against
real PostgreSQL with fake AI: no success/input marking on partial failure, restart
without extraction, exactly-once item effects. The same suite verifies TTL, immutable
writes, independent services, blocked attempts and AI usage. Replay tests additionally
cover commit acknowledgement loss, stale-owner fencing, final-log rollback and
backup/restore/resume of unfinished jobs. No production data/API calls are used.

First rehearse the SQL on a restored database and compare every original table
count. Do not run application startup or historical extraction there. After passing
gates and verifying authenticated status `running=false`:

```sh
python3 ops/distillation-rollout.py activate --state /absolute/private/p0-3/activation.json --apply
python3 ops/distillation-rollout.py check-rollback --state /absolute/private/p0-3/activation.json
```

The operator tool snapshots the plist, unloads the service, makes and restores a
fresh full backup, applies additive SQL, verifies counts and stream content hashes,
removes the cleanup pause and starts hardened HTTP. Proofs remain next to the private
manifest. `ops/distillation-db.mjs inspect` is read-only; `migrate` is an explicit
operator command, never a startup side effect. Both use the backup connection resolver
so credentials/DSNs do not appear in argv/output. `npm run migrate` includes this SQL
for new installations, but should not replace the controlled production procedure.

One-command maintenance rollback:

```sh
python3 ops/distillation-rollout.py maintenance --state /absolute/private/p0-3/activation.json --apply
```

This preserves authenticated HTTP and client configuration, sets
`OPEN_BRAIN_MAINTENANCE=1` plus `OPEN_BRAIN_DISABLE_CLEANUP=1`, and restarts with all
cron/retry/cleanup disabled and manual/CLI distillation refused. No DB rewind, schema
DROP, thought deletion, token change or legacy HTTP restart. The stdio maintenance
wrapper sets the same maintenance flag. The old HTTP rollback manifest may reject
its now-changed plist; use the P0-3 maintenance rollback first.
