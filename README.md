# Open Brain

A personal second brain that captures thoughts from anywhere, finds them by meaning, and lets ideas naturally mature or dissolve.

Built on semantic search (OpenAI embeddings + pgvector), accessible via Web UI, CLI, and MCP protocol for Claude Desktop, Cursor, and other AI clients.

## Why

Thoughts happen in different places — conversations with AI, terminal sessions, Obsidian notes, Telegram chats. They scatter across tools and vanish. Open Brain gives them a single home with semantic retrieval: you don't need to remember where you put something or what you called it. Just search by meaning.

The system also respects that not every thought is permanent. Ideas have a lifecycle: capture, revisit, strengthen or let go. Thoughts can fade, compost, or get distilled from raw conversation streams.

## Quick Start

### Docker

```bash
git clone https://github.com/postnikov/open-brain.git
cd open-brain
cp .env.example .env    # add your OPENAI_API_KEY
docker compose up
```

### Manual

Requires Node.js 20+, PostgreSQL 14+ with [pgvector](https://github.com/pgvector/pgvector).

```bash
git clone https://github.com/postnikov/open-brain.git
cd open-brain
./setup.sh
npm run server
```

Open [http://localhost:3100](http://localhost:3100)

## Core Concepts

### Thoughts

The primary unit. Each thought gets:
- **Embedding** (text-embedding-3-small, 1536d) for semantic search
- **Auto-extracted metadata** (gpt-4o-mini) — title, tags, topics, content type, sentiment
- **Content hash** for deduplication across all sources

Search works by meaning, not keywords. Cross-language: a Russian query finds English notes and vice versa.

### Stream

Raw conversation capture. When you talk to AI, the most productive thinking disappears after closing the chat. Stream captures conversation blocks with zero AI overhead — just a fast DB write. Blocks live for 30 days (configurable TTL), can be pinned to keep permanently, and will be distilled into proper thoughts in a future release.

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

## Web UI

10 tabs at [localhost:3100](http://localhost:3100):

| Tab | Purpose |
|-----|---------|
| **Search** | Semantic search with similarity scores and debounce |
| **Timeline** | How your thinking on a topic evolved over time |
| **Recent** | Latest thoughts with source/status filters |
| **Review** | Weekly reflection — revisit past thoughts |
| **Compost** | Thoughts you're letting go, dissolving in 30 days |
| **Duplicates** | Detect and resolve near-duplicate thoughts (merge/dismiss) |
| **Stream** | Raw conversation blocks — search, filter by session, pin/delete |
| **Import** | Drag-and-drop files + Obsidian vault scanner with progress |
| **Activity** | Real-time feed of all MCP tool calls with latency |
| **Stats** | Counts by source, type, activity trends, orphan tags |

Every thought card supports inline editing (with re-embedding), weight control, epistemic status, batch selection, and custom modal dialogs.

## MCP Tools

10 tools available in Claude Desktop, Cursor, and any MCP client:

| Tool | Description | AI Cost |
|------|-------------|---------|
| `brain_save` | Capture thought with auto-embedding + metadata | ~$0.0001 |
| `brain_search` | Semantic search with filters | ~$0.00005 |
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
npm run server
# MCP endpoint: http://localhost:3100/mcp (Streamable HTTP)
```

## CLI

```bash
brain save "Your thought here" --source cli
brain save "Is consciousness computable?" --type question
brain search "how to build a personal brand"
brain recent --limit 10 --source obsidian
brain stream --session conv-123 --status pending
brain stats
brain tags
brain tag-rename "old_tag" "new-tag"
brain delete <uuid>
```

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
<summary>32 REST endpoints</summary>

**Search & Read**

| Method | Endpoint | Description |
|--------|----------|-------------|
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
| PUT | `/api/thoughts/:id` | Update (re-embeds on content change) |
| DELETE | `/api/thoughts/:id` | Delete |
| PATCH | `/api/thoughts/:id/weight` | Fade / amplify |
| PATCH | `/api/thoughts/:id/status` | Set epistemic status |
| POST | `/api/thoughts/:id/compost` | Send to compost |
| POST | `/api/thoughts/:id/restore` | Restore from compost |
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
| DELETE | `/api/stream/:id` | Delete block |

**Import & Activity**

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/import/files` | Import files with embeddings |
| POST | `/api/import/obsidian/scan` | Scan Obsidian vault |
| POST | `/api/import/obsidian/start` | Start vault import |
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

**Config** (`~/.open-brain/config.json`) — auto-created with defaults:

```json
{
  "database": { "host": "localhost", "port": 5432, "database": "open_brain" },
  "openai": { "embedding_model": "text-embedding-3-small", "metadata_model": "gpt-4o-mini" },
  "capture": { "auto_tag": true, "auto_title": true },
  "stream": { "ttl_days": 30, "cleanup_on_startup": true }
}
```

## Scripts

```bash
npm run server      # Web UI + REST API + MCP HTTP
npm run dev         # MCP stdio (Claude Desktop)
npm run cli         # CLI
npm run migrate     # Database migrations
npm run test:api    # API smoke tests
npm run index       # Index Obsidian vault
npm run export      # Export to JSON
npm run export:md   # Export to Markdown
npm run backup      # pg_dump backup
```

## Cost

Daily usage (~20 thoughts + ~10 searches): **~$0.002/day**. Stream writes and most read operations are free (no AI calls).

## Tech Stack

Node.js, TypeScript (strict), PostgreSQL + pgvector, Drizzle ORM, OpenAI API, MCP SDK, Zod, Pino, Commander.js

## License

MIT
