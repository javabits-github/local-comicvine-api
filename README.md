# ComicVine API Local

A local, read-only mirror of the ComicVine API backed by `localcv.db`.
It uses Node.js built-in HTTP and SQLite modules, so no npm dependencies are required.

## Requirements

- Node.js 22.13 or newer
- The SQLite database in the project root, or a path supplied through `COMICVINE_DB_PATH`

## Run

```powershell
npm start
```

`npm start` loads settings from `.env` (values already set in the process environment take precedence). The server listens at `http://127.0.0.1:3333` by default. Set `HOST` to bind to another interface and `PORT` to use another port. Set `COMICVINE_DB_PATH` to use a different SQLite database. For LAN access, set `HOST` to the machine's LAN address. `.env.example` lists the defaults.

Paging limits follow ComicVine's defaults: list endpoints default to 100 and the search endpoint defaults to 10, with a maximum page size of 100. A requested `limit` is clamped to the maximum. Three environment variables override these controls: `COMICVINE_MAX_LIMIT` raises the maximum page size, `COMICVINE_DEFAULT_LIMIT` overrides the default for list endpoints, and `COMICVINE_SEARCH_DEFAULT_LIMIT` overrides the default for the search endpoint. When unset, each falls back to the values above. When `COMICVINE_FORCED_LIMIT` is set, that page size is applied to the **search endpoint only** and takes precedence over a client's `?limit=` (still clamped to the maximum); it does not affect list or detail endpoints. The same controls are available as the `maxLimit`, `defaultLimit`, `searchDefaultLimit`, and `searchForcedLimit` options of `createApiServer`.

Each completed request is logged to stdout as JSON with its method, path, query, status, and duration. Credential-like query parameters such as `api_key` are redacted.

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

#### 2026-10-29 — `/api/status` statistics endpoint (SRV-9)

- **Context:** there was no visibility into how stale or complete the local data was, or how the mock was being used.
- **Change:** added `/api/status` reporting per-table row counts, `cv_sync_metadata` last-sync dates, and per-endpoint request stats (counts, status codes, average duration) from an in-memory accumulator keyed by normalized endpoint path. Detail routes aggregate under `/api/{resource}/{id}/`; missing ids still count as HTTP 200 (the 101 envelope matches the live API).
- **Gotcha / follow-up:** stats reset on server restart; the endpoint is local-only and intentionally outside the ComicVine envelope.

#### 2026-10-29 — Full sync, search-only forced limit, and rate-limit handling

- **Context:** the updater needed a one-time full refresh; search paging was being overridden by `COMICVINE_FORCED_LIMIT` on list endpoints too; and the live API's rate-limit response (`status_code: 107`) was aborting sync runs.
- **Change:** added `--full` to the updater; scoped `COMICVINE_FORCED_LIMIT` to the search endpoint only (`searchForcedLimit`); made `api_call` retry with escalating backoff on 107 and `validate_api_key` treat 107 as a valid-but-exhausted key.
- **Gotcha / follow-up:** the updater's Python/Node split is tracked as UPD-3 in `TODO.md`.