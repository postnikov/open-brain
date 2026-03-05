# Open Brain — Документация

**Open Brain** — персональная система захвата, хранения и семантического поиска мыслей, идей и знаний. Второй мозг с AI-powered семантическим поиском, доступный из CLI, Claude Desktop, Telegram (через OpenClaw) и Web UI.

---

## Содержание

1. [Обзор системы](#обзор-системы)
2. [Архитектура](#архитектура)
3. [Установка и настройка](#установка-и-настройка)
4. [CLI — работа из терминала](#cli--работа-из-терминала)
5. [MCP Tools — интеграция с Claude](#mcp-tools--интеграция-с-claude)
6. [Web UI](#web-ui)
7. [REST API](#rest-api)
8. [Telegram — интеграция с OpenClaw](#telegram--интеграция-с-openclaw)
9. [Индексация Obsidian](#индексация-obsidian)
10. [Экспорт и бэкап](#экспорт-и-бэкап)
11. [Конфигурация](#конфигурация)
12. [База данных](#база-данных)
13. [AI Pipeline — как работает обработка](#ai-pipeline--как-работает-обработка)
14. [HTTP-сервер и автозапуск](#http-сервер-и-автозапуск)
15. [Стоимость использования](#стоимость-использования)
16. [Структура проекта](#структура-проекта)

---

## Обзор системы

Open Brain решает одну проблему: **мысли, идеи и наблюдения теряются**. Они возникают в разных контекстах — в Telegram, в Obsidian, в разговоре с AI — и разбрасываются по файлам без возможности поиска по смыслу.

Open Brain даёт:
- **Быстрый захват** из нескольких точек входа (CLI, Claude Desktop, Telegram, Obsidian)
- **Семантический поиск** — ищет по смыслу, а не по ключевым словам
- **Кросс-языковой поиск** — русский запрос находит английские заметки и наоборот
- **Автоматическое извлечение метаданных** — title, теги, темы, тип, настроение
- **Web UI** для визуального просмотра и поиска

---

## Архитектура

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Telegram   │  │ Claude       │  │     CLI      │  │   Web UI     │
│  (OpenClaw)  │  │ Desktop      │  │  brain ...   │  │ localhost    │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │                  │
       │ bash            │ stdio           │ direct           │ REST API
       ▼                 ▼                 ▼                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Capture Pipeline                                │
│     text → [embedding + metadata] параллельно → store               │
│                                                                     │
│  ┌─────────────────┐  ┌──────────────────────┐                      │
│  │ OpenAI Embeddings│  │ OpenAI Metadata (GPT) │                     │
│  │ text-embedding-  │  │ gpt-4o-mini           │                     │
│  │ 3-small (1536d)  │  │ title, tags, topics,  │                     │
│  └─────────────────┘  │ type, sentiment       │                     │
│                        └──────────────────────┘                      │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│              PostgreSQL + pgvector (local)                          │
│                                                                     │
│  thoughts: content, embedding(1536), title, tags, topics,           │
│            sentiment, source, content_type, timestamps              │
│                                                                     │
│  Indexes: HNSW (vector cosine), GIN (tags), B-tree (source, date)  │
└─────────────────────────────────────────────────────────────────────┘
```

**Ключевые решения:**
- Embedding и metadata извлекаются **параллельно** (`Promise.all`) — экономия времени
- Логирование идёт на **stderr** (критично для MCP stdio протокола)
- Векторный индекс **HNSW** (работает на пустой таблице, в отличие от IVFFlat)
- Паттерн **factory functions** — иммутабельность, dependency injection

---

## Установка и настройка

### Требования
- Node.js 20+ (проверено на v25.6.1)
- PostgreSQL 14+ с расширением pgvector
- OpenAI API key

### Установка

```bash
cd /Users/admin/Vibe/open-brain
npm install
```

### Настройка базы данных

```bash
# Создать пользователя и базу (от имени admin)
psql -U admin -d postgres -c "CREATE USER open_brain WITH PASSWORD 'open_brain_local';"
psql -U admin -d postgres -c "CREATE DATABASE open_brain OWNER open_brain;"

# Включить расширение pgvector (нужен superuser)
psql -U admin -d open_brain -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Запустить миграции
npm run migrate
```

### Переменные окружения

Файл `.env` в корне проекта:

```
OPENAI_API_KEY=sk-proj-...
DATABASE_URL=postgresql://open_brain:open_brain_local@localhost:5432/open_brain
```

`OPENAI_API_KEY` — обязательна. `DATABASE_URL` — опциональна (по умолчанию берётся из конфига).

---

## CLI — работа из терминала

Команда `brain` доступна глобально (symlink в `/usr/local/bin/brain`).

### Сохранить мысль

```bash
brain save "Идея: запустить подкаст о продуктовом мышлении"
brain save "Клиент сказал что главная боль — онбординг" --tags "клиенты,онбординг"
brain save "Нужно разобраться как работает RAG" --type question
brain save "Мысль из чата" --source telegram
```

| Флаг | Описание | По умолчанию |
|------|----------|-------------|
| `-s, --source` | Источник (cli, telegram, api, obsidian) | `cli` |
| `-t, --type` | Тип (thought, note, idea, question, observation, decision) | авто |
| `--tags` | Теги через запятую | авто |

При сохранении происходит:
1. Генерация embedding (OpenAI, text-embedding-3-small)
2. Извлечение метаданных (gpt-4o-mini) — title, tags, topics, тип, sentiment
3. Запись в PostgreSQL

### Семантический поиск

```bash
brain search "как выделиться на рынке труда"
brain search "AI and consciousness" --limit 5
brain search "философия" --min-similarity 0.4
```

| Флаг | Описание | По умолчанию |
|------|----------|-------------|
| `-l, --limit` | Максимум результатов | `10` |
| `-m, --min-similarity` | Минимальный порог похожести (0-1) | `0.3` |

Поиск работает **по смыслу**: запрос "роботы будущего" найдёт заметку про "humanoid robots". Работает кросс-языково.

### Последние записи

```bash
brain recent
brain recent --limit 5
brain recent --source obsidian
```

| Флаг | Описание | По умолчанию |
|------|----------|-------------|
| `-l, --limit` | Количество записей | `20` |
| `-s, --source` | Фильтр по источнику | все |

### Статистика

```bash
brain stats
```

Показывает: общее количество, активность за 7/30 дней, разбивка по источникам и типам.

### Теги

```bash
# Список всех тегов с количеством использований
brain tags

# Переименовать или объединить теги
brain tag-rename "job_search" "job search"
```

### Удаление

```bash
brain delete <UUID>
```

---

## MCP Tools — интеграция с Claude

Open Brain предоставляет 8 MCP tools, доступных из Claude Desktop (stdio) и через HTTP:

### brain_save
Сохранить мысль с автоматическим извлечением метаданных.

| Параметр | Тип | Обязательный | Описание |
|----------|-----|-------------|----------|
| `content` | string | да | Текст мысли |
| `source` | string | нет (api) | Источник: api, cli, telegram, obsidian |
| `content_type` | string | нет | thought, note, idea, question, observation, decision |
| `tags` | string[] | нет | Ручные теги (если пусто — извлекаются автоматически) |
| `thought_at` | string | нет | Когда возникла мысль (ISO дата) |

### brain_search
Семантический поиск по всем мыслям.

| Параметр | Тип | Обязательный | Описание |
|----------|-----|-------------|----------|
| `query` | string | да | Поисковый запрос |
| `limit` | number | нет (10) | Максимум результатов (1-50) |
| `min_similarity` | number | нет (0.3) | Минимальная похожесть (0-1) |
| `source` | string | нет | Фильтр по источнику |
| `content_type` | string | нет | Фильтр по типу |
| `tags` | string[] | нет | Фильтр по тегам (ANY match) |
| `from_date` | string | нет | Начало периода (ISO) |
| `to_date` | string | нет | Конец периода (ISO) |

### brain_related
Найти мысли, связанные с указанной (по её embedding, без дополнительного API-вызова).

| Параметр | Тип | Обязательный | Описание |
|----------|-----|-------------|----------|
| `thought_id` | UUID | да | ID мысли |
| `limit` | number | нет (5) | Максимум связанных (1-20) |

### brain_recent
Последние мысли с фильтрами.

| Параметр | Тип | Обязательный | Описание |
|----------|-----|-------------|----------|
| `limit` | number | нет (20) | Количество (1-100) |
| `source` | string | нет | Фильтр по источнику |
| `content_type` | string | нет | Фильтр по типу |

### brain_stats
Статистика базы. Без параметров.

### brain_tags
Список всех тегов с количеством. Без параметров.

### brain_tag_rename
Переименование или объединение тегов.

| Параметр | Тип | Обязательный | Описание |
|----------|-----|-------------|----------|
| `old_tag` | string | да | Тег для переименования |
| `new_tag` | string | да | Новое имя (или существующий тег для мержа) |

### brain_delete
Удаление мысли.

| Параметр | Тип | Обязательный | Описание |
|----------|-----|-------------|----------|
| `thought_id` | UUID | да | ID мысли для удаления |

### Claude Desktop

Конфигурация уже добавлена в `~/Library/Application Support/Claude/claude_desktop_config.json`. После рестарта Claude Desktop все tools доступны. В чате с Claude можно говорить:

- *"Запомни: лучший способ учиться — учить других"*
- *"Найди мои мысли про карьеру и личный бренд"*
- *"Что я записывал за последнюю неделю?"*
- *"Покажи связанные мысли для этой записи"*

---

## Web UI

Доступен по адресу: **http://localhost:3100**

Три вкладки:
- **Search** — семантический поиск с debounce (400мс), результаты с процентом похожести
- **Recent** — последние 50 записей с превью
- **Stats** — визуальные карточки: total, 7/30 дней, по источникам, по типам

Тёмная тема. Мысли с длинным контентом сворачиваются, клик разворачивает.

---

## REST API

Все endpoints на `http://localhost:3100/api/`. CORS включён (`Access-Control-Allow-Origin: *`).

### GET /api/search

Семантический поиск.

| Параметр | Обязательный | По умолчанию | Описание |
|----------|-------------|-------------|----------|
| `q` | да | — | Текст запроса |
| `limit` | нет | 10 | Максимум результатов |
| `min_similarity` | нет | 0.3 | Порог похожести |

```bash
curl "http://localhost:3100/api/search?q=storytelling&limit=5"
```

### GET /api/recent

Последние записи.

| Параметр | Обязательный | По умолчанию | Описание |
|----------|-------------|-------------|----------|
| `limit` | нет | 20 | Количество |
| `source` | нет | все | Фильтр по источнику |

```bash
curl "http://localhost:3100/api/recent?limit=10&source=obsidian"
```

### GET /api/stats

Статистика. Без параметров.

```bash
curl http://localhost:3100/api/stats
```

### GET /api/tags

Все теги с количеством. Без параметров.

```bash
curl http://localhost:3100/api/tags
```

### GET /health

Healthcheck.

```bash
curl http://localhost:3100/health
# {"status":"ok","sessions":0}
```

---

## Telegram — интеграция с OpenClaw

OpenClaw (Вайб-Демон) интегрирован с Open Brain через CLI-обёртку `brain`.

### Автоматические триггеры

Когда Макс пишет в Telegram сообщение, начинающееся с триггера, OpenClaw **автоматически сохраняет** в Open Brain:

| Триггер | Пример |
|---------|--------|
| `запомни` | "запомни: лучшая стратегия — сначала аудитория" |
| `мысль` | "мысль: AI заменит не людей, а тех кто не использует AI" |
| `brain` | "brain: идея для подкаста про философию" |
| `💡` | "💡 сделать серию постов про агентов" |

Действие:
1. Убрать триггерное слово из текста
2. `brain save "очищенный текст" --source telegram`
3. Ответ: `🧠 Сохранил: [title] | теги: [tags]`

### Поиск через Telegram

Говоришь Вайб-Демону: *"что я думал про...", "найди мои мысли о...", "что в brain про..."* — он вызовет `brain search`.

### Конфигурация

- Skill: `~/.clawdbot/skills/open-brain/SKILL.md`
- CLI обёртка: `/usr/local/bin/brain` → `~/clawd/scripts/brain.sh`
- Инструкции: `~/clawd/TOOLS.md` (секция Open Brain)

---

## Индексация Obsidian

Импорт markdown-файлов из Obsidian vault в Open Brain.

```bash
# Индексировать папку Knowledge
npm run index Knowledge

# Индексировать другие папки
npm run index Daily
npm run index Input
npm run index Blog
```

### Как работает

1. Сканирует `~/Kisadrakon/{folder}` рекурсивно на `.md` файлы
2. Пропускает файлы: `*.excalidraw.md`, `*_Index.md`, файлы < 20 символов
3. Вычисляет SHA256-хеш контента для дедупликации
4. Если хеш уже есть в базе — пропускает (файл не изменился)
5. Если путь уже есть но хеш другой — обновляет (файл изменился)
6. Параллельно генерирует embedding и метаданные (3 файла одновременно)
7. Сохраняет с `source: 'obsidian'` и `obsidian_path`, `obsidian_hash`

### Текущее состояние

Проиндексировано: **381 файл** из `Knowledge/` — AI, Career, Strategy, Philosophy, Storytelling, Tools и ещё 25 папок.

---

## Экспорт и бэкап

### Экспорт в JSON

```bash
npm run export
# → export/open-brain-export-2026-03-04.json
```

Формат: массив объектов с полями `id, content, title, content_type, source, tags, topics, sentiment, created_at, thought_at`.

### Экспорт в Markdown

```bash
npm run export:md
# → export/{slug}.md (по файлу на мысль)
```

Каждый файл содержит YAML-frontmatter (id, title, source, type, tags, created) и контент.

### Бэкап базы данных

```bash
npm run backup
# → ~/.open-brain/backups/open-brain-2026-03-04_0146.sql.gz
```

- Формат: `pg_dump` + gzip
- Директория: `~/.open-brain/backups/`
- Ротация: хранит последние 10 бэкапов, старые удаляются

### Восстановление из бэкапа

```bash
gunzip -c ~/.open-brain/backups/open-brain-2026-03-04_0146.sql.gz \
  | PGPASSWORD=open_brain_local psql -U open_brain -d open_brain
```

---

## Конфигурация

### Файл конфигурации

`~/.open-brain/config.json` — создаётся автоматически при первом запуске.

```json
{
  "database": {
    "host": "localhost",
    "port": 5432,
    "database": "open_brain",
    "user": "open_brain",
    "password": "open_brain_local"
  },
  "openai": {
    "embedding_model": "text-embedding-3-small",
    "metadata_model": "gpt-4o-mini"
  },
  "capture": {
    "auto_tag": true,
    "auto_title": true
  }
}
```

### Переменные окружения

| Переменная | Обязательная | Описание |
|-----------|-------------|----------|
| `OPENAI_API_KEY` | да | Ключ OpenAI API |
| `DATABASE_URL` | нет | PostgreSQL connection string (перекрывает config.json) |
| `PORT` | нет | Порт HTTP-сервера (по умолчанию 3100) |
| `LOG_LEVEL` | нет | Уровень логирования pino (по умолчанию info) |

---

## База данных

### Таблица `thoughts`

| Столбец | Тип | Описание |
|---------|-----|----------|
| `id` | UUID | Уникальный идентификатор (auto) |
| `content` | TEXT | Полный текст мысли |
| `content_type` | VARCHAR(20) | thought, note, idea, question, observation, decision |
| `source` | VARCHAR(50) | api, cli, telegram, obsidian |
| `source_ref` | TEXT | Ссылка на оригинал (путь к файлу, message_id) |
| `title` | TEXT | Краткое описание (авто-извлечённое) |
| `tags` | TEXT[] | Массив тегов |
| `topics` | TEXT[] | Массив широких тем |
| `sentiment` | VARCHAR(20) | positive, negative, neutral, mixed |
| `embedding` | vector(1536) | Векторное представление (OpenAI) |
| `created_at` | TIMESTAMPTZ | Когда сохранено |
| `thought_at` | TIMESTAMPTZ | Когда мысль возникла (может отличаться) |
| `updated_at` | TIMESTAMPTZ | Последнее обновление |
| `obsidian_path` | TEXT | Путь в vault (для Obsidian-файлов) |
| `obsidian_hash` | TEXT | SHA256 контента (дедупликация) |

### Индексы

| Индекс | Тип | Столбец |
|--------|-----|---------|
| `idx_thoughts_embedding_hnsw` | HNSW (vector_cosine_ops) | embedding |
| `idx_thoughts_tags` | GIN | tags |
| `idx_thoughts_source` | B-tree | source |
| `idx_thoughts_created` | B-tree | created_at DESC |
| `idx_thoughts_type` | B-tree | content_type |

---

## AI Pipeline — как работает обработка

При сохранении мысли запускается pipeline из двух параллельных AI-вызовов:

### 1. Embedding (text-embedding-3-small)

- Модель: `text-embedding-3-small` (OpenAI)
- Размерность: 1536
- Стоимость: ~$0.02 / 1M токенов
- Результат: числовой вектор, представляющий семантику текста
- Используется для cosine similarity поиска

### 2. Metadata extraction (gpt-4o-mini)

- Модель: `gpt-4o-mini` (OpenAI, JSON mode)
- Temperature: 0.3
- Стоимость: ~$0.15 / 1M input токенов
- Извлекает:

| Поле | Тип | Описание |
|------|-----|----------|
| `title` | string | Краткий заголовок, 5-10 слов |
| `content_type` | enum | thought, note, idea, question, observation, decision |
| `tags` | string[] | 2-5 тегов, lowercase |
| `topics` | string[] | 1-3 широких категории |
| `sentiment` | enum | positive, negative, neutral, mixed |

### Поиск

1. Запрос пользователя → embedding через ту же модель
2. Cosine distance (`<=>` оператор pgvector) между запросом и всеми мыслями
3. Фильтрация по `min_similarity`
4. Сортировка по убыванию похожести

`brain_related` не делает API-вызов — берёт уже сохранённый embedding мысли.

---

## HTTP-сервер и автозапуск

### Два режима работы

| Режим | Entry point | Транспорт | Для чего |
|-------|------------|-----------|----------|
| stdio | `src/index.ts` | StdioServerTransport | Claude Desktop |
| HTTP | `src/server.ts` | StreamableHTTPServerTransport | Web UI, REST API, удалённый доступ |

### Endpoints HTTP-сервера

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/` | Web UI |
| GET | `/health` | Healthcheck |
| GET | `/api/search` | REST API поиск |
| GET | `/api/recent` | REST API последние |
| GET | `/api/stats` | REST API статистика |
| GET | `/api/tags` | REST API теги |
| POST | `/mcp` | MCP JSON-RPC (новая сессия) |
| GET | `/mcp` | MCP SSE stream (с Mcp-Session-Id) |
| DELETE | `/mcp` | Закрыть MCP сессию |

### Автозапуск (launchd)

HTTP-сервер запускается автоматически при логине через macOS launchd.

**Plist:** `~/Library/LaunchAgents/com.open-brain.server.plist`
**Логи:** `~/.open-brain/server.log`
**Авторестарт:** да, через 10 секунд при падении

Управление:

```bash
# Статус
launchctl list | grep open-brain

# Остановить
launchctl unload ~/Library/LaunchAgents/com.open-brain.server.plist

# Запустить
launchctl load ~/Library/LaunchAgents/com.open-brain.server.plist

# Перезапустить (после обновления кода)
launchctl unload ~/Library/LaunchAgents/com.open-brain.server.plist && \
launchctl load ~/Library/LaunchAgents/com.open-brain.server.plist

# Логи
tail -f ~/.open-brain/server.log
```

---

## Стоимость использования

### Ежедневное использование (~20 мыслей + ~10 поисков)

| Операция | Токены/день | Стоимость/день |
|----------|------------|---------------|
| Embeddings (save) | ~10K | ~$0.0002 |
| Embeddings (search) | ~5K | ~$0.0001 |
| Metadata extraction | ~10K | ~$0.0015 |
| **Итого** | | **~$0.002/день** |

### Индексация Obsidian (разовая, ~400 файлов)

| Операция | Токены | Стоимость |
|----------|--------|-----------|
| Embeddings | ~500K | ~$0.01 |
| Metadata | ~500K | ~$0.08 |
| **Итого** | | **~$0.09** |

`brain_related` и `brain_stats` не вызывают OpenAI API — бесплатны.

---

## Структура проекта

```
open-brain/
├── docs/
│   ├── PRD.md                 # Product Requirements Document
│   └── README.md              # Эта документация
├── src/
│   ├── index.ts               # MCP server (stdio) — для Claude Desktop
│   ├── server.ts              # HTTP server — Web UI, REST API, MCP HTTP
│   ├── cli.ts                 # CLI — команда brain
│   ├── bootstrap.ts           # Инициализация сервисов
│   ├── config/
│   │   ├── schema.ts          # Zod-схема конфигурации
│   │   ├── defaults.ts        # Значения по умолчанию
│   │   └── loader.ts          # Загрузка ~/.open-brain/config.json
│   ├── db/
│   │   ├── schema.ts          # Drizzle-схема таблицы thoughts
│   │   ├── connection.ts      # PostgreSQL pool + pgvector
│   │   └── migrate.ts         # SQL миграции
│   ├── repository/
│   │   ├── types.ts           # Интерфейсы Thought, ThoughtsRepository
│   │   └── thoughts.ts        # Реализация репозитория
│   ├── pipeline/
│   │   ├── embeddings.ts      # OpenAI embedding service
│   │   ├── metadata.ts        # OpenAI metadata extraction
│   │   └── capture.ts         # Capture pipeline (embed + metadata)
│   ├── tools/
│   │   └── register.ts        # Регистрация 8 MCP tools
│   ├── web/
│   │   ├── ui.ts              # HTML Web UI (single page)
│   │   └── api.ts             # REST API handlers
│   ├── shared/
│   │   ├── logger.ts          # Pino logger (stderr)
│   │   └── errors.ts          # Классы ошибок
│   └── scripts/
│       ├── index-obsidian.ts   # Индексатор Obsidian vault
│       ├── export.ts           # Экспорт JSON/Markdown
│       └── backup.sh           # pg_dump бэкап
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── .env                        # OPENAI_API_KEY, DATABASE_URL
└── .env.example
```

### npm scripts

| Скрипт | Описание |
|--------|----------|
| `npm run dev` | Запуск MCP-сервера (stdio) |
| `npm run server` | Запуск HTTP-сервера |
| `npm run cli` | Запуск CLI |
| `npm run migrate` | Миграции базы данных |
| `npm run index` | Индексация Obsidian |
| `npm run export` | Экспорт в JSON |
| `npm run export:md` | Экспорт в Markdown |
| `npm run backup` | Бэкап базы данных |
| `npm run build` | Компиляция TypeScript |
| `npm run test` | Запуск тестов |

---

*Документация актуальна на 4 марта 2026. Версия: 0.1.0*
