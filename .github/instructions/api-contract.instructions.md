---
description: "Use when: changing or extending the ComicVine API response shape in src/server.js — the response envelope, field_list projection, filters, sorting, limits, or formats. Covers the envelope contract, per-resource field allowlists, and the volume/issue special cases."
applyTo: "src/server.js"
---

# ComicVine API Contract (src/server.js)

## Response envelope

`/api/status` is the one exception: it is local-only (not in the live API) and returns `{tables, sync_metadata, endpoints, total_requests}` without the envelope.

When `COMICVINE_VALIDATE=1` (and `COMICVINE_API_KEY` is set), detail responses keep the envelope but add a `validation` field (`{status, diffs, collections}`) from the live-API diff.

Every other response (list, detail, search) uses ComicVine's envelope:

```json
{ "error": "OK", "limit": 100, "offset": 0,
  "number_of_page_results": 10, "number_of_total_results": 250,
  "status_code": 1, "results": [...] }
```

- `number_of_page_results` is `results.length` for lists, `1` for details.
- Detail 404s return the envelope with `error: "Object Not Found"`, `status_code: 101`, `results: null`.
- Formats: `format=json` (default), `xml`, `jsonp` (requires `json_callback`); invalid format → 400.
- `api_key` is accepted but ignored **unless** SRV-13 key authentication is enabled (`COMICVINE_API_KEYS` / `options.apiKeys` non-empty); then resource endpoints (search/list/detail) require a matching key (via `api_key` query param, `X-Api-Key` header, or `Authorization: Bearer`) and a missing/invalid key returns HTTP 401 with `{ error, status_code: 100 }`. The local-only `/api` index and `/api/status` stay open regardless.

## field_list projection

- `projectResult` / `projectSearchFields` keep only requested fields; unrecognized names are ignored; unrequested fields fall back to their documented null defaults (do not drop keys — clients expect them).
- Each resource has a field allowlist Set at the top of server.js (`volumeFields`, `personFields`, `teamFields`, `storyArcFields`, `publisherFields`, plus `sortable*Fields` and relationship-field Sets). **Add new response fields to the matching Set** or they will be stripped.

## Limits

- `resolveLimit(requested, default, max)` clamps to `[1, max]`. Defaults: list 100, search 10, max 100; env overrides `COMICVINE_MAX_LIMIT`, `COMICVINE_DEFAULT_LIMIT`, `COMICVINE_SEARCH_DEFAULT_LIMIT`.
- `COMICVINE_FORCED_LIMIT` → `options.searchForcedLimit` applies to **search only** (`searchForcedLimit ?? requestedLimit`); list endpoints must keep using the client's `?limit`.

## Publisher blocklist (SRV-12)

- `COMICVINE_PUBLISHER_BLOCKLIST` (comma-separated ids) or `options.publisherBlocklist` (array) excludes a publisher's **volumes** from search and list results via a `publisher_id NOT IN (...)` predicate (`publisherBlocklistPredicate`). It is the only resource with a `publisher_id` column, so it has no effect on other resources.
- On the **list** endpoint the blocklist is skipped when the request has an explicit `?filter=publisher_id=` or `?filter=publisher=` term (an explicit filter wins). On **search** there is no `?filter`, so the blocklist always applies when set.

## Filters (parseFilters)

- Comma-separated `field:value` terms; `field:start|end` is an inclusive range.
- Single values are `LIKE '%value%' COLLATE NOCASE`, **except volume `id` which is exact `=` match**.
- **SRV-5:** a single-value text field (`name`/`aliases`/`deck`/`description`) is matched against the resource's FTS5 trigram index (`ftsOrLike`) when that index exists and the value is ≥ 3 characters; otherwise it falls back to the `LIKE` clause above.
- Issue `volume`/`volume_id` filters resolve to the joined volume id (accepts `4050-7300` or bare number).
- Unknown fields match nothing (`1 = 0`); malformed filters → 400.

## Search (SRV-5)

- Each searchable resource matches on its **name** column only. When the resource has a populated FTS5 trigram table (`cv_*_fts`, created by the updater) the query runs as a trigram `MATCH` (`ftsOrLike`); otherwise it falls back to `LIKE lower(?) ESCAPE '\\' COLLATE NOCASE`.
- The trigram tokenizer is case-insensitive and matches substrings (≥ 3 chars), so the result set matches the legacy `LIKE` behavior; shorter queries always use `LIKE`.
- `buildResourceConfig` detects each `cv_*_fts` table and exposes `config.ftsTable`/`config.ftsColumns`; an absent or empty index (`COUNT(*) = 0`) disables FTS for that resource, so test fixtures without FTS tables are unaffected.
- `subscriber_only` is accepted for API compatibility but is **unsupported** (SRV-2): the bundled data has no subscriber flag, so the parameter is ignored and every value returns the same unfiltered results. Do not add filtering logic against it.

## Per-resource special cases (buildResult / buildResourceConfig)

- **volume**: publisher resolved via `LEFT JOIN cv_publisher` on `publisher_id` (no JSON column). When the SRV-6c join tables are present (backfill marker `credits_presence` + `cv_volume_credit`/`cv_volume_issue_ref` + `cv_issue`), `buildVolumeResult` generates the six credit collections from `cv_volume_credit` and `first_issue`/`last_issue` from `cv_volume_issue_ref` (a true join: `LEFT JOIN cv_issue` supplies `name`/`issue_number`/`api_detail_url`; a dangling id emits with null display fields). Otherwise the JSON columns are parsed by `parseCredits`/`parseJsonColumn` (the path for test fixtures).
- **issue**: volume object built from the joined `cv_volume` row; `api_detail_url` falls back to the deterministic `https://comicvine.gamespot.com/api/volume/4050-<id>/` when absent.
- **team / story_arc**: `publisher` and `first_appeared_in_issue` are JSON object columns parsed with `parseJsonColumn`.
- **person / publisher**: relationship collections parsed from JSON text columns.

## Ordering

- Search: volumes `start_year DESC`, issues numeric `issue_number ASC` (non-numeric specials last, then id), others `id`.
- List: every list endpoint honors `?sort=` via `parseSort` + the per-resource allowlist in `sortableFieldsByResource` (`sortableVolumeFields`, `sortableIssueFields`, `sortablePersonFields`, `sortablePublisherFields`, `sortableStoryArcFields`, `sortableTeamFields`). With no `?sort=`, each resource uses its default sort column from `defaultSortByResource` (all `id` ASC by default, matching the live API); the `defaultSort` option on `createApiServer` (a field name or a per-resource map) or `COMICVINE_DEFAULT_SORT` overrides it. An unsupported `?sort=` field/direction → 400.

## Validation when changing this file

Run `npm test` (38 tests) — the suite in `test/server.test.js` pins the envelope, field_list, filter, sort, forced-limit, and FTS search behavior.
