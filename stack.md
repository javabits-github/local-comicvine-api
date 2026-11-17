# Technology Stack

A local, read-only mirror of the [ComicVine API](https://comicvine.gamespot.com/api/) backed by SQLite. The whole project is **zero-dependency Node.js** — it runs on Node built-ins and the global `fetch` only, so there is no `npm install` step and no `node_modules`. See [docs/architecture.md](docs/architecture.md) for the request flow, sync pipeline, and schema; this file is the technology overview.

## Runtime

- **Node.js `>= 26.13.0`** (the `engines` floor; the Docker image is `node:26-slim`).
- **Zero npm dependencies.** `package.json` declares no `dependencies` or `devDependencies`; every capability comes from a Node built-in or the global `fetch`.
- **`.env` loading** via the `--env-file-if-exists=.env` flag on every `npm` script (values already in the process environment take precedence).

## Node built-ins

| Module | Used by | Purpose |
| --- | --- | --- |
| `node:http` | `server.js` | The API HTTP server (no framework). |
| `node:sqlite` (`DatabaseSync`) | `server.js`, `updater.js`, `rawapi.js`, `migrate.js` | Synchronous SQLite access. |
| `node:fs` | all | File I/O (databases, logs, state). |
| `node:path` | `server.js`, `updater.js`, `rawapi.js` | Path handling. |
| `node:zlib` | `server.js` | Optional gzip response compression. |
| `node:os` | `updater.js` | Temp-directory paths for test/scratch DBs. |
| `node:readline/promises` | `updater.js`, `rawapi.js` | Interactive prompts (full-sync confirmation). |
| global `fetch` | `updater.js`, `rawapi.js`, `validate.js` | HTTP client for the live ComicVine API. |
| `node:test` | `test/*` | The test runner, driven by `node --test`. |

## Processes

Four entry points, each a single zero-dependency script:

| Process | Entry | npm script | Role |
| --- | --- | --- | --- |
| **Server** | `src/server.js` | `npm start` | Read-only API over `localcv.db` (search, list, detail). |
| **Updater** | `src/updater.js` | `npm run sync` / `sync:full` | Keeps `localcv.db` in step with the live API (normalized columns). |
| **Rawapi** | `src/rawapi.js` | `npm run rawapi` / `rawapi:full` | Keeps `comicvine_rawapi_*.db` in step with the live API (verbatim JSON). |
| **Migrate** | `src/migrate.js` | `npm run migrate` | One-shot schema migrations (also applied by the updater at startup). |

Supporting modules: `src/fieldConfig.js` (per-resource column/field allowlists, the live-API base URL, and id domain prefixes) and `src/validate.js` (live-API diffing for the server's validation mode).

## Data layer

- **SQLite** in WAL journal mode.
- `localcv.db` — the served database (normalized columns + JSON-text relationship columns + FTS tables).
- `comicvine_rawapi_*.db` — the verbatim-JSON ground-truth snapshot (maintained by rawapi, never read by the server).
- Dated `localcv-*.db` snapshots and `-wal`/`-shm` sidecars.
- All databases are gitignored (multi-GB, rebuilt by the updater); the schema and table relationships are documented in [docs/architecture.md](docs/architecture.md).

## External service

- **ComicVine live API** (`comicvine.gamespot.com/api`) — the only external dependency. Consumed by the updater, rawapi, and the server's validation mode; requires a `COMICVINE_API_KEY`.
- **Rate limit:** 200 calls/hour per key; exceeding it triggers a ban. The updater/rawapi pace and back off against it (see the sync pipeline in [docs/architecture.md](docs/architecture.md)).

## Testing

- **`node --test`** (the built-in `node:test` runner) — `npm test`.
- Four suites: `test/server.test.js`, `test/updater.test.js`, `test/rawapi.test.js`, `test/migrate.test.js`. Tests build throwaway databases in temp directories and inject a mock `fetch`, so they run offline with no live API key.

## Configuration

Settings come from `.env` (see [.env.example](.env.example)) or the process environment. The principal variables:

- `COMICVINE_API_KEY` — live-API key (updater, rawapi, validation).
- `COMICVINE_DB_PATH` — the served database path (default `./localcv.db`).
- `HOST` / `PORT` — bind address (default `127.0.0.1:3333`).
- Paging, logging, CORS, compression, validation, and the publisher allowlist controls — documented in the [README](README.md).

## Deployment

- **Docker** — a single `node:26-slim` image ([Dockerfile](Dockerfile)) serves the API and can also run a sync; there is no `npm install` layer because there are no dependencies.
- **docker-compose** ([docker-compose.yml](docker-compose.yml)) — a `server` service plus `sync` / `sync-full` services under the `tools` profile.
- The database is **never baked into the image**; it is a host-mounted volume at `/data` (the DB and its `-wal`/`-shm` sidecars live there).
