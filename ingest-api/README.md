# ingest-api

Internal job ingestion + search API for the job scraper repository.

```
GitHub Actions -> Python scraper -> POST /internal/jobs/ingest -> Express -> MongoDB
                                                                        -> MongoDB Search
```

No queue, no Redis, no workers in v1: the scraper POSTs batches over HTTP,
Express bulk-upserts into MongoDB, and search reads straight from MongoDB /
Atlas Search.

## Layout

```
ingest-api/
├── package.json / tsconfig*.json / vitest.config.ts
├── .env.example
├── search-index/jobs-search-index.json   # Atlas Search index definition
├── src/
│   ├── app.ts / server.ts
│   ├── config/        # env.ts (typed config), database.ts (connect/shutdown)
│   ├── middleware/    # auth (Bearer API key), error (consistent shape)
│   ├── utils/         # logger
│   ├── modules/jobs/
│   │   ├── jobs.{types,validation,model,service,controller,routes}.ts
│   │   └── search/
│   │       └── jobs.search.{types,validation,service,controller}.ts
│   └── scripts/create-search-index.ts
└── tests/
```

## Prerequisites

- Node.js >= 20, npm
- MongoDB: Atlas (for `$search`) or any MongoDB >= 6 for ingest + text fallback.
  Tests use an in-memory server backed by a system `mongod` when available.

## Setup

```bash
cd ingest-api
npm install
cp .env.example .env   # then set MONGODB_URI and INGEST_API_KEY
```

## Environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development` \| `test` \| `production` |
| `PORT` | no | `3000` | HTTP port |
| `MONGODB_URI` | yes | — | Atlas or self-managed connection string |
| `INGEST_API_KEY` | yes | — | Bearer key for `/internal/*` |
| `MAX_INGEST_BATCH_SIZE` | no | `500` | Max jobs per ingest request |
| `MONGODB_SEARCH_MODE` | no | `atlas` | `atlas` \| `text` \| `auto` (see below) |
| `MONGODB_SEARCH_INDEX_NAME` | no | `jobs_search` | Atlas Search index name |
| `JSON_BODY_LIMIT` | no | `2mb` | Body limit; fits ~500 jobs |

## Run

```bash
npm run dev     # watch mode
npm run build && npm start
```

## Atlas Search index setup

Normal MongoDB indexes are created automatically at startup (`Job.syncIndexes()`).
The Search index is managed separately and is never auto-created on boot:

```bash
npm run create-search-index:dry-run  # print definition + manual Atlas UI steps
npm run create-search-index          # try driver-based creation, else print steps
```

Manual path: Atlas -> Database -> Search Indexes -> Create Search Index ->
JSON editor -> name `jobs_search` -> paste the `definition` object from
`search-index/jobs-search-index.json` -> wait for READY.

If `MONGODB_SEARCH_MODE=atlas` and the index is missing, search fails with a
clear `503 SEARCH_UNAVAILABLE` (never a raw driver error, never a silent scan).

## API

Auth for all `/internal/*` routes: `Authorization: Bearer <INGEST_API_KEY>`.
`GET /health` is public and returns `{ "status": "ok" }`.
Errors always look like `{ "success": false, "error": { "code", "message" } }`.

### POST /internal/jobs/ingest

Accepts the scraper's exact field names (no scraper changes needed):

```json
{
  "runId": "github-actions-run-123",
  "jobs": [
    {
      "Company": "Disney",
      "Title": "Software Engineer",
      "Location": "Orlando, FL",
      "Department": "",
      "URL": "https://disney.wd5.myworkdayjobs.com/...",
      "Updated": "2026-09-28",
      "Source": "Workday"
    }
  ]
}
```

Response:

```json
{
  "success": true,
  "runId": "github-actions-run-123",
  "received": 500,
  "inserted": 420,
  "updated": 80,
  "sources": { "Greenhouse": 230, "Workday": 270 }
}
```

- `received` = raw jobs in the request; `inserted`/`updated` come straight from
  the `bulkWrite` result (`upsertedCount`/`modifiedCount`), so a retry of
  identical data reports `inserted: 0` and never duplicates.
- Identity is `(source, url)` with a unique compound index; in-batch dupes are
  collapsed before the write (last occurrence wins).
- `Location`/`Department` may be empty; `Updated` is best-effort (invalid/empty
  becomes `null` and never rejects the job).

### GET /internal/jobs/search

