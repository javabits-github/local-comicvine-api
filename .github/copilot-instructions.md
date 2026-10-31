# Project Guidelines

A local, read-only mock of the ComicVine API: a Node.js server (`src/server.js`) over a SQLite database (`localcv.db`), plus a Python updater (`sqlite_cv_updater/sqlite_cv_updater.py`) that syncs data from the live ComicVine API.

## Commands

- `npm start` — run the API server (loads `.env`; defaults to `127.0.0.1:3333`)
- `npm test` — run the 38 node built-in tests (`node --test`)
- `python3 sqlite_cv_updater/sqlite_cv_updater.py` — incremental sync from the live API
- `python3 sqlite_cv_updater/sqlite_cv_updater.py --full` — one-time full sync (thousands of live API calls; no date filter)

## Architecture

- `src/server.js` is a single-file server using only `node:http` and `node:sqlite`. No npm dependencies.
- `localcv.db` has six normalized tables (`cv_publisher`, `cv_volume`, `cv_issue`, `cv_person`, `cv_team`, `cv_storyarc`) plus `cv_sync_metadata`. Resources without a table (character, concept, location, object, power) return 404.
- The updater is Python 3.9+ using `requests` and stdlib `sqlite3`. Class is `ComicVineUpdater` (not "Sqlite" named).

## The data contract (most common source of bugs)

- Relationship/credit columns in the DB are **JSON text**: arrays of `{id, name, api_detail_url, site_detail_url}` (plus `role` for person credits, `count` for volume credits), or JSON objects for scalar refs (`death`, `birth`, `publisher`, `first_issue`, `last_issue`, `first_appeared_in_issue`).
- The live API returns dict/list values for fields like `death`, `birth`, `publisher`, `gender` in **~14% of records**. Python `sqlite3` cannot bind dicts — every bound value in the updater goes through `_jsonify()` (dict/list → `json.dumps(ensure_ascii=False)`, else pass-through). Never add a new upsert without `_jsonify` on every bound value.
- The server parses these with `parseJsonColumn`/`parseCredits` in JS; SQL never parses JSON.
- `localcv.db` is a synced **subset**, not the full universe: ids referenced inside JSON collections usually do NOT resolve to local rows, and entities like character/location/object/concept/movie have no local table at all. The denormalized fields inside the JSON are the only source of that data.

## ComicVine live API semantics

- Responses are HTTP 200 with a `status_code` in the body: `1` = OK, `100` = invalid API key, `107` = rate limit exceeded (quota exhausted). HTTP 420 is also a rate-limit signal.
- List endpoints return `results` as an array; detail endpoints return a single object.
- The updater retries 107 with escalating backoff (`RATE_LIMIT_BACKOFF * attempt`, max `MAX_RETRIES` = 5); after exhaustion `api_call` returns `None` and the endpoint is skipped gracefully — metadata (`cv_sync_metadata`) is only advanced on success so the next run re-syncs from the old safe start date.
- Collections (credits, relationships) are returned by the live API **only for issue resources**; other resource types come back without them.

## Server behavior to preserve

- ComicVine response envelope: `error`, `limit`, `offset`, `number_of_page_results`, `number_of_total_results`, `status_code`, `results`.
- Limits: list default 100, search default 10, max 100 (env-overridable). `COMICVINE_FORCED_LIMIT` applies to the **search endpoint only**.
- Search orders volumes by `start_year DESC` and issues by numeric `issue_number ASC` (non-numeric after).
- Text search/filters use a SQLite FTS5 trigram index (`cv_*_fts`, SRV-5) when present, falling back to `LIKE '%value%'` partial match otherwise (shorter values, or a resource without an index). Volume `id` filters are an exact match.
- Only the volumes endpoint honors `?sort=` (see SRV-1 in `TODO.md`).

## Conventions and gotchas

- **Windows environment** (this machine): `node -e` / `python -c` with complex quotes break in PowerShell — write temp `.js`/`.py` files to the session files folder and run the file instead. `os.remove` on a just-closed SQLite DB fails with WinError 32 (WAL mode) — close all connections first or delete after the process exits.
- All `*.db` files (live DB, dated snapshots, raw dumps, `-wal`/`-shm`) are gitignored and excluded from indexing — never commit or read them as text.
- Track open work in `TODO.md` using its item IDs (SRV-n, UPD-n, DB-n, DOC-n); mark items `[x]` when done.
- Developer decisions are journaled in the Developer Notes sections of `README.md` and `sqlite_cv_updater/README.md` (newest entry on top).

## Docs

- `README.md` — server usage, endpoints, env vars
- `sqlite_cv_updater/README.md` — updater usage, configuration
- `TODO.md` — open items with IDs
