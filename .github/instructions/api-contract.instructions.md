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
- `api_key` is accepted but ignored.

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
- Issue `volume`/`volume_id` filters resolve to the joined volume id (accepts `4050-7300` or bare number).
- Unknown fields match nothing (`1 = 0`); malformed filters → 400.

## Per-resource special cases (buildResult / buildResourceConfig)

- **volume**: publisher resolved via `LEFT JOIN cv_publisher` on `publisher_id` (no JSON column); credits parsed with `parseCredits`; `first_issue`/`last_issue` are JSON objects.
- **issue**: volume object built from the joined `cv_volume` row; `api_detail_url` falls back to the deterministic `https://comicvine.gamespot.com/api/volume/4050-<id>/` when absent.
- **team / story_arc**: `publisher` and `first_appeared_in_issue` are JSON object columns parsed with `parseJsonColumn`.
- **person / publisher**: relationship collections parsed from JSON text columns.

## Ordering

- Search: volumes `start_year DESC`, issues numeric `issue_number ASC` (non-numeric specials last, then id), others `id`.
- List: only volume honors `?sort=` (`parseSort` + `sortableVolumeFields`); all other list endpoints order `id ASC` (SRV-1 in TODO.md tracks wiring the rest).

## Validation when changing this file

Run `npm test` (23 tests) — the suite in `test/server.test.js` pins the envelope, field_list, filter, sort, and forced-limit behavior.
