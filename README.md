# ComicVine API Local

> **Non-commercial use only.** This project is intended for personal, educational, and other non-commercial use. It is not affiliated with, endorsed by, or sponsored by ComicVine / GameSpot / Fandom, and it must not be used to power any commercial product, service, or paid offering.

> **Credit.** All data in this project is sourced from [ComicVine](https://comicvine.gamespot.com) (a [GameSpot](https://www.gamespot.com) / Fandom service). The [ComicVine API](https://comicvine.gamespot.com/api/) is used to populate `localcv.db`, and all content remains the property of its respective owners. If you use this project, please link back to [comicvine.gamespot.com](https://comicvine.gamespot.com) and give credit to ComicVine.

A local, read-only mirror of the ComicVine API backed by `localcv.db`.
It uses Node.js built-in HTTP and SQLite modules, so no npm dependencies are required.

## Requirements

- Node.js 26.13 or newer
- The SQLite database in the project root, or a path supplied through `COMICVINE_DB_PATH`

## Run

```powershell
npm start
```

`npm start` loads settings from `.env` (values already set in the process environment take precedence). The server listens at `http://127.0.0.1:3333` by default. Set `HOST` to bind to another interface and `PORT` to use another port. Set `COMICVINE_DB_PATH` to use a different SQLite database. For LAN access, set `HOST` to the machine's LAN address. `.env.example` lists the defaults.

Paging limits follow ComicVine's defaults: list endpoints default to 100 and the search endpoint defaults to 10, with a maximum page size of 100. A requested `limit` is clamped to the maximum. Three environment variables override these controls: `COMICVINE_MAX_LIMIT` raises the maximum page size, `COMICVINE_DEFAULT_LIMIT` overrides the default for list endpoints, and `COMICVINE_SEARCH_DEFAULT_LIMIT` overrides the default for the search endpoint. When unset, each falls back to the values above. When `COMICVINE_FORCED_LIMIT` is set, that page size is applied to the **search endpoint only** and takes precedence over a client's `?limit=` (still clamped to the maximum); it does not affect list or detail endpoints. The same controls are available as the `maxLimit`, `defaultLimit`, `searchDefaultLimit`, and `searchForcedLimit` options of `createApiServer`.

Each completed request is logged to stdout as JSON with its method, path, query, status, and duration, plus a `level` and an ISO-8601 `timestamp`. Credential-like query parameters such as `api_key` are redacted. When validation mode is on, each diffed detail request also logs a `type: "validation"` entry with the resource, id, validation status, and any diffs. Every entry carries a `level` (`debug`/`info`/`warn`/`error`) and a `timestamp`, and the default logger prefixes each line with a readable `[timestamp] [LEVEL]` before the JSON body, writing `warn`/`error` entries to stderr and everything else to stdout. `COMICVINE_LOG_LEVEL` (or the `logLevel` option) sets a minimum threshold; entries below it are dropped — for example `COMICVINE_LOG_LEVEL=warn` suppresses the routine request logs and keeps only warnings and errors. Set `COMICVINE_LOG_FILE` (or the `logFile` option) to also append every emitted entry to a file; stdout/stderr logging continues alongside it. The file is rotated when it exceeds `COMICVINE_LOG_MAX_SIZE` bytes (default 10 MiB): the current file becomes `<path>.1`, `.1` becomes `.2`, up to `COMICVINE_LOG_MAX_FILES` generations (default 5), the oldest removed. Set `COMICVINE_LOG_RESPONSES` (or the `logResponses` option) to also record the serialized response body in each request line as `response_body` — off by default so it doesn't flood logs; the body is truncated to `COMICVINE_LOG_RESPONSE_MAX_LENGTH` bytes (default 10 000) with a `…[truncated …]` note when it exceeds the cap. Set `COMICVINE_LOG_SQL` (or the `logSql` option) to also record the SQL executed to build each response as `sql` in the request line — a JSON array of `{ sql, params }` entries (the list/search SELECT plus its `COUNT`), off by default; the serialized array is truncated to `COMICVINE_LOG_SQL_MAX_LENGTH` characters (default 20 000) with a `…[truncated …]` note when it exceeds the cap.

### Validation mode (live API)

Set `COMICVINE_VALIDATE=1` (or pass `createApiServer` a `validate: true` option) to have each **detail** request also fetch the same entity from the live ComicVine API and diff it against the bundled data, reporting the result in an extra `validation` field on the response. The live API key is read from `COMICVINE_API_KEY`; without a key the validator is skipped and responses are unchanged. The diff compares scalar fields (ignoring `date_added`, `date_last_updated`, URLs, images, and the `count_of_*` counters) and, for issues, the credit/relationship collections. `validation.status` is `match`, `mismatch`, `missing_on_live`, or `unavailable`; `validation.diffs` lists the differing fields. This consumes live API quota, so enable it only when checking data freshness.

### Publisher blocklist (volume search and list)

Set `COMICVINE_PUBLISHER_BLOCKLIST` to a comma-separated list of publisher ids (e.g. `5,9,42`) to exclude a publisher's volumes from the **volume** search and list results. Only volumes are affected — it is the only local resource with a `publisher_id` column, so it has no effect on issues, people, teams, or story arcs. The blocklist is a `publisher_id NOT IN (...)` predicate. On the list endpoint it does **not** override an explicit `?filter=publisher_id=…` or `?filter=publisher=…` request — an explicit publisher filter wins. It is also available as the `publisherBlocklist` option of `createApiServer` (an array of ids), which takes precedence over the environment variable.

### API key authentication

Authentication is **off by default** — the server serves every endpoint unauthenticated, which suits local use. To require a key, set `COMICVINE_API_KEYS` to a comma-separated list of accepted keys (e.g. `key1,key2`), or pass `createApiServer` an `apiKeys` option (an array or comma-separated string). When one or more keys are configured, requests to the **resource endpoints** (search, list, detail) must present a matching key, supplied via the `api_key` query parameter, the `X-Api-Key` header, or an `Authorization: Bearer <key>` header (checked in that priority order). A missing or invalid key returns HTTP `401` with a ComicVine-style envelope: `{ "error": "…", "status_code": 100 }`, matching the live API's "invalid API key" response. The local-only `/api` index and `/api/status` endpoints stay open without a key so discovery and monitoring keep working. The `OPTIONS` preflight allows the `X-Api-Key` and `Authorization` headers.

### CORS

CORS is **permissive by default** so browser-based clients work out of the box: when no origins are configured every response carries `Access-Control-Allow-Origin: *`, mirroring how the live ComicVine API answers browsers. To restrict which origins may read responses, set `COMICVINE_CORS_ORIGINS` to a comma-separated list of origins (e.g. `http://localhost:5173,https://myapp.example`), or pass `createApiServer` a `corsOrigins` option (an array or comma-separated string). When an allowlist is set, the server echoes the request's `Origin` **only** when it matches, and adds `Vary: Origin` so caches key responses per origin; a non-matching `Origin` gets no `Access-Control-Allow-Origin` header, so the browser blocks the read (the response body is still returned, but the browser refuses to hand it to the page). The `OPTIONS` preflight returns `204` with the same origin grant plus `Access-Control-Allow-Methods: GET, OPTIONS` and `Access-Control-Allow-Headers: Content-Type, X-Api-Key, Authorization`. The grant is applied to JSON, XML, and JSONP responses alike.

### Sorting (list endpoints)

Every **list** endpoint (volumes, issues, people, teams, story arcs, publishers) honors `?sort=<field>:<direction>` (e.g. `?sort=name:desc`, `?sort=start_year:desc`), where the field must be one of the resource's sortable columns and the direction `asc` or `desc`. An unsupported field or direction returns HTTP `400`. The sortable fields per resource are its scalar columns (e.g. volumes: `name`, `start_year`, `count_of_issues`, …; issues: `name`, `issue_number`, `cover_date`, `store_date`, …; people: `name`, `country`, `gender`, …).

With no `?sort=`, a list endpoint uses a **default sort column** — `id ASC` by default, matching the live ComicVine API and keeping the ordering stable/predictable. You can override the default with the `defaultSort` option on `createApiServer` (a single field name applied to every resource, or a per-resource map such as `{ volume: "name", issue: "issue_number" }`), or with `COMICVINE_DEFAULT_SORT` (a single field name). An explicit `?sort=` always wins over the default. The **search** endpoint is unaffected: it keeps its fixed result ordering (volumes `start_year DESC`, issues by numeric `issue_number`, others `id`).

## Endpoints

The configured `localcv.db` provides volumes, issues, publishers, people, teams, and story arcs. These endpoints use the ComicVine response envelope; volumes, publishers, people, teams, and story arcs also support field selection, sorting, filters, and JSON, XML, or JSONP formats. Issue list and detail responses also honor `field_list`, omitting unrequested fields such as the credit arrays; unrecognized field names are ignored. An issue's `volume` object includes `id`, `name`, `api_detail_url`, and `site_detail_url`; `api_detail_url` is derived from the volume ID when it is not stored in the database. Issue filters on `volume` or `volume_id` compare exact IDs and accept either a number or ComicVine ID such as `4050-7300`. Each resource reads its normalized columns directly from the database; credit arrays and relationship objects are stored as JSON text and parsed on demand, so no raw API payload is stored in `localcv.db`. Resources whose tables are absent return 404.

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

Search accepts comma-separated `resources`, matches query text against names only, and supports `field_list` projection. It returns `resource_type` with each hit and supports JSON, XML, and JSONP. Its default limit is 10 and maximum is 100. Resources without a table in `localcv.db` return no search results. `api_key` is ignored by the mock. `subscriber_only` is accepted for API compatibility but is **unsupported**: the bundled data has no subscriber flag to filter on, so the parameter is parsed and then ignored — every value (`true`/`false`) returns the same unfiltered results. Responses use ComicVine's `error`, `limit`, `offset`, result-count, `status_code`, and `results` fields.

## Syncing Data

The updater is a zero-dependency Node.js script ([src/updater.js](src/updater.js)) that syncs data from the live ComicVine API into `localcv.db` using `node:sqlite` and `fetch`. It is the Node port of the original Python updater (`sqlite_cv_updater/sqlite_cv_updater.py`), which remains for reference.

```powershell
npm sync          # incremental sync (since the last sync date)
npm sync:full     # one-time full refresh (no date filter; thousands of live API calls)
```

A full sync is expensive (one unfiltered call per page across all six endpoints ≈ ~1.1M issue-detail calls; at the 200-calls/hour rate limit it runs for weeks and cannot be parallelized), so it is gated behind a confirmation. In an interactive run the updater prints a warning and asks you to type `yes`; in a non-interactive run it aborts unless you confirm explicitly:

```powershell
npm sync:full -- --yes   # confirm the full sync without an interactive prompt
```

`npm sync` runs the updater with `--env-file-if-exists=.env`, so `COMICVINE_API_KEY` is read from `.env`. The key is resolved in order: the `--api-key` flag, then the `comicvine_config.env` file, then the `COMICVINE_API_KEY` environment variable. The updater opens the database in WAL mode, upserts each resource into its `cv_*` table (all bound values go through a JSON serializer), and advances `cv_sync_metadata.last_sync_date` only for endpoints that succeed. It reuses the server's `field_list` projection and the live API's retry contract (107 → escalating backoff, 100 → abort, 420 → wait). The updater's email report and GUI database picker (Python `smtplib`/`tkinter`) have no zero-dependency Node equivalent and are not implemented. See [sqlite_cv_updater/README.md](sqlite_cv_updater/README.md) for the full flag reference.

## Docker

Both the server ([src/server.js](src/server.js)) and the updater ([src/updater.js](src/updater.js)) are zero-dependency Node.js, so a single slim `node:26` image ([Dockerfile](Dockerfile)) runs either — there is no `npm install`. The database is **not** baked into the image: `localcv.db` is gitignored and multi-GB, so it is supplied at runtime as a volume mounted at `/data`, and both entry points are pointed at it via `COMICVINE_DB_PATH` / `--db`.

```powershell
docker compose up server      # serve the API on http://localhost:3333
docker compose run sync       # incremental sync (requires COMICVINE_API_KEY)
docker compose run sync-full  # one-time full refresh
```

[.dockerignore](.dockerignore) keeps the image to the source and `package.json` only (no databases, `.env`, the legacy Python updater, docs, or VCS files). [docker-compose.yml](docker-compose.yml) mounts `./data` at `/data` for the `server` service and defines `sync` / `sync-full` services under the `tools` profile. Put an existing `localcv.db` in `./data` (or run a sync to build one) before starting the server.

## Test

```powershell
npm test
```

## Developer Notes

A running diary of decisions, gotchas, and experiments made while working on this project. Newest entries go at the top.

### Entry template

```markdown
#### YYYY-MM-DD — Short title

- **Context:** what prompted the change.
- **Change:** what was done and why.
- **Gotcha / follow-up:** anything surprising or still open (reference `TODO.md` items by ID where relevant).
```

### Diary

#### 2026-11-03 — Log the SQL behind a response (SRV-17)

- **Context:** the per-request log line records `method`, `path`, `query`, `status`, and `duration_ms` but not the SQL actually executed, so slow or misbehaving queries can't be inspected without re-implementing the handler's SQL by hand.
- **Change:** added opt-in SQL logging in [src/server.js](src/server.js). When `logSql` (or `COMICVINE_LOG_SQL`) is set, the per-request `database` handle is wrapped so every statement run during the request (the list/search SELECT plus its `COUNT`, detail lookups, and the `/api/status` introspection) is recorded as `{ sql, params }` and emitted as a JSON `sql` array in the per-request `finish` line, truncated to `logSqlMaxLength` (`COMICVINE_LOG_SQL_MAX_LENGTH`, default 20 000 characters) with a `…[truncated …]` note when it exceeds the cap. Off by default, so the wrapper is a no-op for normal requests.
- **Gotcha / follow-up:** the wrapper is built once in `createApiServer` (before any request exists), so it resolves the current request's `response` via a module-local `currentResponse` reference set per-request rather than a closure over `response` — a closure would throw `ReferenceError: response is not defined` because `response` is only in scope inside the request handler. The `node:sqlite` `DatabaseSync` handle has no query hook, so per-statement wrapping is the only capture point; the SRV-6c volume credit/ref sub-queries (run inside `config.build`, which closes over the raw `database`) are *not* captured — they are a deeper plumbing change and are tracked separately. See `TODO.md` SRV-17.

#### 2026-11-03 — Log the response body (SRV-16)

- **Context:** the per-request log line records `method`, `path`, `query`, `status`, and `duration_ms` but not the response body, so a client can't tell *what* a request returned without replaying it.
- **Change:** added opt-in response-body logging in [src/server.js](src/server.js). When `logResponses` (or `COMICVINE_LOG_RESPONSES`) is set, the request handler wraps `response.write`/`response.end` to buffer the emitted chunks (the captured body works for all three formats — JSON via `sendJson`, XML/JSONP via `sendFormattedResponse` — because they all funnel through `write`/`end`). The buffered body is appended to the per-request `finish` line as `response_body`, truncated to `logResponseMaxLength` bytes (`COMICVINE_LOG_RESPONSE_MAX_LENGTH`, default 10 000) with a `…[truncated N of M bytes]` note when it exceeds the cap. Off by default, so the wrapping is a no-op for normal requests.
- **Gotcha / follow-up:** the buffer is per-response and only allocated when the flag is on; a very large list response is truncated at the cap, so a single log line stays bounded. The `write`/`end` wrapping is done once per request (not per call), so the overhead when enabled is a couple of `Buffer.concat` copies. See `TODO.md` SRV-16.

#### 2026-11-02 — Multi-id filter on list endpoints (SRV-15)

- **Context:** a client wanted to fetch several volumes in one request with `?filter=id:59366|85128|…`. The volume `id` filter was a single exact match (`id = ?`), and `|` was already reserved for an inclusive range (`field:start|end` → `col >= ? AND col <= ?`), so a pipe list of ids was misread as a range.
- **Change:** in `parseFilters` in [src/server.js](src/server.js), the volume `id` branch now runs **before** the range branch: a pipe-separated list of all-numeric ids builds `id IN (?, ?, …)` with each token bound as a parameter, while a single value stays `id = ?`. Non-numeric tokens (or a lone value) fall back to the exact match so a typo like `id:7300|abc` matches nothing rather than a range.
- **Gotcha / follow-up:** the branch ordering is the whole fix — the range check `range.length === 2` must come after the id check, or a two-element id list still becomes a range. The `IN` is fully parameterized (no string interpolation of the ids), so there is no injection risk; a very long id list is bounded only by the URL length, which is acceptable for a local mirror. See `TODO.md` SRV-15.

#### 2026-11-01 — Document `subscriber_only` as unsupported (SRV-2)

- **Context:** the search endpoint read `subscriber_only` but the bundled `localcv.db` data has no subscriber flag to filter on, so the parameter was a silent no-op and its behavior was undocumented.
- **Change:** documented `subscriber_only` as **unsupported** rather than sourcing a flag (the live API's subscriber data isn't part of the mock's contract). The search section of this README now states it is accepted for API compatibility but ignored — every value returns the same unfiltered results. The server's search handler comment and the api-contract instructions were updated to match, so a future reader won't mistake the dead parameter for a working filter.
- **Gotcha / follow-up:** this is documentation only — no behavior changed, so the search result set is identical for any `subscriber_only` value. See `TODO.md` SRV-2.

#### 2026-11-01 — Sortable list endpoints + default sort column (SRV-1)

- **Context:** only the volumes list endpoint honored `?sort=`; the `sortable*Fields` allowlists for people, teams, story arcs, and publishers existed but were unused (those endpoints always ordered by `id`), and issues had no sort support at all.
- **Change:** wired `?sort=` into every list endpoint in [src/server.js](src/server.js). A `sortableFieldsByResource` map routes each resource to its allowlist (`sortableVolumeFields`, `sortablePersonFields`, `sortablePublisherFields`, `sortableStoryArcFields`, `sortableTeamFields`, plus a new `sortableIssueFields` covering the scalar issue columns). `parseSort` now takes a default sort column; with no `?sort=` each resource uses its default from `defaultSortByResource` (all `id ASC` by default, matching the live API). The `defaultSort` option on `createApiServer` (a field name or a per-resource map, plural or singular keys) or `COMICVINE_DEFAULT_SORT` overrides the default. An unsupported `?sort=` field/direction still returns 400.
- **Gotcha / follow-up:** the no-`?sort=` default stays `id ASC` to match the live API and preserve the existing tests; clients that want a name/date ordering must pass `?sort=` (or set `defaultSort`). JSON-text credit columns are deliberately **not** in the sortable allowlists — sorting on raw JSON text is meaningless. `issue_number` is stored as text, so a plain `ORDER BY issue_number` is a string sort (numeric-looking strings sort as `"10" < "2"`); the search endpoint uses a numeric `CAST` for the same reason, but the list `?sort=issue_number` is a plain column sort. See `TODO.md` SRV-1.

#### 2026-11-01 — CORS support (SRV-14)

- **Context:** the server set no CORS headers, so a browser client on a different origin was blocked by the same-origin policy — the live ComicVine API answers browsers, so the local mirror should too.
- **Change:** added configurable CORS in [src/server.js](src/server.js). The request handler computes the headers once per request (`corsHeaders`) and stashes them on the response so every `sendJson`/`sendFormattedResponse` path (JSON, XML, and JSONP) merges them in. `COMICVINE_CORS_ORIGINS` (comma/whitespace-separated) or the `corsOrigins` option is the allowlist. An **empty** allowlist is the default and means permissive `Access-Control-Allow-Origin: *` — the previous behavior, suitable for local dev. When origins are set, the request's `Origin` is echoed only on a match, with `Vary: Origin`; a non-match gets no grant. The `OPTIONS` preflight returns `204` with the origin grant plus `Access-Control-Allow-Methods: GET, OPTIONS` and `Access-Control-Allow-Headers: Content-Type, X-Api-Key, Authorization` (the SRV-13 credential headers).
- **Gotcha / follow-up:** matching is an exact string compare against the allowlist (no wildcard/pattern support); origin strings are case-sensitive per the spec, so list them exactly as the browser sends them. A non-matching origin still receives the full 200 body — only the CORS grant is withheld — which is correct for a read-only mirror but means the data is still technically reachable by a non-browser client. See `TODO.md` SRV-14.

#### 2026-11-01 — API key authentication (SRV-13)

- **Context:** the live ComicVine API requires a caller-supplied `api_key`, but the local server served every endpoint unauthenticated, so a misconfigured or exposed server gave open access to the bundled data.
- **Change:** added optional key authentication in [src/server.js](src/server.js). `COMICVINE_API_KEYS` (comma-separated) or the `apiKeys` option on `createApiServer` is parsed into a `Set` (`parseKeyList`). When non-empty, the request handler checks the caller's key (`extractApiKey`: `X-Api-Key`/`X_API_KEY` header → `Authorization: Bearer` → `api_key`/`key` query param) and rejects a missing/invalid key with HTTP 401 and a ComicVine-style `{ error, status_code: 100 }` envelope. The local-only `/api` index and `/api/status` stay open, and the `OPTIONS` preflight now allows the credential headers. Authentication is **off by default** (empty list), so existing local usage is unchanged.
- **Gotcha / follow-up:** matching is an exact string compare against the allowlist (no hashing); keys are opaque tokens so this is fine for a local allowlist, but a deployment exposing the server should keep the key list secret — it is read from the environment, not the DB. See `TODO.md` SRV-13.

#### 2026-11-01 — Confirmation gate for full sync (UPD-2)

- **Context:** a `--full` sync issues one unfiltered call per page across all six endpoints — on the order of ~1.1M issue-detail calls. At the live API's 200-calls/hour rate limit (then a 1-hour ban) it cannot be parallelized and takes on the order of weeks of continuous calls, so an accidental `npm run sync:full` (e.g. in cron) is costly to recover from.
- **Change:** added `confirmFullSync()` in [src/updater.js](src/updater.js). Before a full sync the updater prints a prominent warning (call count, the rate-limit math, the multi-week runtime) and then: in an interactive run it requires typing `yes`; in a non-interactive run it aborts unless `--yes`/`-y` is passed. The flag is documented in the updater's help text and header.
- **Gotcha / follow-up:** the gate runs in `main()` after API-key validation, so a declined full sync exits cleanly (code 1) without touching the database. The interactive prompt reads from stdin via `node:readline/promises` and writes the warning to stderr. See `TODO.md` UPD-2.

#### 2026-11-01 — Optional file logging with rotation (SRV-7)

- **Context:** every request/validation log went to stdout only, so long-running servers could not retain logs across restarts. SRV-7 asked for optional file logging with rotation, keeping stdout available.
- **Change:** added `createRotatingFileLogger()` in [src/server.js](src/server.js). When `COMICVINE_LOG_FILE` (or the `logFile` option) is set, the central `log()` sink appends each emitted entry to that file **in addition to** the existing stdout/stderr logger. The file is size-rotated at `COMICVINE_LOG_MAX_SIZE` (default 10 MiB) into `<path>.1` … `<path>.<maxFiles>` generations (default 5), the oldest removed. Appends use `fs.appendFileSync` to match the server's otherwise-synchronous `node:sqlite` usage, so each line is on disk before the handler returns; rotation/writes are best-effort (a filesystem error logs to stderr and skips the entry rather than crashing the server). The line format is shared with the console logger via `formatLogLine()`, so file and stdout lines are identical.
- **Gotcha / follow-up:** the append is synchronous per entry — fine for request-rate logging, but a very high request rate paying a sync `stat`+`append` per line could add latency; the size check is a single `statSync` so it is cheap. File logging is off by default (no `COMICVINE_LOG_FILE`), so existing deployments are unchanged. Test coverage pins both the write path and a forced rotation.

#### 2026-10-30 — Full-text search (SRV-5)

- **Context:** search and single-value text filters matched with `LIKE '%value%'`, a full table scan. The task was to move to a SQLite full-text index for faster, token-based search (SRV-5), which also supersedes the open SRV-4 question about `LIKE` semantics.
- **Change:** the updater now creates one FTS5 trigram index per resource — `cv_*_fts` over `name`/`aliases`/`deck`/`description` (external-content, keyed on the base table's id) — in `ensureFtsTables()` (Node [src/updater.js](src/updater.js) and Python [sqlite_cv_updater/sqlite_cv_updater.py](sqlite_cv_updater/sqlite_cv_updater.py)) and rebuilds them in `rebuildFtsIndex()` after each sync. The server (`buildResourceConfig` in [src/server.js](src/server.js)) detects each `cv_*_fts` table and, via `ftsOrLike()`, runs search (on `name`) and single-value text filters against the index. The trigram tokenizer is case-insensitive and matches substrings, so the result set is unchanged relative to the old `LIKE`.
- **Gotcha / follow-up:** the trigram tokenizer only matches values of **3+ characters**, so `ftsOrLike()` falls back to the legacy `LIKE` clause for shorter values and for any resource whose FTS table is absent or empty (`COUNT(*) = 0`) — this keeps test fixtures and pre-upgrade databases on the `LIKE` path. `/api/status` excludes the `cv_*_fts` tables from its table listing. Run a sync after upgrading to populate the indexes; until then the server transparently uses `LIKE`.

#### 2026-10-30 — Node.js 26 upgrade

- **Context:** the development machine was upgraded to Node.js 26.13.0.
- **Change:** bumped the minimum requirement to `>=26.13.0` ([package.json](package.json) `engines`, Requirements section) and the Docker base image to `node:26-slim` ([Dockerfile](Dockerfile)). No code changes were needed: the server and updater only use stable built-ins (`node:http`, `node:sqlite`, global `fetch`, `node:fs`/`path`/`os`), all of which behave the same on Node 26 as on 22.
- **Gotcha / follow-up:** the `node:26-slim` tag must exist on Docker Hub before the first `docker compose build`; if the build fails to pull it, fall back to `node:24-slim` — the app has no version-specific dependencies.

#### 2026-10-30 — Publisher blocklist on volume search (SRV-12)

- **Context:** there was no way to hide a publisher's volumes from search/list without a per-request filter.
- **Change:** added a `publisher_id NOT IN (...)` predicate (`publisherBlocklistPredicate`) driven by `COMICVINE_PUBLISHER_BLOCKLIST` (comma-separated) or the `publisherBlocklist` option (array of ids). It applies to volume search and list. On the list endpoint it is skipped when the request carries an explicit `?filter=publisher_id=`/`publisher=` term, so an explicit filter wins; on search (no `?filter`) it always applies. `parseIdList` ignores non-numeric tokens.
- **Gotcha / follow-up:** only volumes are affected because they are the only resource with a `publisher_id` column — the helper no-ops for other resources. Non-issue resources have no publisher column to block on.

#### 2026-10-30 — Docker image (DEPLOY-1)

- **Context:** the app had no container packaging; the server is zero-dependency Node.js and the updater was ported to Node (UPD-3), but the database is gitignored and multi-GB.
- **Change:** added a single `node:22-slim` [Dockerfile](Dockerfile) that runs **both** the server (default `CMD npm start`) and the updater (`npm run sync -- --db /data/localcv.db`) from one image, plus a [.dockerignore](.dockerignore) and a [docker-compose.yml](docker-compose.yml) with `server` / `sync` / `sync-full` services.
- **Gotcha / follow-up:** because both tools are the same runtime, one image is enough — no multi-stage or separate Python image is needed. The DB is provided as a host volume at `/data` (never built into the image), so the image stays small and portable; the same volume is shared between the server and sync services so a sync's writes are visible to the running server.

#### 2026-10-30 — First/last issue refs become a true join to `cv_issue` (SRV-6c)

- **Context:** `cv_volume_issue_ref` (from the SRV-6c backfill) stored the issue id *plus* a denormalized snapshot of `name`/`issue_number`/`api_detail_url`. Because issues — unlike the credit entities — have a local `cv_issue` table, the snapshot is redundant; the ref should just reference the issue row.
- **Change:** reduced `cv_volume_issue_ref` to `volume_id`, `ref_type`, `issue_id` (FK to `cv_issue`), and `key_order`, dropping the three snapshot columns (the updater drops them if an older table still has them). The server now resolves the display fields with `LEFT JOIN cv_issue ON i.id = r.issue_id`. The Node updater's backfill and `syncVolumes` upsert write only the id + key order.
- **Gotcha / follow-up:** the live API's first/last issue ids don't always resolve to a local `cv_issue` row (the DB is a synced subset — ~2.2% of refs are dangling). A `LEFT JOIN` keeps those refs, emitting the id with `null` display fields; this is the intended behavior for now (a dangling ref was previously fully denormalized). The Python updater is unaffected — it predates the join tables and still stores `first_issue`/`last_issue` as JSON.

#### 2026-10-29 — Volume credits normalized into join tables (SRV-6c)

- **Context:** volume relationship data (the six `*_credits` arrays, `first_issue`, `last_issue`) was stored as denormalized JSON text on `cv_volume`; SRV-6 is normalizing these into join tables, staged per table with `cv_volume` first.
- **Change:** added `cv_volume_credit` (one row per credit entry: `volume_id`, `credit_type`, `position`, `credit_id`, `name`, `count`, `api_detail_url`, `site_detail_url`) and `cv_volume_issue_ref` (one row per first/last issue reference, with a `key_order` column recording the emitted key order). A `cv_volume.credits_presence` bitmask distinguishes an empty `[]` from a `null` collection, since the two serialize differently. The updater's `ensureVolumeCreditTables()` backfills the join tables from the JSON columns (id-ordered batches, idempotent) and drops the JSON columns; the server builds volume results from the join tables once the backfill marker (`credits_presence`) is present, and falls back to the JSON columns otherwise.
- **Gotcha / follow-up:** a key-shape audit of all 154k populated rows showed the credit entries have exactly one key shape (`id→name→count→api_detail_url→site_detail_url`, no `role`, no nulls), but `first_issue`/`last_issue` have **two** historical key-order variants with nullable `name`/`issue_number` — hence the `key_order` column. `team_credits` is always `[]`. Output was verified byte-for-byte identical on a copy of the live DB (41 detail responses + a list). The backfill runs automatically on the next `npm sync`; until then the server uses the JSON path and output is unchanged.

#### 2026-10-29 — Node.js updater port (UPD-3)

- **Context:** the sync updater was Python (`sqlite_cv_updater/sqlite_cv_updater.py`), so running a sync required a Python environment separate from the zero-dependency Node server.
- **Change:** ported the updater to `src/updater.js` using `node:sqlite` and `fetch` (no npm dependencies), so sync and server share one runtime. Added `npm sync` / `npm sync:full`. The port preserves the field lists, the upsert SQL, the live API's retry contract (1.5s inter-call delay, 107 → 60s×attempt backoff, 100 → abort, 420 → 600s×attempt wait), the resume state, dated-database copy/cleanup, and the config-file/env key precedence. The Python `smtplib` email report and `tkinter` GUI picker have no zero-dependency Node equivalent and were dropped.
- **Gotcha / follow-up:** `node:sqlite` rejects boolean binds (Python's `sqlite3` coerces `True`/`False` to 1/0), so `jsonify` maps booleans to `1`/`0`; PRAGMAs must go through `exec()` rather than a prepared statement. The Python script remains in the repo for reference.

#### 2026-10-29 — Log levels and timestamps (SRV-10)

- **Context:** the JSON request/validation logs had no severity and no wall-clock time, so a busy log stream was hard to filter or correlate.
- **Change:** added a `log()` helper in `createApiServer` that stamps every entry with an ISO-8601 `timestamp` and a `level` (request logs are `info`; validation logs are `info` on a match, `warn` on a mismatch/missing/unavailable). `COMICVINE_LOG_LEVEL` (or the `logLevel` option) sets a minimum threshold that drops quieter entries, and the default logger now writes `warn`/`error` to stderr and the rest to stdout.
- **Gotcha / follow-up:** the level is resolved once at server construction, so a running server needs a restart to change `COMICVINE_LOG_LEVEL`.

#### 2026-10-29 — Live-API validation on detail endpoints (SRV-8)

- **Context:** there was no way to confirm the bundled data still matched the live ComicVine API after a sync.
- **Change:** added `COMICVINE_VALIDATE=1` (or `validate: true`) so detail responses also diff the entity against the live API and report a `validation` field (`match`/`mismatch`/`missing_on_live`/`unavailable` + per-field diffs), and each diffed request logs a `type: "validation"` entry to stdout. The live key comes from `COMICVINE_API_KEY`. Extracted the per-resource field/relationship Sets into `src/fieldConfig.js` (shared by the server and the new `src/validate.js`) to avoid a require cycle; the live fetch is injectable for tests. Object references (e.g. a volume's `publisher`) diff by `id|name`, not a raw object.
- **Gotcha / follow-up:** validation only runs when a key is present, and issues are the only type whose collections are diffed (the live API returns collections only for issues — see UPD-1). It consumes live quota, so keep it off in normal service.

#### 2026-10-29 — `/api/status` statistics endpoint (SRV-9)

- **Context:** there was no visibility into how stale or complete the local data was, or how the mock was being used.
- **Change:** added `/api/status` reporting per-table row counts, `cv_sync_metadata` last-sync dates, and per-endpoint request stats (counts, status codes, average duration) from an in-memory accumulator keyed by normalized endpoint path. Detail routes aggregate under `/api/{resource}/{id}/`; missing ids still count as HTTP 200 (the 101 envelope matches the live API).
- **Gotcha / follow-up:** stats reset on server restart; the endpoint is local-only and intentionally outside the ComicVine envelope.

#### 2026-10-29 — Full sync, search-only forced limit, and rate-limit handling

- **Context:** the updater needed a one-time full refresh; search paging was being overridden by `COMICVINE_FORCED_LIMIT` on list endpoints too; and the live API's rate-limit response (`status_code: 107`) was aborting sync runs.
- **Change:** added `--full` to the updater; scoped `COMICVINE_FORCED_LIMIT` to the search endpoint only (`searchForcedLimit`); made `api_call` retry with escalating backoff on 107 and `validate_api_key` treat 107 as a valid-but-exhausted key.
- **Gotcha / follow-up:** the updater's Python/Node split is tracked as UPD-3 in `TODO.md`.

#### Personal Notes and Observations

This project came into being because I was using Kapowarr and the comicvine api had an outage due to a recent php vulnerability that impacted many sites across the internet. Kapowarr uses the comicvine api to add new volumes and issues, so my local instance of Kapowarr was up but running with limited functionality. I noticed there were dumps of the comic vine db around the internet and thought well I can probably build an api using one of those. The first database I found turned out to be raw dumps of api calls, this version had basically the same data in the singular table and a copy of the plural table (so there was a cv_volume and cv_volumes table with the same data). This was probably a misunderstanding of the person doing the dump of the architecture (that the cv_volumes call was a way to list multiple volumes from the cv_volume table). I was able to get a working prototype up before service to the comicvine api was restored. Even after it was restored I decided that I had made enough progress to continue using the prototype. Initial versions of this api used that database until I realized that it was a raw dump of the api output. After this realization I rewired the api to use a more normalized database - still trying to clean up that mess but should have this resolved soon.

The bulk of this project used Visual Code/Github Copilot. I initially used the free plan tied to github until I burned through the tokens (this took about a day). I then rewired copilot to use LM Studio Bionic running Qwen 3.8 27B Splash running on a M5 Mac Studio with 64 GB of RAM, my developer workstation is a Windows 11/13th Gen Intel with 128 GB of RAM. This works pretty well if you dial down Reasoning to none (LM Studio/Qwen Splash doesn't support low). I found that basically in Agent mode it was best to ask copilot to add a todo item to implement a specific feature and then review it, and eventually ask copilot to implement it. Also copilot would kind of just go along with some foundational decisions like using the initial database with the raw dumps without any complaints. Integration with Kapowarr also required some human in the loop diagnosing and debugging but for the most part copilot/qwen performed well.

The updater for the normalized database was originally python code borrowed from Logical-Feedback-543 for use with comicrack. I've now migrated that code to node.js and am making modifications to the schema for the database that was used for that project.