# Project Guidelines

A local, read-only mock of the ComicVine API: a Node.js server (`src/server.js`) over a SQLite database (`localcv.db`), plus a Node.js updater (`src/updater.js`) that syncs data from the live ComicVine API.

## Commands

- `npm start` — run the API server (loads `.env`; defaults to `127.0.0.1:3333`)
- `npm test` — run the node built-in tests (`node --test`)
- `npm sync` — incremental sync from the live API (`node src/updater.js`)
- `npm sync:full` — one-time full sync (thousands of live API calls; no date filter; gated behind a `yes` confirmation, or `--yes` in non-interactive runs)

## Architecture

- `src/server.js` is a single-file server using only `node:http` and `node:sqlite`. No npm dependencies.
- `localcv.db` has seven normalized tables (`cv_publisher`, `cv_volume`, `cv_issue`, `cv_person`, `cv_team`, `cv_storyarc`, `cv_concept`) plus `cv_sync_metadata`. Resources without a table (character, location, object, power) return 404.
- The updater is Node.js (`src/updater.js`) using `node:sqlite` and global `fetch` — zero npm dependencies, sharing the server's runtime. Its class is `ComicVineUpdater`. (The original Python updater was removed from the repo when the Node port was adopted; its history is preserved in the git log.)

## The data contract (most common source of bugs)

- Relationship/credit columns in the DB are **JSON text**: arrays of `{id, name, api_detail_url, site_detail_url}` (plus `role` for person credits, `count` for volume credits), or JSON objects for scalar refs (`death`, `birth`, `publisher`, `first_appeared_in_issue`). **Exception (SRV-6c):** `cv_volume`'s `first_issue`/`last_issue` are normalized into the `cv_volume_issue_ref` join table (`issue_id` FK + `key_order`; display fields resolved via `LEFT JOIN cv_issue`), and its six credit arrays into `cv_volume_credit` — the JSON columns are dropped after the updater backfill.
- The live API returns dict/list values for fields like `death`, `birth`, `publisher`, `gender` in **~14% of records**. `node:sqlite` cannot bind objects — every bound value in the updater goes through `jsonify()` (object → `JSON.stringify`, boolean → `1`/`0`, `null`/`undefined` → `null`, else pass-through). Never add a new upsert without `jsonify` on every bound value.
- The server parses these with `parseJsonColumn`/`parseCredits` in JS; SQL never parses JSON.
- `localcv.db` is a synced **subset**, not the full universe: ids referenced inside JSON collections usually do NOT resolve to local rows, and entities like character/location/object/movie have no local table at all. The denormalized fields inside the JSON are the only source of that data.

## ComicVine live API semantics

- Responses are HTTP 200 with a `status_code` in the body: `1` = OK, `100` = invalid API key, `107` = rate limit exceeded (quota exhausted). HTTP 420 is also a rate-limit signal.
- List endpoints return `results` as an array; detail endpoints return a single object.
- The updater retries 107 with escalating backoff (`RATE_LIMIT_BACKOFF_SECONDS * attempt`, max `MAX_RETRIES` = 5); after exhaustion `apiCall` returns `null` and the endpoint is skipped gracefully — metadata (`cv_sync_metadata`) is only advanced on success so the next run re-syncs from the old safe start date.
- Collections (credits, relationships) are returned by the live API **only for issue resources**; other resource types come back without them.

## Server behavior to preserve

- ComicVine response envelope: `error`, `limit`, `offset`, `number_of_page_results`, `number_of_total_results`, `status_code`, `results`.
- Limits: list default 100, search default 10, max 100 (env-overridable). `COMICVINE_FORCED_LIMIT` applies to the **search endpoint only**.
- Search orders volumes by `start_year DESC` and issues by numeric `issue_number ASC` (non-numeric after).
- Text search/filters use a SQLite FTS5 trigram index (`cv_*_fts`, SRV-5) when present, falling back to `LIKE '%value%'` partial match otherwise (shorter values, or a resource without an index). Volume `id` filters are an exact match.
- Every list endpoint honors `?sort=` (SRV-1, done); an unsupported field/direction returns 400. An optional per-resource default sort column can be set via the `defaultSort` option or `COMICVINE_DEFAULT_SORT`.

## Conventions and gotchas

- **Windows environment** (this machine): `node -e` with complex quotes breaks in PowerShell — write a temp `.js` file to the session files folder and run the file instead. `os.remove`/`fs.rmSync` on a just-closed SQLite DB fails with WinError 32 (WAL mode) — close all connections first or delete after the process exits.
- All `*.db` files (live DB, dated snapshots, raw dumps, `-wal`/`-shm`) are gitignored and excluded from indexing — never commit or read them as text.
- Track open work in `TODO.md` using its item IDs (SRV-n, UPD-n, DB-n, DOC-n); mark items `[x]` when done.
- Developer decisions are journaled in the Developer Notes section of `README.md` (newest entry on top).

## Docs

- `README.md` — server usage, endpoints, env vars, and updater sync commands; the Node updater's full flag reference lives in its sync section and the `src/updater.js` header
- `TODO.md` — open items with IDs
