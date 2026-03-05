# Open Brain

Personal thought capture and semantic search system. A second brain with AI-powered embeddings, accessible via web UI, CLI, and MCP (Model Context Protocol).

## Quick Start (Docker)

```bash
git clone https://github.com/maxpostnikov/open-brain.git
cd open-brain
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY
docker compose up
```

Open http://localhost:3100

## Quick Start (without Docker)

Requires Node.js 20+, PostgreSQL 14+ with [pgvector](https://github.com/pgvector/pgvector).

```bash
git clone https://github.com/maxpostnikov/open-brain.git
cd open-brain
./setup.sh
npm run server
```

Open http://localhost:3100

## Features

**Capture** thoughts from any source with automatic embedding and metadata extraction (title, tags, topics, sentiment).

**Semantic Search** finds thoughts by meaning, not just keywords. Powered by OpenAI embeddings + pgvector cosine similarity.

**Web UI** with 7 tabs:
- **Search** — semantic search with similarity scores
- **Timeline** — see how your thinking evolves on a topic over time
- **Recent** — latest thoughts with source filters
- **Review** — weekly reflection: revisit past thoughts (still true? evolved? let go?)
- **Compost** — thoughts you're letting go, dissolving in 30 days
- **Duplicates** — find and resolve near-duplicate thoughts
- **Stats** — counts by source, type, orphan tags

**Thought Controls:**
- Inline editing with automatic re-embedding
- Fade/Amplify — adjust thought weight in search results
- Epistemic status — mark thoughts as hypothesis, conviction, fact, outdated, or question
- Batch operations — select multiple, bulk delete/compost/tag/status
- Custom modal dialogs (no browser alerts)

**MCP Server** for Claude Desktop, Cursor, and other MCP clients:
- `brain_save` — capture a thought
- `brain_search` — semantic search
- `brain_recent` — latest thoughts
- `brain_stats` — database statistics

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

## Claude Desktop Configuration

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
npm run test:api    # API smoke tests (24 tests)
npm run index       # Index Obsidian vault
npm run export      # Export to JSON
npm run export:md   # Export to Markdown
npm run backup      # Database backup
```

## Tech Stack

Node.js, TypeScript (strict), PostgreSQL + pgvector, Drizzle ORM, OpenAI API, MCP SDK, Zod, Pino, Commander.js

## License

MIT
