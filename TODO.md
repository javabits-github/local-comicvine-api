# TODO

Open items and known gaps for the ComicVine local API.

## Server (`src/server.js`)

- [ ] **SRV-1 — Sortable fields not wired for most list endpoints.** Only the volumes endpoint honors `?sort=` (via `sortableVolumeFields`). The `sortable*Fields` allowlists for publishers, people, teams, and story arcs exist but are not used in the list query — those list endpoints always order by `id`. Wire each resource's `?sort=` into its query.
- [ ] **SRV-2 — `subscriber_only` search parameter is a no-op.** The search endpoint accepts `subscriber_only` but has no backing flag in the bundled data, so it does nothing. Either source a defined flag or document it as unsupported.
- [ ] **SRV-3 — Five resources have no table and return 404.** `character`, `concept`, `location`, `object`, and `power` are declared in `resources` but their `cv_*` tables are absent from `localcv.db`, so their list/detail endpoints 404 and they contribute no search results. Decide whether to add those tables or drop them from `resources`.
- [ ] **SRV-4 — Filters use `LIKE` partial matching for text fields.** Single-value filters match with `LIKE '%value%'` (except volume `id`, which is an exact match). Confirm this matches the live API's filter semantics for other resources.
- [ ] **SRV-5 — Use SQLite full-text search instead of `LIKE`.** Replace the `LIKE '%value%'` matching in search and filters with a SQLite FTS5 index for faster, token-based text search.
- [ ] **SRV-6 — Replace JSON-stored columns with n:n join tables.** Several relationship columns are stored as JSON text; model them as normalized n:n (join) tables and have the server generate the collections directly instead of storing denormalized copies of existing data.
- [ ] **SRV-7 — Log to file.** Currently each request is logged to stdout as JSON. Add optional file logging (e.g. `COMICVINE_LOG_FILE`) with rotation, keeping stdout logging available.
- [x] **SRV-8 — Validation mode against the live API.** Done: `COMICVINE_VALIDATE=1` (or `validate: true`) has detail responses diff the entity against the live API and report a `validation` field; the live key comes from `COMICVINE_API_KEY`.
- [x] **SRV-9 — Add a status page with statistics.** Done: `/api/status` reports per-table row counts, `cv_sync_metadata` last-sync dates, and per-endpoint API call statistics (request counts, status codes, average duration).
- [x] **SRV-10 — Add log levels and timestamps.** Done: every log entry carries an ISO-8601 `timestamp` and a `level`; `COMICVINE_LOG_LEVEL`/`logLevel` sets a threshold, and the default logger routes `warn`/`error` to stderr.

## Updater (`sqlite_cv_updater/sqlite_cv_updater.py`)

- [ ] **UPD-1 — Full sync does not refresh collections for non-issue types.** The live API returns collections (credits, relationships) only for issue resources, so a `--full` sync fully refreshes issues but leaves stored credits/relationships on volumes, people, teams, and story arcs at their last incremental values. Document or backfill these on a full pass.
- [ ] **UPD-2 — Full sync is expensive (thousands of live calls).** A full sync issues one unfiltered call per page across all six endpoints. Consider a warning or confirmation prompt in non-interactive runs.
- [ ] **UPD-3 — Rewrite the updater in Node.js.** Port `sqlite_cv_updater/sqlite_cv_updater.py` to a Node.js script built on `node:sqlite` and `fetch`, so the sync tooling shares the server's runtime and drops the Python dependency.

## Database

- [ ] **DB-1 — Multiple dated snapshots accumulate in the project root.** `localcv-2026-10-27.db`, `localcv-2026-10-28.db`, `localcv-2026-10-29.db` (plus `-wal`/`-shm`) sit alongside `localcv.db`. Confirm the rotation/backup policy and whether these belong in `.gitignore`.

## Deployment

- [ ] **DEPLOY-1 — Add a Dockerfile.** The server is zero-dependency Node.js, so it can run on a slim `node:22` image; the updater is Python. Decide whether to ship a single multi-stage image (server + updater) or separate images, and how the large `localcv.db` gets in (build-arg, mounted volume, or a separate data image) since it is gitignored.

## Docs

- [x] **DOC-1 — README typo.** Fixed: "A local, read-only of the ComicVine API" is now "A local, read-only mirror of the ComicVine API".
