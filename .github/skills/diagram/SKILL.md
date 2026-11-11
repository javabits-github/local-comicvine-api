---
name: diagram
description: "Generate or update mermaid architecture diagrams of the ComicVine local project. Use when: the user asks for a diagram, architecture overview, request flow, sync pipeline, database schema diagram, or says 'show me' / 'visualize' the project."
argument-hint: "Optional: which diagram (server, updater, db-schema, or all)"
---

# Project Diagrams

Generate mermaid diagrams of this project. VS Code renders mermaid natively in markdown preview (`Ctrl+Shift+V`), so always write diagrams as `.md` files.

## Where diagrams live

- Existing diagrams: `docs/architecture.md` (server request flow + updater sync pipeline).
- **Update** `docs/architecture.md` when the user asks to refresh/fix a diagram that already exists there.
- New one-off diagrams: write to the session files folder, not the repo, unless the user asks to commit them.

## Known project structure (use this; only re-verify if the code seems to have changed)

**Server** (`src/server.js`, single file, zero npm deps — `node:http` + `node:sqlite`):
- Route → search / list / detail handlers → `buildResourceConfig` (subquery + `LEFT JOIN cv_publisher` for volumes, `LEFT JOIN cv_volume` for issues) → `parseFilters` (LIKE partial, exact volume `id`, `field:start|end` ranges) → `parseSort` (all list endpoints, SRV-1; search unchanged) → `resolveLimit` (list 100 / search 10 / max 100; `searchForcedLimit` search-only) → `buildResult` (parses JSON-text columns) → `field_list` projection → ComicVine envelope → json/xml/jsonp.

**Database** (`localcv.db`, gitignored): `cv_publisher`, `cv_volume`, `cv_issue`, `cv_person`, `cv_team`, `cv_storyarc` + `cv_sync_metadata`. FK-ish columns: `cv_volume.publisher_id → cv_publisher`, `cv_issue.volume_id → cv_volume`. Credit/relationship columns are JSON text (arrays of `{id, name, api_detail_url, site_detail_url}` — `role` for person credits, `count` for volume credits; objects for `death`, `birth`, `publisher`, `first_issue`, `last_issue`, `first_appeared_in_issue`).

**Updater** (`src/updater.js`, Node.js, zero deps — `node:sqlite` + `fetch`; class `ComicVineUpdater`):
- `main` → `validateApiKey` (100 aborts the whole run) → `--full` confirmation gate (UPD-2) → `runSync`.
- `apiCall` retry loop (MAX_RETRIES 5): 107 → backoff 60s×attempt → retry; 420 → wait 600s×attempt → retry; 100 or exhausted → `null` (endpoint skipped, not a whole-run abort).
- `runSync` → six `sync*` methods in order (publishers, people, volumes, issues, teams, storyarcs); all bound values through `jsonify` (object → JSON text, bool → 1/0); upsert into `cv_*`; `cv_sync_metadata.last_sync_date` advanced only on success; then `recalculateVolumeIssueCounts` + `rebuildFtsIndex`.

## Procedure

1. If the user names a specific diagram, generate just that; otherwise update/regenerate all three: **server flow**, **updater pipeline**, **db schema** (erDiagram of the six tables, edges for `publisher_id`/`volume_id`, and dotted edges for the JSON-relationship columns).
2. Read the relevant source first only when unsure (e.g., `src/server.js` for flow, `src/updater.js` for pipeline, and `PRAGMA table_info` via a temp script for schema — never read `*.db` as text).
3. Write/refresh the markdown with fenced `mermaid` blocks; keep each diagram under ~40 lines.
4. Tell the user to open the preview (`Ctrl+Shift+V`) to render.

## Conventions

- Use `flowchart TB` for pipelines, `erDiagram` for the schema.
- **flowchart: always double-quote node labels and edge labels** (`R{"Route"}`, `-->|"/api/volume/{id}/"|`). Unquoted `{...}` is parsed as a diamond shape and breaks the diagram — this bit us in `docs/architecture.md`.
- **erDiagram: do NOT quote** relationship labels or column comments-as-labels (quotes render literally there); relationship labels must be a single token (no spaces, no parens).
- Keep node labels terse; put detail in `<br/>` lines, not long titles.
- Highlight contract-critical nodes with `style` fills (e.g., envelope, `apiCall`, upserts).
- If the code changed since the last diagram (check the Developer Notes in `README.md`), note what changed in the diagram's Notes section.
