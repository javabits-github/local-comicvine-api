# Structure Validation — local storage + server output vs the raw ComicVine API

Date: 2026-11-10
Sources of truth: `comicvine_rawapi_20260122.db` (11 GB dump of verbatim live-API JSON, 11 `cv_*` tables) and the live API (key from `.env`). The retired Python updater was **not** used as a reference.

## Method

1. **Raw dump (Jan 2026) = structural ground truth.** Full-scan extraction of every row in all 11 raw tables (1.1 M issues, 0 bad JSON): key presence, JSON types, nested keys, array-element keys.
2. **Live API = current truth.** One sample entity fetched per type (11 calls). Key sets are **identical** to the January dump for all 11 types — the API's *schema* has not changed since 2026-01-22.
3. **Empirical server diff.** The real server (`src/server.js`) was run against `localcv.db` on `127.0.0.1:3999`; one sample entity per type was requested locally and live, then diffed (keys, types, values, key order).
4. **Raw-text key-order comparison** of the January dump vs the live API for the same entities (issue 6, volume 766).
5. **Direct inspection of `localcv.db`** (column sets, declared types, value distributions).

## Verdict

- **Storage (updater) is structurally complete** for the six synced resources: every field the live API emits for issue/person/publisher/team/story_arc/volume has a backing column, and the stored values match the live API (including the API's own quirks, e.g. 44 % of issues with `name: null` — the live API returns those nulls too).
- **Server output is not.** The response builders (`buildResult` in `src/server.js`) drop stored fields, leak an internal column name, and use different collection names than the live API for several resources.
- **The live API changed its serialization since January** (key order in ref objects and `image`, and volume-credit `count` string→number). The local output matches the January dump, not the current live byte order.
- **Three data-quality gaps** in `localcv.db` (newest 18,002 issue rows missing 18 columns; `|| []` coercion destroying null-vs-`[]`; `has_staff_review` stored as 0/NULL/JSON-text in one INTEGER column).

## Per-resource key-set comparison (local server output vs live API)

| Resource | Local keys | Live keys | Local-only | Live-only (missing locally) |
|---|---|---|---|---|
| character | — (404) | 200 | — | entire resource |
| concept | — (404) | 200 | — | entire resource |
| location | — (404) | 200 | — | entire resource |
| object | — (404) | 200 | — | entire resource |
| power | — (404) | 200 | — | entire resource |
| issue | 14 | 31 | — | `aliases`, `api_detail_url`, `deck`, `date_added`, `date_last_updated`, `has_staff_review`, `image`, `object_credits`, `concept_credits`, `character_died_in`, `team_disbanded_in`, `first_appearance_*` (6) |
| person | 19 | 22 | `count_of_issue_appearances`, `image_url`, `issue_credits` | `api_detail_url`, `count_of_isssue_appearances`, `date_added`, `date_last_updated`, `death`, `issues` |
| publisher | 16 | 17 | — | `api_detail_url` |
| story_arc | 15 | 17 | `count_of_issue_appearances`, `image_url` | `api_detail_url`, `count_of_isssue_appearances`, `episodes`, `first_appeared_in_episode` |
| team | 23 | 23 | `count_of_issue_appearances`, `image_url`, `issues_disbanded_in` | `api_detail_url`, `count_of_isssue_appearances`, `isssues_disbanded_in` |
| volume | 21 | 21 | `character_credits`, `concept_credits`, `location_credits`, `object_credits`, `person_credits`, `team_credits` | `characters`, `concepts`, `locations`, `objects`, `people`, `issues` |

## Findings

### F1 — Five resources 404 (maps to SRV-3)

`character`, `concept`, `location`, `object`, `power` are declared in `resources` (server.js:9–20) and have server branches, but `localcv.db` has no `cv_character`/`cv_concept`/`cv_location`/`cv_object`/`cv_power` tables, so all five return `404 "Resource is not available in the configured database."` and contribute no search results. (The `cv_concept` code from DB-2 exists; the table is simply absent from this DB because no sync has created it here.)

### F2 — Issue builder drops 17 of 31 stored fields (server bug)

`cv_issue` stores all 31 live fields (17 of them added by the ALTER migration, all backfilled — e.g. 161,076 non-null `deck`s). The issue branch of `buildResult` (server.js:234–258) emits only 14 keys, silently dropping: `aliases`, `api_detail_url`, `deck`, `date_added`, `date_last_updated`, `has_staff_review`, `image`, `object_credits`, `concept_credits`, `character_died_in`, `team_disbanded_in`, and the six `first_appearance_*` collections.

Confirmed against the running server: `GET /api/issue/4000-2797/?field_list=deck` returns `{"deck":null}` while the DB holds `"The Man-Ape thinks he will be the cleverest of all if he manages to read three books!"` and the live API returns it. `projectResult` (server.js:83) defaults absent fields to `null`, so **`field_list` requests for stored-but-unbuilt fields return null instead of the value** — on both detail and list endpoints.

`image` is dropped *intentionally* (fieldConfig.js:53 comment; `normalizeResult` deletes issue images), but the live API returns `image` for issues in both the January dump and today — a deliberate divergence.

### F3 — Person: 4 stored fields dropped, `image_url` leak, name/type mismatches

- Dropped although the columns exist in `cv_person`: `api_detail_url`, `date_added`, `date_last_updated`, `death`.
- **`image_url` leaks into the output** (server.js:280) — an internal column name with no live-API counterpart (the live API uses `image`).
- `issue_credits` (local) vs `issues` (live) — collection name mismatch.
- `count_of_issue_appearances` (local) vs `count_of_isssue_appearances` (live) — the live API's typo.
- **`gender` type mismatch:** `cv_person.gender` is TEXT, so the server emits `"1"` (string) where the live API emits `1` (number). Stored values: `"0"` ×52,021, `"1"` ×28,833, `"2"` ×9,174, `"3"` ×23, `"0.0"` ×67, `"1.0"` ×18, `"2.0"` ×1, NULL ×7 — the TEXT affinity also preserves float spellings like `"0.0"`.

### F4 — Publisher: drops `api_detail_url` (server bug)

The column exists and the updater writes it (field_list at updater.js:711), but the publisher branch (server.js:260–277) never emits it. Otherwise the publisher output matches the live key set exactly.

### F5 — Team: no `api_detail_url` column, `image_url` leak, two live-typo mismatches

`cv_team` (22 columns) has **no** `api_detail_url` column, so it cannot be emitted. `image_url` leaks (server.js:296). `issues_disbanded_in` (local) vs `isssues_disbanded_in` (live) and `count_of_issue_appearances` vs `count_of_isssue_appearances` are name mismatches — the local uses the *corrected* spellings while the live API uses its typos.

### F6 — Story arc: no `api_detail_url`/`episodes`/`first_appeared_in_episode` columns, `image_url` leak

`cv_storyarc` (14 columns) lacks `api_detail_url`, `episodes`, and `first_appeared_in_episode` — all emitted by the live API. `image_url` leaks (server.js:313). Same two count-name mismatches as team.

### F7 — Volume: collection names, `issues`, and the publisher ref

- Local emits `character/concept/location/object/person/team_credits` (six collections, from the SRV-6c join table); the live API emits `characters, concepts, locations, objects, people` (five — **no teams**) plus `issues`.
- `issues` is not stored at all (`cv_volume` has no such column; `cv_volume_issue_ref` holds only first/last refs; the updater's volume field_list never requests `issues`).
- Volume `publisher` ref: local `{id, name}` vs live `{api_detail_url, id, name}` — the join selects the publisher's name but not its `api_detail_url`.
- Credit-entry `count`: local is a string (`cv_volume_credit.count` is TEXT, all 3,993,684 rows) — matches the January dump, but the live API now returns a number.

### F8 — Key-order drift: the live API re-serialized since January

Key *sets* are unchanged, but raw-text comparison of the same entities (issue 6, volume 766) shows the live API's serialization order changed between 2026-01-22 and now:

| Object | January dump | Live now | Local server |
|---|---|---|---|
| ref objects (issue `volume`, credits, first/last issue, publisher refs, volume `people`/`characters` entries) | `id` first | `api_detail_url` first | `id` first (matches January; volume first/last refs preserve the stored `key_order`) |
| `image` | icon, tiny, small, super, thumb, image_tags, medium, screen, original, screen_large | icon, medium, screen, screen_large, small, super, thumb, tiny, original, image_tags | original, icon, medium, screen, screen_large, small, super, thumb, tiny, image_tags |
| `associated_images` entry | id, caption, image_tags, original_url | original_url, id, caption, image_tags | id, caption, image_tags, original_url (stored JSON) |
| volume credit `count` | string `"2"` | number `2` | string (matches January) |

The local `image` variant order (icon, medium, screen, screen_large, small, super, thumb, tiny) happens to match the *current* live order; only `original_url`'s position differs (local: first; live: before `image_tags`). JSON key order is semantically irrelevant to most consumers, but byte-for-byte diffs against the live API will show these.

### F9 — Data quality in `localcv.db`

1. **NULL names are the live API's, not a local bug.** 504,524 of 1,138,247 issues (44 %) have `name IS NULL`, spread uniformly across all id ranges. The live API returns `name: null` for the same rows (verified for issue 7) — the DB faithfully stores the API's nulls.
2. **18,002 newest issue rows are missing 18 columns.** All in the id range 1,100,000–1,199,999 (the newest issues): `date_added`, `date_last_updated`, `api_detail_url`, `has_staff_review` (the four ALTER-added scalars) **and** the 14 ALTER-added JSON columns (`aliases`, `deck`, `object_credits`, `concept_credits`, `character_died_in`, `team_disbanded_in`, six `first_appearance_*`) are SQL NULL. The live API returns real values for these fields (verified for issue 1153517: `date_added 2026-01-21`, `has_staff_review false`, …) — these rows were written by a code path whose upsert predates the ALTER-added columns.
3. **`|| []` coercion destroys null-vs-`[]` for issue collections.** `upsertIssue` (updater.js:1022–1040) binds `JSON.stringify(x || [])`, so an API `null` is stored as `"[]"`. The live API returns `first_appearance_characters: null` for issue 6 (and all six `first_appearance_*` are null for every issue in the January dump), yet 1,120,245 local rows store `"[]"` for them. If the server ever emits these fields (F2), it will answer `[]` where the live API answers `null`. (The SRV-6c `credits_presence` bitmask solved exactly this for volume credits; the issue JSON columns — SRV-6f — have no equivalent.)
4. **`has_staff_review` is one INTEGER column holding three shapes:** `0` ×1,120,243, NULL ×18,002, JSON-text review objects ×2. The live API returns boolean `false` or an object; the `0`-vs-`false` type quirk is latent (the field is currently dropped from output, F2).

## Mapping to TODO.md

| Finding | TODO item |
|---|---|
| F1 (5 resources 404) | SRV-3 (open) — concept additionally needs a sync run to create `cv_concept` (DB-2) |
| F2 (issue drops 17 stored fields; `field_list` returns null for stored values) | SRV-19 (new) — server `buildResult` issue branch; related to SRV-6f/g |
| F3 (person drops 4, `image_url` leak, `issues`/count names, `gender` string) | SRV-20 (new) — server person branch + `gender` column affinity (TEXT→INTEGER/REAL) |
| F4 (publisher drops `api_detail_url`) | SRV-21 (new) — server publisher branch |
| F5/F6 (team/story_arc: missing columns, `image_url` leak, typo names) | SRV-22/SRV-23 (new) — server branches; UPD-9 (new) — columns + updater field_lists + backfill |
| F7 (volume collection names, `issues`, publisher ref) | SRV-24 (new) — the `*_credits`-vs-plural naming and the publisher ref; UPD-10 (new) — volume `issues` column + field_list (partially SRV-6c, done) |
| F8 (key-order/count drift) | Informational — live API changed since the dump; no action unless byte-for-byte parity with *current* live is a goal |
| F9.2 (18,002 rows missing 18 columns) | UPD-7 (new) — backfill pass (an incremental sync over that id window would refill them) |
| F9.3 (`|| []` null-vs-`[]`) | UPD-8 (new) — belongs with SRV-6f (issue join tables) or a `presence` marker |
| F9.4 (`has_staff_review` 0/NULL/JSON-text in one column) | Folded into SRV-19 — normalize on output once the field is emitted |

## What is *not* a problem

- The 44 % NULL-name issues (F9.1) — the live API does the same.
- `deck`/`description` NULLs — match the live API.
- The six `first_appearance_*` being empty for all issues — the January dump shows the same (all null); the live API still returns them as null/`[]` today.
- Storage coverage of the live field set for the six synced resources — complete.
