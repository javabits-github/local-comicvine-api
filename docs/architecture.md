# ComicVine Local — Architecture

## Server request flow (`src/server.js`)

```mermaid
flowchart TB
    C[Client] -->|GET /api/...| S[node:http server<br/>127.0.0.1:3333]

    S --> R{"Route"}
    R -->|/api/search/?query=..&resources=..| SE[Search handler]
    R -->|/api/volumes/ etc.| LE[List handler]
    R -->|"/api/volume/{id}/ etc."| DE["Detail handler"]
    R -->|unknown| NF[404 / 400<br/>envelope with error]

    SE --> LO[loop selected resources]
    LO --> Q[(localcv.db<br/>node:sqlite)]
    Q -->|"name: FTS trigram / LIKE fallback<br/>volume: start_year DESC<br/>issue: issue_number ASC"| LO
    LO --> CAT[concatenate results<br/>slice to one page]

    LE --> CFG[buildResourceConfig<br/>subquery + JOINs]
    DE --> CFG
    CFG --> Q
    Q --> F["parseFilters<br/>LIKE/FTS text, volume id (incl. multi-id), ranges"]
    F --> SO[parseSort — all list endpoints<br/>per-resource allowlist, default id ASC]
    SO --> L[resolveLimit<br/>list 100 / search 10 / max 100<br/>searchForcedLimit = search only]
    L --> Q

    Q --> B["buildResult<br/>join tables (8) / JSON columns (3)"]
    B --> FL[field_list projection]
    FL --> EN[comicVine envelope<br/>error, limit, offset, counts, status_code, results]
    CAT --> EN
    DE --> EN
    EN --> FM[format: json / xml / jsonp]
    FM --> C

    subgraph DB [localcv.db — 11 resource tables]
        Q
        PUB[cv_publisher]
        VOL[cv_volume]
        ISS[cv_issue]
        PER[cv_person]
        TEAM[cv_team]
        ARC[cv_storyarc]
        CON[cv_concept]
        CHAR[cv_character]
        LOC[cv_location]
        POW[cv_power]
        OBJ[cv_object]
        VOL -. publisher_id .-> PUB
        ISS -. volume_id .-> VOL
    end

    style Q fill:#264f78,stroke:#6ea1d6,color:#fff
    style EN fill:#5a3d8f,stroke:#9b7fd4,color:#fff
    style NF fill:#7a2e2e,stroke:#c06060,color:#fff
```

## Updater sync pipeline (`src/updater.js`)

The updater is a zero-dependency Node.js script (`node:sqlite` + `fetch`). Run it with `npm sync` (incremental) or `npm sync:full`.

```mermaid
flowchart TB
    CV[ComicVine live API<br/>comicvine.gamespot.com/api]
    START[main<br/>resolve db + api key]
    VAL{validateApiKey}
    FULL{"--full? confirm<br/>(type yes / --yes)"}

    START --> VAL
    VAL -->|100 invalid key| EXIT1[exit 1 — abort run]
    VAL -->|1 ok / 107 ok| FULL
    FULL -->|not confirmed| EXIT2[exit 1 — no sync]
    FULL -->|confirmed| AC

    CV -->|HTTP 200 + status_code| AC[apiCall<br/>retry loop, MAX_RETRIES = 5]
    AC -->|107 rate limit| W[backoff 60s × attempt<br/>then retry]
    W --> AC
    AC -->|420| W4[wait 600s × attempt<br/>then retry]
    W4 --> AC
    AC -->|100 invalid key| N1[return null<br/>→ endpoint skipped]
    AC -->|exhausted 107| N2[return null<br/>→ endpoint skipped]
    AC -->|status 1| SYNC

    SYNC{"runSync<br/>per endpoint, in order"}
    N1 --> SYNC
    N2 --> SYNC

    SYNC --> SP[syncPublishers]
    SYNC --> SP2[syncPersons]
    SYNC --> SV[syncVolumes]
    SYNC --> SI[syncIssues]
    SYNC --> ST[syncTeams]
    SYNC --> SA[syncStoryarcs]
    SYNC --> SC[syncConcepts]
    SYNC --> SCH[syncCharacters]
    SYNC --> SL[syncLocations]
    SYNC --> SPOW[syncPowers]
    SYNC --> SOBJ[syncObjects]

    SP & SP2 & SV & SI & ST & SA & SC & SCH & SL & SPOW & SOBJ --> J["jsonify every bound value<br/>obj → JSON text, bool → 1/0"]
    J --> U[(upsert into cv_* tables)]
    U --> M[cv_sync_metadata<br/>last_sync_date — advanced only on success]
    M --> POST[recalc volume issue counts<br/>+ rebuild FTS index]

    style AC fill:#264f78,stroke:#6ea1d6,color:#fff
    style U fill:#264f78,stroke:#6ea1d6,color:#fff
    style N1 fill:#7a2e2e,stroke:#c06060,color:#fff
    style N2 fill:#7a2e2e,stroke:#c06060,color:#fff
```

