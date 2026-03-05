# Open Brain

Personal thought capture and semantic search system. A second brain with AI-powered embeddings, accessible via web UI, CLI, and MCP (Model Context Protocol).

## Quick Start (Docker)

```bash
git clone https://github.com/postnikov/open-brain.git
cd open-brain
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY
docker compose up
```

Open http://localhost:3100

## Quick Start (without Docker)

Requires Node.js 20+, PostgreSQL 14+ with [pgvector](https://github.com/pgvector/pgvector).

```bash
git clone https://github.com/postnikov/open-brain.git
cd open-brain
./setup.sh
npm run server
```

Open http://localhost:3100

## Features

**Capture** thoughts from any source with automatic embedding and metadata extraction (title, tags, topics, sentiment).

**Semantic Search** finds thoughts by meaning, not just keywords. Powered by OpenAI embeddings + pgvector cosine similarity.

**Web UI** with 10 tabs:
- **Search** — semantic search with similarity scores
- **Timeline** — see how your thinking evolves on a topic over time
- **Recent** — latest thoughts with source filters
- **Review** — weekly reflection: revisit past thoughts (still true? evolved? let go?)
- **Compost** — thoughts you're letting go, dissolving in 30 days
- **Duplicates** — find and resolve near-duplicate thoughts
- **Stream** — raw conversation capture buffer for later distillation into thoughts
- **Import** — drag-and-drop file upload + Obsidian vault scanner with progress tracking
- **Activity** — real-time feed of all MCP tool calls (who, when, what, latency)
- **Stats** — counts by source, type, orphan tags

**Thought Controls:**
- Inline editing with automatic re-embedding
- Fade/Amplify — adjust thought weight in search results
- Epistemic status — mark thoughts as hypothesis, conviction, fact, outdated, or question
- Batch operations — select multiple, bulk delete/compost/tag/status
- Custom modal dialogs (no browser alerts)

**MCP Server** with 10 tools for Claude Desktop, Cursor, and other MCP clients:
- `brain_save` — capture a thought with auto-embedding and metadata
- `brain_search` — semantic search with filters
- `brain_recent` — latest thoughts
- `brain_related` — find semantically similar thoughts by ID
- `brain_stats` — database statistics
- `brain_tags` — list all tags with counts
- `brain_tag_rename` — rename or merge tags
- `brain_delete` — delete a thought by ID
- `stream_write` — write a conversation block to the stream (no AI, fast)
- `stream_read` — read stream blocks with filters

All MCP tool calls are logged to the Activity Feed for full transparency.

**CLI** for terminal workflows:
```bash
npm run cli -- save "Your thought here" -s terminal
npm run cli -- search "semantic query"
npm run cli -- recent --limit 10
npm run cli -- stats
```

## Architecture

```
┌──────────────┐  ┌──────────┐  ┌──────────┐
│  Claude /    │  │  Web UI  │  │   CLI    │
│  MCP Client  │  │ :3100    │  │          │
└──────┬───────┘  └────┬─────┘  └────┬─────┘
       │               │              │
       └───────┬───────┴──────────────┘
               │
        ┌──────▼──────┐
        │  MCP Server  │
        │  + REST API  │
        └──────┬──────┘
               │
     ┌─────────▼─────────┐
     │  Capture Pipeline  │
     │  embed + metadata  │
     └─────────┬─────────┘
               │
     ┌─────────▼─────────┐
     │  PostgreSQL        │
     │  + pgvector        │
     └───────────────────┘
```

## MCP Configuration

### Claude Desktop (stdio mode)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

### HTTP mode (Cursor, OpenClaw, multiple clients)

Start the server: `npm run server`

The MCP endpoint is available at `http://localhost:3100/mcp` (Streamable HTTP transport). Clients connect via POST with session management through `mcp-session-id` header.

All tool calls from any connected client are logged to the **Activity** tab in the web UI.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/search?q=query` | Semantic search |
| GET | `/api/recent?limit=20` | Recent thoughts |
| GET | `/api/timeline?q=topic` | Chronological search |
| GET | `/api/stats` | Database statistics |
| GET | `/api/tags` | All tags with counts |
| GET | `/api/tags/orphans` | Single-use tags |
| GET | `/api/review?days_ago=7` | Weekly review |
| GET | `/api/compost` | Composted thoughts |
| GET | `/api/duplicates` | Duplicate pairs |
| GET | `/api/questions` | Thoughts marked as questions |
| PUT | `/api/thoughts/:id` | Update thought |
| DELETE | `/api/thoughts/:id` | Delete thought |
| PATCH | `/api/thoughts/:id/weight` | Fade/amplify |
| PATCH | `/api/thoughts/:id/status` | Set epistemic status |
| POST | `/api/thoughts/:id/compost` | Send to compost |
| POST | `/api/thoughts/:id/restore` | Restore from compost |
| POST | `/api/thoughts/batch` | Bulk operations |
| POST | `/api/duplicates/merge` | Merge duplicate pair |
| POST | `/api/duplicates/dismiss` | Dismiss duplicate pair |
| PUT | `/api/tags/rename` | Rename/merge tags |
| DELETE | `/api/tags/:tag/from/:thoughtId` | Remove tag from thought |
| POST | `/api/import/files` | Import files with embeddings |
| POST | `/api/import/obsidian/scan` | Scan Obsidian vault for .md files |
| POST | `/api/import/obsidian/start` | Start Obsidian vault import |
| GET | `/api/import/status` | Import progress |
| GET | `/api/stream` | Stream blocks (with filters) |
| GET | `/api/stream/sessions` | Stream sessions with block counts |
| GET | `/api/stream/stats` | Stream statistics |
| POST | `/api/stream` | Write a stream block |
| PATCH | `/api/stream/:id/pin` | Pin/unpin stream block |
| DELETE | `/api/stream/:id` | Delete stream block |
| GET | `/api/activity` | MCP tool call log |
| GET | `/api/activity/stats` | Activity statistics |

## Configuration

**Environment variables** (`.env`):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key |
| `DATABASE_URL` | No | `postgresql://open_brain:open_brain_local@localhost:5432/open_brain` | PostgreSQL connection |
| `PORT` | No | `3100` | Web server port |

**Config file** (`~/.open-brain/config.json`): auto-created on first run with defaults for database, OpenAI models, and capture settings.

## Scripts

```bash
npm run server      # Web server + MCP HTTP
npm run dev         # MCP stdio server (for Claude Desktop)
npm run cli         # CLI tool
npm run migrate     # Run database migrations
npm run test:api    # API smoke tests (26 tests)
npm run index       # Index Obsidian vault
npm run export      # Export to JSON
npm run export:md   # Export to Markdown
npm run backup      # Database backup
```

## Tech Stack

Node.js, TypeScript (strict), PostgreSQL + pgvector, Drizzle ORM, OpenAI API, MCP SDK, Zod, Pino, Commander.js

## License

MIT