| Param | Meaning |
|---|---|
| `q` | Free-text query across title/company/location/department (optional, max 200 chars) |
| `source` | `Greenhouse`/`Workday`, comma-separated for multi (`source=Workday,Greenhouse`) |
| `company`, `location`, `department` | Exact (case-insensitive) filters, comma-separated for multi |
| `page` | >= 1 (default 1) |
| `limit` | 1–50 (default 20) |
| `sort` | `relevance` \| `updated` \| `company` \| `title` (default: `relevance` with `q`, else `updated`) |

Filters are exact matches: `?location=London` matches stored `"London"` (any
case), not `"London, UK"`. AND-combined with `q`, all inside MongoDB.

Response:

```json
{
  "success": true,
  "data": [
    {
      "id": "...",
      "company": "Disney",
      "title": "Software Engineer",
      "location": "Orlando, FL",
      "department": "Engineering",
      "url": "https://...",
      "updated": "2026-09-28T00:00:00.000Z",
      "source": "Workday",
      "score": 12.42
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 250, "totalPages": 13, "hasNextPage": true }
}
```

`score` appears only when `q` was given and the backend produced a real score.

### GET /internal/jobs/search/suggestions

`GET /internal/jobs/search/suggestions?q=soft&limit=10` (limit 1–10, default 10).
Atlas-only; returns `{ "success": true, "suggestions": [{ "type", "value" }] }`
with types `title`/`company`/`location`, round-robined and bounded. In text
mode it returns `501 SUGGESTIONS_UNAVAILABLE` rather than a fake fallback.

## Strategies

- **Bulk ingestion**: one `bulkWrite` with `updateOne` upserts on
  `{source, url}`, `ordered: false`, single round-trip; no per-job queries or
  inserts. Unique index makes retries from concurrent runners safe.
- **Ranking**: `$search` `compound.should` with boosts title x3, company x2,
  location/department x1, `minimumShouldMatch: 1`; score materialized for sort.
- **Fuzzy**: `fuzzy: { maxEdits: 2, prefixLength: 1 }` on title/company,
  `maxEdits: 1` on location/department — typo-tolerant without drowning results.
- **Pagination**: `$facet` (`$count` + `$skip`/`$limit`) in Atlas mode;
  `countDocuments` + `skip`/`limit` in text mode. Node.js only ever holds one page.
- **Filtering**: exact `$match`/`find` + `{locale:"en", strength:2}` collation,
  backed by the normal indexes; identical semantics in every search mode.
- **Sorting**: closed allow-list only; client input can never inject a sort/sort
  expression (or any other MongoDB operator).

## Search modes

- `atlas` (default): `$search` aggregation; strict — missing index/deployment
  yields `503 SEARCH_UNAVAILABLE` with setup guidance.
- `text`: traditional compound text index (`jobs_text_fallback`, weights
  title 10 / company 5 / location 2 / department 1). No fuzzy matching, no
  autocomplete, `$text` term semantics instead of analyzed relevance.
- `auto`: try Atlas, fall back to text (with a warning log) when `$search` is
  unavailable. Same text-mode capability caveats apply after fallback.

## Tests

```bash
npm test            # full suite (in-memory MongoDB, text mode)
npm run test:watch  # watch mode
```

- `tests/jobs.ingest.test.ts` — health, Greenhouse/Workday/mixed batches, auth,
  every validation failure, over-batch, in-batch dupes, double-submit, counts.
- `tests/jobs.search.test.ts` — 20 text-mode integration cases (filters, q,
  pagination, sorting, validation, determinism, result shape).
- `tests/jobs.search.pipeline.test.ts` — Atlas pipeline unit tests (boosts,
  fuzzy, filters, `$facet`, no-`$search`-without-`q`) with no database.
- `tests/atlas.e2e.test.ts` — skipped unless `TEST_ATLAS_URI` is set; runs real
  `$search` fuzzy + suggestions against Atlas (needs the search index).

## Assumptions

- `runId` is a log/correlation field only; it is not stored on job documents.
- `received` counts raw jobs; `inserted + updated` may be lower when a batch
  contains in-batch dupes or jobs identical to stored data.
- Resubmitted jobs always advance `scrapedAt`/`updatedAt`, so a full retry
  typically reports `updated: N`, `inserted: 0`.
- `sort=relevance` without `q` degrades to `updated` (documented, tested).
- Suggestions are fixed to title/company/location per the spec.

## Limitations (from the current scraper data model)

- No descriptions, skills, qualifications, or responsibilities exist yet, so
  search covers company/title/location/department/source only. The index JSON
  and `buildAtlasSearchStage` are the two places to extend when those fields
  land (add mappings + a `should` clause); no architecture change needed.
- Workday jobs always carry an empty department today; department search over
  Workday data becomes useful only once the scraper fills it.
- `Updated` is a free-form string upstream; unparseable values are stored as
  `null` and sort last under `sort=updated`.
