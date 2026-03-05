# Open Brain — Product Requirements Document

## Overview

**Open Brain** — персональная система захвата, хранения и семантического поиска мыслей, идей и знаний. Второй мозг с AI-powered semantic search, доступный из любого инструмента через MCP.

**Владелец:** Макс Постников
**Статус:** PRD
**Дата:** 2026-03-03

---

## Проблема

Мысли, идеи и наблюдения возникают в разных контекстах — в Telegram, в Obsidian, в терминале, в разговоре с AI. Сейчас они теряются или разбросаны по файлам без возможности семантического поиска. Obsidian хорош для структурированных заметок, но не для быстрого захвата мыслей и не для поиска по смыслу.

## Решение

Единая система с:
- **Быстрым захватом** из нескольких точек входа (Telegram, CLI, Obsidian indexer)
- **Семантическим поиском** через embeddings (PGVector)
- **Автоматическим извлечением метаданных** (теги, тема, тип мысли)
- **MCP-интерфейсом** для доступа из Claude Desktop, Cursor, Claude Code, OpenClaw

---

## Архитектура

```
┌─────────────┐  ┌──────────────┐  ┌──────────────┐
│  Telegram    │  │   Obsidian   │  │     CLI      │
│  (OpenClaw)  │  │   Indexer    │  │  brain ...   │
└──────┬──────┘  └──────┬───────┘  └──────┬───────┘
       │                │                  │
       ▼                ▼                  ▼
┌─────────────────────────────────────────────────┐
│              Capture Pipeline                    │
│  text → embedding → metadata → store             │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│         Postgres + PGVector (local)              │
│  thoughts | embeddings | metadata | sources      │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│              MCP Server (stdio)                  │
│  tools: search, save, recent, stats, related     │
└─────────────────────────────────────────────────┘
```

---

## Технологический стек

| Компонент | Технология | Обоснование |
|-----------|-----------|-------------|
| Runtime | Node.js (TypeScript) | Экосистема MCP, быстрый старт |
| Database | PostgreSQL 17 + PGVector | Локальный, проверенный, vector search |
| Embeddings | OpenAI `text-embedding-3-small` (1536d) | $0.02/1M токенов, ключ уже есть |
| Metadata extraction | OpenAI `gpt-4o-mini` | $0.15/1M input, быстрый и дешёвый |
| MCP SDK | `@modelcontextprotocol/sdk` | Стандарт |
| CLI | Node.js bin (или simple bash wrapper) | Быстрый доступ из терминала |

---

## Модель данных

### Таблица: `thoughts`

```sql
CREATE TABLE thoughts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content       TEXT NOT NULL,
  content_type  VARCHAR(20) DEFAULT 'thought',  -- thought, note, idea, question, observation, decision
  source        VARCHAR(50) NOT NULL,            -- telegram, obsidian, cli, api
  source_ref    TEXT,                             -- message_id, file path, etc.
  
  -- AI-extracted metadata
  title         TEXT,                             -- short summary (auto-generated)
  tags          TEXT[],                           -- extracted tags
  topics        TEXT[],                           -- broader topic categories
  sentiment     VARCHAR(20),                      -- positive, negative, neutral, mixed
  
  -- Embedding
  embedding     vector(1536),                    -- text-embedding-3-small
  
  -- Timestamps
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  thought_at    TIMESTAMPTZ,                     -- when the thought occurred (may differ from created_at)
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  
  -- Obsidian link (if indexed from vault)
  obsidian_path TEXT,
  obsidian_hash TEXT                              -- content hash to detect changes
);

CREATE INDEX idx_thoughts_embedding ON thoughts USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_thoughts_tags ON thoughts USING GIN (tags);
CREATE INDEX idx_thoughts_topics ON thoughts USING GIN (topics);
CREATE INDEX idx_thoughts_source ON thoughts (source);
CREATE INDEX idx_thoughts_created ON thoughts (created_at DESC);
CREATE INDEX idx_thoughts_type ON thoughts (content_type);
```

---

## MCP Tools

### `brain_save`
Сохранить мысль.

**Input:**
```json
{
  "content": "string (required)",
  "source": "string (default: 'api')",
  "content_type": "string (optional, auto-detected)",
  "tags": "string[] (optional, auto-extracted if empty)",
  "thought_at": "ISO date (optional)"
}
```

**Поведение:**
1. Генерирует embedding через OpenAI
2. Извлекает метаданные через gpt-4o-mini (title, tags, topics, content_type, sentiment)
3. Сохраняет в Postgres
4. Возвращает `{ id, title, tags, topics }`

### `brain_search`
Семантический поиск по мыслям.

**Input:**
```json
{
  "query": "string (required)",
  "limit": "number (default: 10)",
  "min_similarity": "number (default: 0.3)",
  "filters": {
    "source": "string (optional)",
    "content_type": "string (optional)",
    "tags": "string[] (optional, ANY match)",
    "from_date": "ISO date (optional)",
    "to_date": "ISO date (optional)"
  }
}
```

**Поведение:**
1. Генерирует embedding запроса
2. Cosine similarity search в PGVector
3. Возвращает `{ results: [{ id, content, title, tags, similarity, source, created_at }] }`

### `brain_recent`
Последние мысли.

**Input:**
```json
{
  "limit": "number (default: 20)",
  "source": "string (optional)",
  "content_type": "string (optional)"
}
```

### `brain_related`
Найти связанные мысли.

**Input:**
```json
{
  "thought_id": "UUID (required)",
  "limit": "number (default: 5)"
}
```

**Поведение:** Берёт embedding указанной мысли → cosine similarity к остальным.

