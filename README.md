# ComicVine API Local

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

Each completed request is logged to stdout as JSON with its method, path, query, status, and duration, plus a `level` and an ISO-8601 `timestamp`. Credential-like query parameters such as `api_key` are redacted. When validation mode is on, each diffed detail request also logs a `type: "validation"` entry with the resource, id, validation status, and any diffs. Every entry carries a `level` (`debug`/`info`/`warn`/`error`) and a `timestamp`, and the default logger prefixes each line with a readable `[timestamp] [LEVEL]` before the JSON body, writing `warn`/`error` entries to stderr and everything else to stdout. `COMICVINE_LOG_LEVEL` (or the `logLevel` option) sets a minimum threshold; entries below it are dropped — for example `COMICVINE_LOG_LEVEL=warn` suppresses the routine request logs and keeps only warnings and errors.

### Validation mode (live API)

Set `COMICVINE_VALIDATE=1` (or pass `createApiServer` a `validate: true` option) to have each **detail** request also fetch the same entity from the live ComicVine API and diff it against the bundled data, reporting the result in an extra `validation` field on the response. The live API key is read from `COMICVINE_API_KEY`; without a key the validator is skipped and responses are unchanged. The diff compares scalar fields (ignoring `date_added`, `date_last_updated`, URLs, images, and the `count_of_*` counters) and, for issues, the credit/relationship collections. `validation.status` is `match`, `mismatch`, `missing_on_live`, or `unavailable`; `validation.diffs` lists the differing fields. This consumes live API quota, so enable it only when checking data freshness.

### Publisher blocklist (volume search and list)

Set `COMICVINE_PUBLISHER_BLOCKLIST` to a comma-separated list of publisher ids (e.g. `5,9,42`) to exclude a publisher's volumes from the **volume** search and list results. Only volumes are affected — it is the only local resource with a `publisher_id` column, so it has no effect on issues, people, teams, or story arcs. The blocklist is a `publisher_id NOT IN (...)` predicate. On the list endpoint it does **not** override an explicit `?filter=publisher_id=…` or `?filter=publisher=…` request — an explicit publisher filter wins. It is also available as the `publisherBlocklist` option of `createApiServer` (an array of ids), which takes precedence over the environment variable.

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

Volume details are available at `/api/volume/{id}`. Their `field_list` also supports `character_credits`, `concept_credits`, `location_credits`, `object_credits`, `person_credits`, and `team_credits`. For JSONP, provide `format=jsonp` and `json_callback=Your.callback`. Volume filters accept comma-separated `field:value` expressions or `field:start|end` date ranges.

The publishers collection is available at `/api/publishers`. Its `field_list` supports `aliases`, `api_detail_url`, `date_added`, `date_last_updated`, `deck`, `description`, `id`, `image`, `location_address`, `location_city`, `location_state`, `name`, and `site_detail_url`.

The people collection is available at `/api/people`. Its `field_list` supports `aliases`, `api_detail_url`, `birth`, `count_of_issue_appearances`, `country`, `date_added`, `date_last_updated`, `death`, `deck`, `description`, `email`, `gender`, `hometown`, `id`, `image`, `name`, `site_detail_url`, and `website`.

Person details are available at `/api/person/{id}`. Their `field_list` also supports `created_characters`, `issue_credits`, `story_arc_credits`, and `volume_credits`.

Publisher details are available at `/api/publisher/{id}`. Their `field_list` also supports `characters`, `story_arcs`, `teams`, and `volumes`.

Search accepts comma-separated `resources`, matches query text against names only, and supports `field_list` projection. It returns `resource_type` with each hit and supports JSON, XML, and JSONP. Its default limit is 10 and maximum is 100. Resources without a table in `localcv.db` return no search results. `api_key` is ignored by the mock. `subscriber_only` is accepted but has no filtering behavior because its spec does not define the parameter. Responses use ComicVine's `error`, `limit`, `offset`, result-count, `status_code`, and `results` fields.

## Syncing Data

The updater is a zero-dependency Node.js script ([src/updater.js](src/updater.js)) that syncs data from the live ComicVine API into `localcv.db` using `node:sqlite` and `fetch`. It is the Node port of the original Python updater (`sqlite_cv_updater/sqlite_cv_updater.py`), which remains for reference.

```powershell
npm sync          # incremental sync (since the last sync date)
npm sync:full     # one-time full refresh (no date filter; thousands of live API calls)
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