## Database schema (`localcv.db`)

Solid edges are real columns; dotted edges are JSON-text relationship columns (parsed in JS, never joined in SQL). Not every column is shown — see the updater for the full column list.

```mermaid
erDiagram
    cv_publisher {
        INTEGER id PK
        TEXT name
        TEXT location_city
    }
    cv_volume {
        INTEGER id PK
        TEXT name
        TEXT start_year
        INTEGER publisher_id FK
        INTEGER count_of_issues
        INTEGER credits_presence "bitmask: which credit arrays are non-null"
    }
    cv_issue {
        INTEGER id PK
        INTEGER volume_id FK
        TEXT name
        TEXT issue_number
        INTEGER credits_presence "bitmask"
    }
    cv_person {
        INTEGER id PK
        TEXT name
        TEXT birth
        TEXT death "JSON object"
    }
    cv_team {
        INTEGER id PK
        TEXT name
        INTEGER publisher_id FK
        INTEGER first_appeared_in_issue_id FK
    }
    cv_storyarc {
        INTEGER id PK
        TEXT name
        INTEGER publisher_id FK
        INTEGER first_appeared_in_issue_id FK
    }
    cv_concept {
        INTEGER id PK
        TEXT name
        INTEGER first_appeared_in_issue_id FK
        INTEGER count_of_issue_appearances
    }
    cv_character {
        INTEGER id PK
        TEXT name
        TEXT real_name
        INTEGER first_appeared_in_issue_id FK
        TEXT teams "JSON array"
        TEXT powers "JSON array"
        TEXT issue_credits "JSON array"
    }
    cv_location {
        INTEGER id PK
        TEXT name
        INTEGER first_appeared_in_issue_id FK
        TEXT issue_credits "JSON array"
        TEXT volume_credits "JSON array"
    }
    cv_power {
        INTEGER id PK
        TEXT name
        TEXT characters "JSON array"
    }
    cv_object {
        INTEGER id PK
        TEXT name
        INTEGER first_appeared_in_issue_id FK
    }

    cv_volume_credit {
        INTEGER volume_id FK
        TEXT credit_type "character/concept/location/object/person/team"
        INTEGER position "array order"
        INTEGER credit_id
        TEXT name
        TEXT count
    }
    cv_volume_issue_ref {
        INTEGER volume_id FK
        TEXT ref_type "first/last"
        INTEGER issue_id FK "resolves to cv_issue"
        TEXT key_order "emitted key order, byte-for-byte"
    }
    cv_concept_credit {
        INTEGER concept_id FK
        TEXT credit_type
        INTEGER position
        INTEGER credit_id
        TEXT name
    }
    cv_publisher_credit {
        INTEGER publisher_id FK
        TEXT credit_type
        INTEGER position
        INTEGER credit_id
        TEXT name
    }
    cv_team_credit {
        INTEGER team_id FK
        TEXT credit_type
        INTEGER position
        INTEGER credit_id
        TEXT name
    }
    cv_person_credit {
        INTEGER person_id FK
        TEXT credit_type
        INTEGER position
        INTEGER credit_id
        TEXT name
    }
    cv_storyarc_credit {
        INTEGER storyarc_id FK
        TEXT credit_type
        INTEGER position
        INTEGER credit_id
        TEXT name
    }
    cv_object_credit {
        INTEGER object_id FK
        TEXT credit_type
        INTEGER position
        INTEGER credit_id
        TEXT name
    }
    cv_issue_credit {
        INTEGER issue_id FK
        TEXT credit_type
        INTEGER position
        INTEGER credit_id
        TEXT name
        TEXT role
    }
    cv_issue_image {
        INTEGER issue_id FK
        INTEGER position
        INTEGER image_id
        TEXT caption
    }

    cv_publisher ||--o{ cv_volume : publisher_id
    cv_volume ||--o{ cv_issue : volume_id
    cv_team }o--o| cv_publisher : publisher_id
    cv_storyarc }o--o| cv_publisher : publisher_id
    cv_team }o--o| cv_issue : first_appeared_in_issue_id
    cv_storyarc }o--o| cv_issue : first_appeared_in_issue_id
    cv_concept }o--o| cv_issue : first_appeared_in_issue_id
    cv_character }o--o| cv_issue : first_appeared_in_issue_id
    cv_location }o--o| cv_issue : first_appeared_in_issue_id
    cv_object }o--o| cv_issue : first_appeared_in_issue_id

    cv_publisher ||--o{ cv_publisher_credit : credits
    cv_volume ||--o{ cv_volume_credit : credits
    cv_volume ||--o{ cv_volume_issue_ref : issue_refs
    cv_issue ||--o{ cv_volume_issue_ref : first_last
    cv_issue ||--o{ cv_issue_credit : credits
    cv_issue ||--o{ cv_issue_image : images
    cv_person ||--o{ cv_person_credit : credits
    cv_team ||--o{ cv_team_credit : credits
    cv_storyarc ||--o{ cv_storyarc_credit : credits
    cv_concept ||--o{ cv_concept_credit : credits
    cv_object ||--o{ cv_object_credit : credits

    cv_character }o..o{ cv_team : teams
    cv_character }o..o{ cv_power : powers
    cv_character }o..o{ cv_issue : issue_credits
    cv_location }o..o{ cv_issue : issue_credits
    cv_location }o..o{ cv_volume : volume_credits
    cv_location }o..o{ cv_storyarc : story_arc_credits
    cv_power }o..o{ cv_character : characters
```

