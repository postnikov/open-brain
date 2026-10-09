# Open Brain

A personal second brain that captures thoughts from anywhere, finds them by meaning, and lets ideas naturally mature or dissolve.

Built on semantic search (OpenAI embeddings + pgvector), accessible via Web UI, CLI, and MCP protocol for Claude Desktop, Cursor, and other AI clients.

## Why

Thoughts happen in different places — conversations with AI, terminal sessions, Obsidian notes, Telegram chats. They scatter across tools and vanish. Open Brain gives them a single home with semantic retrieval: you don't need to remember where you put something or what you called it. Just search by meaning.

The system also respects that not every thought is permanent. Ideas have a lifecycle: capture, revisit, strengthen or let go. Thoughts can fade, compost, or get distilled from raw conversation streams.

## Quick Start

Requires Node.js 20+ and PostgreSQL 14+ with [pgvector](https://github.com/pgvector/pgvector) — your own, or the database-only Docker Compose file.

```bash
git clone https://github.com/postnikov/open-brain.git
cd open-brain
```

**1. Database.** Either run `./setup.sh` against your local PostgreSQL (it creates the user, the database, the `vector` extension and runs migrations), or use Docker for the database only:

```bash
cp .env.example .env    # add your OPENAI_API_KEY
docker compose up -d    # PostgreSQL + pgvector on 127.0.0.1:5432
docker compose exec db psql -U open_brain -d open_brain -c "CREATE EXTENSION IF NOT EXISTS vector;"
npm ci
npm run migrate
```

**2. Access token.** The HTTP server requires a bearer token on every request except the empty UI shell. Create one owner-only file with 32 random bytes as hex and point `.env` at it:

```bash
mkdir -p ~/.open-brain
(umask 077 && openssl rand -hex 32 > ~/.open-brain/http-token)
echo "OPEN_BRAIN_HTTP_TOKEN_FILE=$HOME/.open-brain/http-token" >> .env
```

**3. Start the authenticated server.**

```bash
npm run server:hardened
```

Open [http://127.0.0.1:3100](http://127.0.0.1:3100) and paste the token (`cat ~/.open-brain/http-token`); the UI keeps it in page memory only. The server listens on IPv4 loopback only and accepts only `127.0.0.1:3100` / `localhost:3100` as Host and Origin. Missing or invalid token configuration stops the server before it touches the database.

Do not use `npm run server` (`src/server.ts`): it is the legacy entry point with no authentication, `/health` open and CORS `*`. On macOS the token can live in the login Keychain instead of a file (`OPEN_BRAIN_HTTP_KEYCHAIN_SERVICE`) — see [docs/operations.md](docs/operations.md).

## Core Concepts

### Thoughts

The primary unit. Each thought gets:
- **Embedding** (text-embedding-3-small, 1536d) for semantic search
- **Auto-extracted metadata** (gpt-4o-mini) — title, tags, topics, content type, sentiment
- **Content hash** for deduplication across all sources
- **Source reference** (mandatory): file path, URL, commit or session it came from; an unknown origin is stored as `unattributed:<source>`, never left empty
- **Tier**: `hot` (opened often), `pointer` (a short thought that points to its source) or `source` (a full copy of a source document)

Search works by meaning, not keywords. Cross-language: a Russian query finds English notes and vice versa.

### Stream

Raw conversation capture. When you talk to AI, the most productive thinking disappears after closing the chat. Stream captures conversation blocks with zero AI overhead — just a fast DB write. Blocks are distilled into proper thoughts automatically and can be pinned to keep permanently. A block becomes deletable only after a durable distillation job that read it has completed: the 30-day TTL (configurable) and manual deletion both skip or reject blocks without that proof, so undistilled input is never lost.

### Distillation

The "night sleep" of your second brain. Reads accumulated stream blocks, extracts significant thoughts via LLM (decisions, insights, questions, formulations, contradictions), and writes them into Thoughts through the standard capture pipeline with full embeddings and metadata. Runs automatically via cron (default: 3 AM daily) or on-demand via Power Nap button in the Web UI or `brain distill` CLI.

### Thought Lifecycle

```
capture → review → strengthen or let go
                      ↓
                   compost (30 days) → gone
```

- **Fade / Amplify** — adjust a thought's weight in search results
- **Epistemic status** — mark as hypothesis, conviction, fact, outdated, or question
- **Compost** — soft-delete with a 30-day grace period before permanent removal
- **Review** — revisit thoughts from N days ago: still true? evolved? let go?
- **Supersede, never overwrite** — new text is a new thought that replaces the old one (`supersedes`); the old one stays, hidden from search, and can be restored. Merging duplicates marks one as replaced instead of deleting it
- **Validity end** — `valid_to` hides a thought after a date (e.g. a rule for one cohort)
- **Consolidation** — a periodic job (no AI calls) promotes often-opened thoughts to `hot`, cools them back after a month of silence, and marks distilled contradictions as `supersede-candidate` for a human to decide

### Two-step recall

`brain_recall` returns pointers only — id, title, date, type, tier, source reference, status — so an agent can choose without paying for every full text. `brain_open(ids)` then returns the text of the chosen thoughts plus whether the source file still exists or has changed since it was stored. The file is canon; memory is a lead to it.

## Web UI

11 tabs at [localhost:3100](http://localhost:3100):

| Tab | Purpose |
|-----|---------|
| **Search** | Semantic search with similarity scores and debounce |
| **Timeline** | How your thinking on a topic evolved over time |
| **Recent** | Latest thoughts with source/status filters; "from stream" badge on distilled thoughts |
| **Review** | Weekly reflection — revisit past thoughts |
| **Compost** | Thoughts you're letting go, dissolving in 30 days |
| **Duplicates** | Detect and resolve near-duplicate thoughts (merge/dismiss) |
| **Stream** | Raw conversation blocks — search, filter, pin/delete; "→ thoughts" links on distilled blocks |
| **Import** | Drag-and-drop file upload (the vault folder scanner is disabled on the authenticated server) |
| **Activity** | Real-time feed of all MCP tool calls with latency |
| **Status** | Consolidated brain health: stream/distillation/thoughts stats, expiring blocks, costs |
| **Distill Log** | Distillation run history with thought links, costs, and expandable details |

Every thought card supports inline editing (a text change saves a new version that supersedes the old one), weight control, epistemic status, batch selection, and custom modal dialogs.

## MCP Tools

12 tools available in Claude Desktop, Cursor, and any MCP client:

| Tool | Description | AI Cost |
|------|-------------|---------|
| `brain_save` | Capture thought with source ref, optional `supersedes` / `valid_to` | ~$0.0001 |
| `brain_recall` | Step 1: pointers only, no text (default 8, max 10) | ~$0.00002 |
| `brain_open` | Step 2: full text of chosen ids + source state | free |
| `brain_search` | Legacy full-text semantic search with filters | ~$0.00005 |
| `brain_recent` | Latest thoughts | free |
| `brain_related` | Find similar thoughts by ID (uses stored embedding) | free |
| `brain_stats` | Database statistics | free |
| `brain_tags` | All tags with counts | free |
| `brain_tag_rename` | Rename or merge tags | free |
| `brain_delete` | Delete a thought | free |
| `stream_write` | Write conversation block to stream (no AI) | free |
| `stream_read` | Read stream blocks with filters | free |

All tool calls are logged to the Activity feed.

### Claude Desktop (stdio)

```json
{
  "mcpServers": {
    "open-brain": {
      "command": "node",
      "args": ["--env-file=.env", "--import", "tsx/esm", "src/index.ts"],
      "cwd": "/path/to/open-brain"
    }
  }
}
```

### HTTP mode (Cursor, multiple clients)

```bash
npm run server:hardened
# MCP endpoint: http://127.0.0.1:3100/mcp (Streamable HTTP)
# every request: Authorization: Bearer <token>
```

Prefer a client that reads the header from a helper command at connect time over pasting the token into a config file; the Claude Code / Codex setup is in [docs/operations.md](docs/operations.md).

## CLI

```bash
brain save "Your thought here" --source cli --source-ref "session:abc"
brain save "Is consciousness computable?" --type question
brain save "Corrected version" --supersedes <uuid> --reason "typo"
brain unsupersede <uuid>                           # undo a replacement mark
brain search "how to build a personal brand"
brain recent --limit 10 --source obsidian
brain stream --session conv-123 --status pending
brain distill                                      # extract thoughts from stream
brain status                                       # consolidated brain health
brain stats
brain tags
brain tag-rename "old_tag" "new-tag"
brain delete <uuid>
```

`valid_to` is set through MCP `brain_save` only; the CLI has no flag for it.

## Architecture

```
┌─────────────┐  ┌──────────┐  ┌─────────┐  ┌──────────┐
│ Claude /    │  │  Web UI  │  │   CLI   │  │ Telegram │
│ MCP Client  │  │  :3100   │  │         │  │(OpenClaw)│
└──────┬──────┘  └────┬─────┘  └────┬────┘  └────┬─────┘
       │              │             │             │
       └──────┬───────┴─────────────┴─────────────┘
              │
       ┌──────▼───────┐
       │  MCP Server   │
       │  + REST API   │
       └──┬────────┬───┘
          │        │
   ┌──────▼──┐  ┌──▼──────────┐
   │ Stream  │  │  Capture    │
   │ (raw,   │  │  Pipeline   │
   │  no AI) │  │ embed+meta  │
   └────┬────┘  └──────┬──────┘
        │              │
   ┌────▼──────────────▼────┐
   │   PostgreSQL + pgvector │
   │   thoughts | stream    │
   │   activity | dismissed │
   └────────────────────────┘
```

## API

<details>
<summary>41 REST endpoints</summary>

**Search & Read**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/brain/status` | Consolidated brain health (stream + distillation + thoughts) |
| GET | `/api/recall?q=query` | Two-step recall, step 1: pointers only (`limit` ≤ 10, `min_similarity`, `include_inactive`) |
| POST | `/api/open` | Step 2: full text for `{ids, recall_id?}` + source state |
| GET | `/api/search?q=query` | Semantic search |
| GET | `/api/recent?limit=20` | Recent thoughts |
| GET | `/api/timeline?q=topic` | Chronological search |
| GET | `/api/review?days_ago=7` | Weekly review |
| GET | `/api/stats` | Database statistics |
| GET | `/api/tags` | Tags with counts |
| GET | `/api/tags/orphans` | Single-use tags |
| GET | `/api/compost` | Composted thoughts |
| GET | `/api/duplicates` | Duplicate pairs |
| GET | `/api/questions` | Thoughts marked as questions |

**Thought Mutations**

| Method | Endpoint | Description |
|--------|----------|-------------|
| PUT | `/api/thoughts/:id` | Update title/tags in place; a content change creates a new thought with `supersedes` (returns `previous_id`) |
| DELETE | `/api/thoughts/:id` | Delete |
| PATCH | `/api/thoughts/:id/weight` | Fade / amplify |
| PATCH | `/api/thoughts/:id/status` | Set epistemic status |
| POST | `/api/thoughts/:id/compost` | Send to compost |
| POST | `/api/thoughts/:id/restore` | Restore from compost |
| POST | `/api/thoughts/:id/unsupersede` | Undo a replacement mark (the newer thought stays) |
| POST | `/api/thoughts/batch` | Bulk operations |
| POST | `/api/duplicates/merge` | Merge duplicate pair |
| POST | `/api/duplicates/dismiss` | Dismiss duplicate pair |
| PUT | `/api/tags/rename` | Rename / merge tags |
| DELETE | `/api/tags/:tag/from/:id` | Remove tag from thought |

**Stream**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stream` | List blocks (session, status, search) |
| GET | `/api/stream/sessions` | Sessions with block counts |
| GET | `/api/stream/stats` | Stream statistics |
| POST | `/api/stream` | Write a block |
| PATCH | `/api/stream/:id/pin` | Pin / unpin |
| DELETE | `/api/stream/:id` | Delete block — only after its durable distillation completed; otherwise the database rejects it |

**Distillation**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/distillation/run` | Power Nap — trigger distillation (409 if running) |
| GET | `/api/distillation/status` | Running state + last run |
| GET | `/api/distillation/log` | Recent distillation runs |
| GET | `/api/distillation/log/:id` | Single run details |

**Import & Activity**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/import/files` | Import files with embeddings |
| POST | `/api/import/obsidian/scan` | Scan Obsidian vault (legacy server only; 403 on `server:hardened`) |
| POST | `/api/import/obsidian/start` | Start vault import (legacy server only; 403 on `server:hardened`) |
| GET | `/api/import/status` | Import progress |
| GET | `/api/activity` | MCP tool call log |
| GET | `/api/activity/stats` | Activity statistics |

</details>

## Configuration

**Environment** (`.env`):

| Variable | Required | Default |
|----------|----------|---------|
| `OPENAI_API_KEY` | Yes | — |
| `DATABASE_URL` | No | `postgresql://open_brain:open_brain_local@localhost:5432/open_brain` |
| `PORT` | No | `3100` |
| `OPEN_BRAIN_HTTP_TOKEN_FILE` | One of the two, for `server:hardened` | — absolute path to an owner-only file with 64 hex chars |
| `OPEN_BRAIN_HTTP_KEYCHAIN_SERVICE` | One of the two, for `server:hardened` (macOS) | — login Keychain service name |

**Config** (`~/.open-brain/config.json`) — auto-created with defaults:

```json
{
  "database": { "host": "localhost", "port": 5432, "database": "open_brain" },
  "openai": { "embedding_model": "text-embedding-3-small", "metadata_model": "gpt-4o-mini" },
  "capture": { "auto_tag": true, "auto_title": true },
  "stream": { "ttl_days": 30, "cleanup_on_startup": true },
  "distillation": { "enabled": true, "schedule": "0 3 * * *", "model": "gpt-4o-mini", "temperature": 0.3, "max_blocks_per_run": 200, "min_block_length": 50 }
}
```

## Scripts

```bash
npm run server:hardened   # Web UI + REST API + MCP HTTP, bearer token required
npm run server            # LEGACY, unauthenticated — do not use
npm run dev               # MCP stdio (Claude Desktop)
npm run cli               # CLI
npm run migrate           # Database migrations
npm run index             # Copy an Obsidian folder into thoughts — disabled unless OPEN_BRAIN_ALLOW_VAULT_COPY=1
npm run export            # Export to JSON
npm run export:md         # Export to Markdown
npm run backup            # Full pg_dump (custom format) per ~/.open-brain/backup.json, no rotation
npm run backup:check      # Verify the latest backup set and its age
npm run backup:restore    # Restore drill into a separate scratch PostgreSQL cluster
npm test                  # Unit tests (vitest)
npm run test:backup       # Backup gates (real PostgreSQL with OPEN_BRAIN_TEST_PG_BIN)
npm run test:p0           # Durable distillation gates (isolated PostgreSQL)
npm run test:distillation-release  # Release gate, requires OPEN_BRAIN_TEST_PG_BIN
npm run test:api          # API smoke — WRITES and DELETES real data, never on production
```

`npm run index` is off by default: the vault stays the source of truth and Open Brain keeps pointers to it. With the override, the vault root is the `VAULT_PATH` constant in `src/scripts/index-obsidian.ts`, and a changed file's old thought is deleted and inserted again. Backup and restore details: [docs/operations.md](docs/operations.md).

## Cost

Daily usage (~20 thoughts + ~10 searches + distillation): **~$0.01/day**. Stream writes and most read operations are free (no AI calls). Distillation adds ~$0.007/day for processing ~30 blocks.

## Tech Stack

Node.js, TypeScript (strict), PostgreSQL + pgvector, Drizzle ORM, OpenAI API, MCP SDK, Zod, Pino, Commander.js, node-cron

## License

MIT