### `brain_stats`
Статистика базы.

**Возвращает:** общее количество мыслей, breakdown по source/type/tags, количество за последние 7/30 дней.

### `brain_delete`
Удалить мысль по ID.

---

## Capture Points

### 1. Telegram (через OpenClaw)
- Макс пишет мне: "запомни: ..." или "мысль: ..." или "brain: ..."
- Я вызываю `brain_save` через MCP
- Подтверждаю: "Сохранил: [title] | теги: [tags]"
- **Триггеры:** `запомни`, `мысль`, `brain`, `💡` в начале сообщения

### 2. CLI
```bash
brain save "Идея: сделать подкаст про AI и философию"
brain search "подкасты про AI"
brain recent --limit 5
brain stats
```

CLI — тонкая обёртка, которая вызывает MCP tools через stdio.

### 3. Obsidian Indexer
- Cron job (каждые 30 мин или file watcher)
- Сканирует указанные папки vault (например `Input/`, `Daily/`, `Blog/`)
- Индексирует новые/изменённые файлы (по content hash)
- Каждый файл = одна запись в `thoughts` с `source: 'obsidian'`
- **Не заменяет и не модифицирует** файлы в vault — только читает

**Конфигурация индексера:**
```json
{
  "vault_path": "/Users/admin/Kisadrakon",
  "index_folders": ["Input", "Daily", "Blog", "Knowledge"],
  "ignore_folders": ["zz_templates", ".obsidian", ".trash"],
  "ignore_patterns": ["*.excalidraw.md"]
}
```

---

## Конфигурация

Файл: `~/.open-brain/config.json`

```json
{
  "database": {
    "host": "localhost",
    "port": 5432,
    "database": "open_brain",
    "user": "open_brain"
  },
  "openai": {
    "embedding_model": "text-embedding-3-small",
    "metadata_model": "gpt-4o-mini"
  },
  "obsidian": {
    "vault_path": "/Users/admin/Kisadrakon",
    "index_folders": ["Input", "Daily", "Blog", "Knowledge"],
    "ignore_folders": ["zz_templates", ".obsidian", ".trash"],
    "sync_interval_minutes": 30
  },
  "capture": {
    "telegram_triggers": ["запомни", "мысль", "brain", "💡"],
    "auto_tag": true,
    "auto_title": true
  }
}
```

---

## Metadata Extraction Prompt

```
Extract metadata from this thought/note:

"""
{content}
"""

Return JSON:
{
  "title": "short descriptive title, 5-10 words",
  "content_type": "thought|note|idea|question|observation|decision",
  "tags": ["tag1", "tag2", ...],  // 2-5 relevant tags, lowercase
  "topics": ["topic1", "topic2"],  // 1-3 broader categories
  "sentiment": "positive|negative|neutral|mixed"
}
```

---

## Фазы реализации

### Phase 1 — Core (MVP)
- [ ] Postgres + PGVector setup (local)
- [ ] Schema migration
- [ ] Capture pipeline (embed + metadata + store)
- [ ] MCP server с tools: `brain_save`, `brain_search`, `brain_recent`, `brain_stats`
- [ ] CLI wrapper (`brain` command)
- [ ] Конфиг MCP в Claude Desktop

**Результат:** можно сохранять и искать мысли из Claude Desktop и CLI.

### Phase 2 — Obsidian Integration
- [ ] Obsidian indexer (cron-based)
- [ ] Content hash dedup (не переиндексировать неизменённые)
- [ ] Incremental sync
- [ ] `brain_related` tool

**Результат:** весь vault доступен через семантический поиск.

### Phase 3 — OpenClaw Integration
- [ ] MCP tool registration в OpenClaw config
- [ ] Telegram capture triggers
- [ ] Auto-save интересных мыслей из чатов (по команде)

**Результат:** Макс может сохранять мысли через Telegram.

### Phase 4 — Polish
- [ ] `brain_delete` tool
- [ ] Tag management (merge, rename)
- [ ] Web UI (optional) — простой поиск + browse
- [ ] Export (markdown, JSON)
- [ ] Backup strategy

---

## Оценка стоимости

При активном использовании (~50 мыслей/день, ~500 слов средняя длина):

| Операция | Объём/мес | Стоимость/мес |
|----------|----------|---------------|
| Embeddings (save) | ~1.5M tokens | ~$0.03 |
| Embeddings (search) | ~500K tokens | ~$0.01 |
| Metadata extraction | ~1.5M tokens | ~$0.23 |
| **Итого** | | **~$0.27/мес** |

Obsidian indexing (разовый, ~5000 файлов × ~500 слов):
- Embeddings: ~2.5M tokens → ~$0.05
- Metadata: ~2.5M tokens → ~$0.38
- **Разовый:** ~$0.43

---

## Требования к окружению

- PostgreSQL 17 (уже установлен? проверить)
- PGVector extension
- Node.js 20+ (есть)
- OpenAI API key (есть)

---

## Открытые вопросы

1. **Chunking для длинных Obsidian-файлов** — разбивать на параграфы или хранить целиком? Длинные файлы (>2000 слов) лучше чанкить для точности поиска.
2. **Дедупликация** — что если одна и та же мысль сохранена через Telegram и уже есть в Obsidian? Cosine similarity check при сохранении?
3. **Privacy** — всё локально кроме API calls к OpenAI. Устраивает?
4. **Vault scope** — какие папки в Obsidian индексировать? Предложил Input, Daily, Blog, Knowledge. Добавить Personal? PRO?

---

*PRD готов к review. После утверждения — можно запускать coding agent на Phase 1.*
