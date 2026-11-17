# ComicVine API Local

> **Non-commercial use only.** This project is intended for personal, educational, and other non-commercial use. It is not affiliated with, endorsed by, or sponsored by ComicVine / GameSpot / Fandom, and it must not be used to power any commercial product, service, or paid offering.

> **Credit.** All data in this project is sourced from [ComicVine](https://comicvine.gamespot.com) (a [GameSpot](https://www.gamespot.com) / Fandom service). The [ComicVine API](https://comicvine.gamespot.com/api/) is used to populate `localcv.db`, and all content remains the property of its respective owners. If you use this project, please link back to [comicvine.gamespot.com](https://comicvine.gamespot.com) and give credit to ComicVine.

A local, read-only mirror of the ComicVine API backed by `localcv.db`.
It uses Node.js built-in HTTP and SQLite modules, so no npm dependencies are required.

## Documentation

- [docs/architecture.md](docs/architecture.md) — request flow, sync pipeline, and database schema.
- [stack.md](stack.md) — the technology stack: runtime, Node built-ins, processes, data layer, and deployment.
- [docs/dev-notes.md](docs/dev-notes.md) — a running diary of decisions, gotchas, and experiments.

## Requirements

- Node.js 26.13 or newer
- The SQLite database in the project root, or a path supplied through `COMICVINE_DB_PATH`. The database is gitignored (multi-GB), so a fresh clone has none: run a sync to build one (see [Syncing Data](#syncing-data); requires a `COMICVINE_API_KEY`) or place an existing `localcv.db` in the project root. Note: on a fresh database the four legacy tables (`cv_publisher`/`cv_volume`/`cv_issue`/`cv_person`) are not created by `migrate.js` (DB-3 in `TODO.md`), so a fresh sync skips those endpoints and the corresponding resources return 404 — placing an existing `localcv.db` is the reliable way to get all eleven.

## Run

```powershell
npm start
```

`npm start` loads settings from `.env` (values already set in the process environment take precedence). The server listens at `http://127.0.0.1:3333` by default. Set `HOST` to bind to another interface and `PORT` to use another port. Set `COMICVINE_DB_PATH` to use a different SQLite database. For LAN access, set `HOST` to the machine's LAN address. `.env.example` lists the defaults.

Paging limits follow ComicVine's defaults: list endpoints default to 100 and the search endpoint defaults to 10, with a maximum page size of 100. A requested `limit` is clamped to the maximum. Three environment variables override these controls: `COMICVINE_MAX_LIMIT` raises the maximum page size, `COMICVINE_DEFAULT_LIMIT` overrides the default for list endpoints, and `COMICVINE_SEARCH_DEFAULT_LIMIT` overrides the default for the search endpoint. When unset, each falls back to the values above. When `COMICVINE_FORCED_LIMIT` is set, that page size is applied to the **search endpoint only** and takes precedence over a client's `?limit=` (still clamped to the maximum); it does not affect list or detail endpoints. The same controls are available as the `maxLimit`, `defaultLimit`, `searchDefaultLimit`, and `searchForcedLimit` options of `createApiServer`.

Each completed request is logged as JSON with its method, path, query, status, and duration. Every entry carries a `level` (`debug`/`info`/`warn`/`error`) and an ISO-8601 `timestamp`; the default logger prefixes each line with a readable `[timestamp] [LEVEL]` before the JSON body, writing `warn`/`error` entries to stderr and everything else to stdout. Credential-like query parameters such as `api_key` are redacted. When validation mode is on, each diffed detail request also logs a `type: "validation"` entry with the resource, id, validation status, and any diffs.

- `COMICVINE_LOG_LEVEL` (or the `logLevel` option) sets a minimum threshold; entries below it are dropped — for example `COMICVINE_LOG_LEVEL=warn` suppresses the routine request logs and keeps only warnings and errors.
- `COMICVINE_LOG_FILE` (or the `logFile` option) also appends every emitted entry to a file; stdout/stderr logging continues alongside it. The file is rotated when it exceeds `COMICVINE_LOG_MAX_SIZE` bytes (default 10 MiB): the current file becomes `<path>.1`, `.1` becomes `.2`, up to `COMICVINE_LOG_MAX_FILES` generations (default 5), the oldest removed.
- `COMICVINE_LOG_RESPONSES` (or the `logResponses` option) also records the serialized response body in each request line as `response_body` — off by default so it doesn't flood logs; the body is truncated to `COMICVINE_LOG_RESPONSE_MAX_LENGTH` bytes (default 10 000) with a `…[truncated …]` note when it exceeds the cap.
- `COMICVINE_LOG_SQL` (or the `logSql` option) also records the SQL executed to build each response as `sql` in the request line — a JSON array of `{ sql, params }` entries (the list/search SELECT plus its `COUNT`), off by default; the serialized array is truncated to `COMICVINE_LOG_SQL_MAX_LENGTH` characters (default 20 000) with a `…[truncated …]` note when it exceeds the cap.

### Validation mode (live API)

Set `COMICVINE_VALIDATE=1` (or pass `createApiServer` a `validate: true` option) to have each **detail** request also fetch the same entity from the live ComicVine API and diff it against the bundled data, reporting the result in an extra `validation` field on the response. The live API key is read from `COMICVINE_API_KEY`; without a key the validator is skipped and responses are unchanged. The diff compares scalar fields (ignoring `date_added`, `date_last_updated`, URLs, images, and the `count_of_*` counters) and, for issues, the credit/relationship collections. `validation.status` is `match`, `mismatch`, `missing_on_live`, or `unavailable`; `validation.diffs` lists the differing fields. This consumes live API quota, so enable it only when checking data freshness.

### Publisher allowlist (volume search and list)

Set `COMICVINE_PUBLISHER_ALLOWLIST` to a comma-separated list of publisher ids (e.g. `5,9,42`) to include **only** those publishers' volumes in the **volume** search and list results. Only volumes are affected — it is the only local resource with a `publisher_id` column, so it has no effect on issues, people, teams, or story arcs. The allowlist is a `publisher_id IN (...)` predicate. An **empty** (or unset) allowlist means no restriction — every publisher's volumes are served, so existing deployments are unchanged until you populate it. On the list endpoint it does **not** override an explicit `?filter=publisher_id=…` or `?filter=publisher=…` request — an explicit publisher filter wins, so a client can still query a non-allowlisted publisher directly. It is also available as the `publisherAllowlist` option of `createApiServer` (an array of ids), which takes precedence over the environment variable.

### API key authentication

Authentication is **off by default** — the server serves every endpoint unauthenticated, which suits local use. To require a key, set `COMICVINE_API_KEYS` to a comma-separated list of accepted keys (e.g. `key1,key2`), or pass `createApiServer` an `apiKeys` option (an array or comma-separated string). When one or more keys are configured, requests to the **resource endpoints** (search, list, detail) must present a matching key, supplied via the `api_key` query parameter, the `X-Api-Key` header, or an `Authorization: Bearer <key>` header (checked in that priority order). A missing or invalid key returns HTTP `401` with a ComicVine-style envelope: `{ "error": "…", "status_code": 100 }`, matching the live API's "invalid API key" response. The local-only `/api` index and `/api/status` endpoints stay open without a key so discovery and monitoring keep working. The `OPTIONS` preflight allows the `X-Api-Key` and `Authorization` headers.

### CORS

CORS is **permissive by default** so browser-based clients work out of the box: when no origins are configured every response carries `Access-Control-Allow-Origin: *`, mirroring how the live ComicVine API answers browsers. To restrict which origins may read responses, set `COMICVINE_CORS_ORIGINS` to a comma-separated list of origins (e.g. `http://localhost:5173,https://myapp.example`), or pass `createApiServer` a `corsOrigins` option (an array or comma-separated string). When an allowlist is set, the server echoes the request's `Origin` **only** when it matches, and adds `Vary: Origin` so caches key responses per origin; a non-matching `Origin` gets no `Access-Control-Allow-Origin` header, so the browser blocks the read (the response body is still returned, but the browser refuses to hand it to the page). The `OPTIONS` preflight returns `204` with the same origin grant plus `Access-Control-Allow-Methods: GET, OPTIONS` and `Access-Control-Allow-Headers: Content-Type, X-Api-Key, Authorization`. The grant is applied to JSON, XML, and JSONP responses alike.

### Gzip compression

Response compression is **off by default** — every response is sent uncompressed, which suits local use. To enable it, set `COMICVINE_COMPRESS=1` (or pass `createApiServer` a `compress: true` option). When enabled, a response body is gzipped only if the client sends `Accept-Encoding: gzip` (with a non-zero quality) **and** the serialized body is at least `compressMinSize` bytes (default 1024, settable via `COMICVINE_COMPRESS_MIN_SIZE` or the `compressMinSize` option — gzip’s fixed overhead makes tiny bodies *larger*, so they stay uncompressed). Compressed responses carry `Content-Encoding: gzip` and `Vary: Accept-Encoding`; everything else is byte-identical to the uncompressed path. JSON, XML, and JSONP responses are all eligible. The SRV-16 `response_body` log capture records the **pre-compression** body, so logs stay readable even when the wire bytes are compressed.

### Sorting (list endpoints)

Every **list** endpoint (volumes, issues, people, teams, story arcs, publishers, concepts, characters, locations, objects, powers) honors `?sort=<field>:<direction>` (e.g. `?sort=name:desc`, `?sort=start_year:desc`), where the field must be one of the resource's sortable columns and the direction `asc` or `desc`. An unsupported field or direction returns HTTP `400`. The sortable fields per resource are its scalar columns (e.g. volumes: `name`, `start_year`, `count_of_issues`, …; issues: `name`, `issue_number`, `cover_date`, `store_date`, …; people: `name`, `country`, `gender`, …).

With no `?sort=`, a list endpoint uses a **default sort column** — `id ASC` by default, matching the live ComicVine API and keeping the ordering stable/predictable. You can override the default with the `defaultSort` option on `createApiServer` (a single field name applied to every resource, or a per-resource map such as `{ volume: "name", issue: "issue_number" }`), or with `COMICVINE_DEFAULT_SORT` (a single field name). An explicit `?sort=` always wins over the default. The **search** endpoint is unaffected: it keeps its fixed result ordering (volumes `start_year DESC`, issues by numeric `issue_number`, others `id`).

## Endpoints

The configured `localcv.db` provides volumes, issues, publishers, people, teams, story arcs, concepts, characters, locations, objects, and powers. These endpoints use the ComicVine response envelope; list endpoints support field selection, sorting, and filters, detail endpoints support field selection, and all of them support JSON, XML, or JSONP formats. Issue list and detail responses also honor `field_list`, omitting unrequested fields such as the credit arrays; unrecognized field names are ignored. An issue's `volume` object includes `id`, `name`, `api_detail_url`, and `site_detail_url`; `api_detail_url` is derived from the volume ID when it is not stored in the database. Issue filters on `volume` or `volume_id` compare exact IDs and accept either a number or ComicVine ID such as `4050-7300`; a pipe-separated list of such ids (`?filter=volume:7300|73001`) matches any of them via `IN (…)` (the live API ORs the tokens), while a single value stays an exact match. Each resource reads its normalized columns directly from the database; relationship collections live in `cv_*_credit` join tables for the eight normalized resources (and as JSON text for the three remaining — character, location, power) and are resolved on demand, so no raw API payload is stored in `localcv.db`. Resources whose tables are absent return 404.

```text
GET /api/issues/?limit=10&offset=0
GET /api/issues/?filter=name:Batman
GET /api/issue/4000-6/
GET /api/volume/4050-1487/?format=json&field_list=id,name,character_credits,team_credits
GET /api/search/?format=json&api_key=mock-key&query=witchblade&resources=volume&limit=50&field_list=id,name,publisher
GET /api/volumes/
GET /api/volumes?format=json&field_list=id,name,publisher&sort=name:asc&limit=50&offset=0
GET /api/publishers?format=json&field_list=id,name,location_city&sort=name:asc&limit=50&offset=0
GET /api/publisher/4010-4/?format=json&field_list=id,name,characters,story_arcs,teams,volumes
GET /api/people?format=json&field_list=id,name,birth,death,country,gender,hometown&sort=name:asc&limit=50&offset=0
GET /api/person/4040-1251/?format=json&field_list=id,name,created_characters,issue_credits,story_arc_credits,volume_credits
GET /api/status/
```

`/api/status` is a local-only endpoint (not part of the live ComicVine API). It reports the row count of every `cv_*` table, the `cv_sync_metadata` last-sync date and timestamp per endpoint, and per-endpoint request statistics (request counts, status-code breakdown, average duration) accumulated since the server started, plus the total request count.

Volume details are available at `/api/volume/{id}`. Their `field_list` also supports `character_credits`, `concept_credits`, `location_credits`, `object_credits`, `person_credits`, and `team_credits`. For JSONP, provide `format=jsonp` and `json_callback=Your.callback`. Volume filters accept comma-separated `field:value` expressions or `field:start|end` date ranges. The `id` field is special: a single value is an exact match, and a pipe-separated list of all-numeric ids (`?filter=id:59366|85128|…`) matches any of them via `IN (…)` — ids are never treated as a range.

The publishers collection is available at `/api/publishers`. Its `field_list` supports `aliases`, `api_detail_url`, `date_added`, `date_last_updated`, `deck`, `description`, `id`, `image`, `location_address`, `location_city`, `location_state`, `name`, and `site_detail_url`.

The people collection is available at `/api/people`. Its `field_list` supports `aliases`, `api_detail_url`, `birth`, `count_of_issue_appearances`, `country`, `date_added`, `date_last_updated`, `death`, `deck`, `description`, `email`, `gender`, `hometown`, `id`, `image`, `name`, `site_detail_url`, and `website`.

Person details are available at `/api/person/{id}`. Their `field_list` also supports `created_characters`, `issue_credits`, `story_arc_credits`, and `volume_credits`.

Publisher details are available at `/api/publisher/{id}`. Their `field_list` also supports `characters`, `story_arcs`, `teams`, and `volumes`.

Search accepts comma-separated `resources`, matches query text against names only, and supports `field_list` projection. It returns `resource_type` with each hit and supports JSON, XML, and JSONP. Its default limit is 10 and maximum is 100. Resources without a table in `localcv.db` return no search results. `api_key` is ignored unless key authentication is enabled (see [API key authentication](#api-key-authentication)). `subscriber_only` is accepted for API compatibility but is **unsupported**: the bundled data has no subscriber flag to filter on, so the parameter is parsed and then ignored — every value (`true`/`false`) returns the same unfiltered results. Responses use ComicVine's `error`, `limit`, `offset`, result-count, `status_code`, and `results` fields.

## Syncing Data

The updater is a zero-dependency Node.js script ([src/updater.js](src/updater.js)) that syncs data from the live ComicVine API into `localcv.db` using `node:sqlite` and `fetch`.

```powershell
npm sync          # incremental sync (since the last sync date)
npm sync:full     # one-time full refresh (no date filter; thousands of live API calls)
```

The updater applies the schema migrations ([src/migrate.js](src/migrate.js)) at the start of every sync, so a new release's schema changes apply automatically on the next sync. To apply them without syncing (e.g. right after pulling a release), run:

```powershell
npm migrate       # apply schema migrations only (no API calls)
```

To sync a specific resource instead of all eleven endpoints, pass `--resource <name>` (repeat it, or comma-separate several names):

```powershell
npm sync -- --resource issues
npm sync -- --resource issues,volumes   # or: --resource issues --resource volumes
```

Each name may be the endpoint name (`issues`), the `cv_*` table name (`cv_issue`), or the singular (`issue`). Valid names: `publishers`, `people`, `volumes`, `issues`, `teams`, `storyarcs`, `concepts`, `characters`, `locations`, `powers`, `objects` — an unknown name is rejected up front with the valid list. `cv_sync_metadata` advances only for the synced resources (the rest keep their old start dates), and the post-sync maintenance — the volume/issue-count recalculation and the FTS index rebuilds — runs only for the resources in the selection.

An incremental sync fetches only entities whose `date_last_updated` falls in a window ending today, starting one day before `cv_sync_metadata.last_sync_date` (the overlap keeps an update committed on the last sync day from being missed). When no `last_sync_date` is recorded for an endpoint (a first sync on a database that predates it, or a lost/corrupted row), the updater baselines on the data itself: the newest `date_last_updated` stored in that endpoint's table, minus one day — an arbitrary window (the old 30-day fallback) would silently miss every entity updated before it. If the table is empty, no window can populate it, so that endpoint runs a **full sync** (no date filter) for that run, announced in the log; if the table does not exist at all (a fresh database — the four legacy tables are Python-updater heritage and are not created by `migrate.js`), the endpoint is skipped with an error rather than burning API calls into "no such table" failures.

A full sync is expensive (one unfiltered list call per page plus one detail call per entity across all eleven endpoints — ≈1.1M issue-detail calls; at the 200-calls/hour rate limit it runs for months, roughly 5,500 hours, and cannot be parallelized), so it is gated behind a confirmation. In an interactive run the updater prints a warning and asks you to type `yes`; in a non-interactive run it aborts unless you confirm explicitly:

```powershell
npm sync:full -- --yes   # confirm the full sync without an interactive prompt
```

`npm sync` runs the updater with `--env-file-if-exists=.env`, so `COMICVINE_API_KEY` is read from `.env` (or the `--api-key` flag, or the `COMICVINE_API_KEY` environment variable). The updater opens the database in WAL mode, upserts each resource into its `cv_*` table (all bound values go through a JSON serializer), and advances `cv_sync_metadata.last_sync_date` only for endpoints that succeed. It reuses the server's `field_list` projection and the live API's retry contract (107 → escalating backoff, 100 → endpoint skipped, 420 → wait). The original Python updater's email report and GUI database picker (`smtplib`/`tkinter`) have no zero-dependency Node equivalent and are not implemented. The full flag reference lives in the updater's `--help` output and its header comment.

## Raw API sync

The rawapi sync is a zero-dependency Node.js script ([src/rawapi.js](src/rawapi.js)) — a third process, distinct from the server and the updater — that keeps the **rawapi database** in step with the live ComicVine API. Where the updater normalizes the API into typed columns for `localcv.db` (the served API), rawapi stores each entity's **verbatim** JSON so the static snapshot doubles as a structural ground-truth record of exactly what the live API returns.

The rawapi database (`comicvine_rawapi_*.db`, gitignored) holds eleven `cv_*` tables, each with one uniform shape: `id` (PK), `date_last_updated`, `site_detail_url`, and `raw_api_response`. The `raw_api_response` column is the API's `results` object serialized with `JSON.stringify`; `date_last_updated` and `site_detail_url` are denormalized from the top-level fields of that JSON.

```powershell
npm run rawapi          # incremental sync (since the last sync date)
npm run rawapi:full     # one-time full refresh (~1.5M live API calls)
```

To sync a specific table instead of all eleven, pass `--resource <name>` (repeat it, or comma-separate several names):

```powershell
npm run rawapi -- --resource issue
npm run rawapi -- --resource publisher,issue
```

Each name may be the singular (`issue`), the plural (`issues`), or the `cv_*` table name (`cv_issue`). Valid names: `power`, `concept`, `story_arc`, `object`, `publisher`, `location`, `team`, `person`, `volume`, `character`, `issue` — an unknown name is rejected up front with the valid list. The selected resources keep the smallest-first order, so `issue` still syncs last when it is in the selection, and `cv_sync_metadata` advances only for the synced tables.

A full sync makes one detail call per entity across all eleven tables (~1.5M calls, dominated by the ~1.1M issues), so it is gated behind the same confirmation as the updater:

```powershell
npm run rawapi:full -- --yes   # confirm the full sync without an interactive prompt
```

Each resource runs a two-phase pass: a cheap `field_list=id` list call collects the ids changed since the last sync, then one detail call per id fetches the full object to store verbatim. Resources sync smallest-first so the largest table (`cv_issue`) is always done **last**. The database is updated **in place** (no dated-copy mechanism); the default target is the most recent `comicvine_rawapi_*.db` in the current directory, overridable with `--db`. `COMICVINE_API_KEY` is read from `.env` (or the `--api-key` flag / environment). The full flag reference lives in the script's `--help` output and its header comment.

The sync window uses the same fallback as the updater: when no `last_sync_date` is recorded for a table, the window starts one day before the newest `date_last_updated` stored in that table (the old snapshot-date fallback assumed the database was built from the 2026-01-22 snapshot and would miss every entity updated before it in a database built from a newer snapshot); an empty table runs a full sync for that run, announced in the log.

## Docker

Both the server ([src/server.js](src/server.js)) and the updater ([src/updater.js](src/updater.js)) are zero-dependency Node.js, so a single slim `node:26` image ([Dockerfile](Dockerfile)) runs either — there is no `npm install`. The database is **not** baked into the image: `localcv.db` is gitignored and multi-GB, so it is supplied at runtime as a volume mounted at `/data`, and both entry points are pointed at it via `COMICVINE_DB_PATH` / `--db`.

```powershell
docker compose up server      # serve the API on http://localhost:3333
docker compose run sync       # incremental sync (requires COMICVINE_API_KEY)
docker compose run sync-full  # one-time full refresh
```

[.dockerignore](.dockerignore) keeps the image to the source and `package.json` only (no databases, `.env`, `node_modules`, docs, `LICENSE`, `TODO.md`, or VCS files). [docker-compose.yml](docker-compose.yml) mounts `./data` at `/data` for the `server` service and defines `sync` / `sync-full` services under the `tools` profile. Put an existing `localcv.db` in `./data` (or run a sync to build one) before starting the server.

## Test

```powershell
npm test
```

## Developer Notes

A running diary of decisions, gotchas, and experiments made while working on this project. Newest entries go at the top. The full diary, the entry template, and personal notes live in [docs/dev-notes.md](docs/dev-notes.md).