Notes on the schema:

- `cv_sync_metadata` (endpoint, last_sync_date, last_sync_timestamp, resume_state) tracks updater progress per endpoint — not shown above.
- **Eight resource tables are normalized:** publisher, volume, issue, person, team, storyarc, concept, and object store their relationship collections in `cv_*_credit` join tables (plus `cv_volume_issue_ref` for a volume's first/last issue and `cv_issue_image` for an issue's images) rather than JSON columns. The legacy JSON columns were dropped by the one-shot migrations (v2, v7–v12). `credits_presence` (on `cv_volume` and `cv_issue`) is a bitmask the server uses to tell an empty `[]` from a `null` collection.
- **Three resource tables still store their relationships as JSON text** (the dotted edges): character, location, and power. Their normalization is a future SRV-6 item.
- **`cv_volume_issue_ref` is a true join to `cv_issue`:** it stores only the issue `id` (FK) and the emitted `key_order`; the server resolves `name`/`issue_number`/`api_detail_url` by joining `cv_issue`. Issues *do* have a local table, so the denormalized snapshot is not needed. A `LEFT JOIN` keeps a ref whose issue id isn't in the (synced-subset) `cv_issue` table, emitting the id with `null` display fields.
- The credit join tables keep `name`/`api_detail_url`/`site_detail_url` inline by design (the SRV-6 pattern): a `LEFT JOIN` to the referenced entity's local table would diverge if that row were re-synced after a rename, and the live API's denormalized values are the ground truth for byte-for-byte output. In the three still-JSON tables, referenced ids usually do **not** resolve to local rows (the DB is a synced subset), and `movie` has no local table at all — the denormalized fields inside the JSON are the only source of that data.
- **The served `localcv.db` is at the final schema** (brought up by `migrate()`; the `schema_version` stamp records the last applied migration). A fresh database gets the final schema directly from the idempotent `CREATE`s, except the four legacy tables (`cv_publisher`, `cv_volume`, `cv_issue`, `cv_person`) are Python-updater heritage and are not created by `migrate.js` — they exist only in databases the updater built.
- The FTS5 full-text indexes (`cv_*_fts`), `comicdb_*.db` (raw dumps), and dated `localcv-*.db` snapshots are out of scope for the API and excluded from the diagram above. `comicvine_rawapi_*.db` (the verbatim-JSON ground-truth snapshot, RAW-1) is likewise out of scope: it is maintained by the rawapi process ([src/rawapi.js](../src/rawapi.js)) and is never read by the server.

## Notes

- **Server** is a single file, zero npm deps: `node:http` + `node:sqlite`. Every **list** endpoint honors `?sort=` (SRV-1); only `search` honors `COMICVINE_FORCED_LIMIT`.
- **Search** matches each selected resource on its `name` column: an FTS5 trigram `MATCH` when the resource's `cv_*_fts` index is populated (gated on the FTS `_data` shadow table, SRV-32; queries ≥ 3 chars), else a case-insensitive `LIKE` (SRV-5). Volumes come newest-first, issues by numeric issue number; the hits are concatenated in resource order and sliced to one page, so `number_of_total_results` is the combined count across resources.
- **Updater** is incremental by default (`date_last_updated` filter since last safe sync date); `--full` drops the filter but is gated behind a `yes` confirmation (UPD-2). `validateApiKey` runs once at startup — a `100` there aborts the whole run (`exit 1`); a `100`/exhausted-`107` *mid-run* just makes `apiCall` return `null` and that endpoint is skipped. Skipped endpoints don't advance `cv_sync_metadata`, so the next run re-syncs from the old start date.
- **Rawapi** (RAW-1) is a third process ([src/rawapi.js](../src/rawapi.js)) that keeps `comicvine_rawapi_*.db` in step with the live API: for every entity changed since the last sync it stores the **verbatim** `results` JSON in the uniform `cv_*` tables (`id`, `date_last_updated`, `site_detail_url`, `raw_api_response`). Resources sync smallest-first so `cv_issue` is always last; a list call that still fails after retries skips that table and the sync continues. It updates the database in place (no dated-copy mechanism) and reuses the updater's `cv_sync_metadata` resume tracking.
- The three still-JSON tables (character, location, power) store their relationship collections as JSON text; the server parses them in JS, never in SQL. The other eight tables' relationships live in join tables and are resolved in SQL.
