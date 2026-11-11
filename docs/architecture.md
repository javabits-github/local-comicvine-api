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
    Q -->|name LIKE %query%<br/>volume: start_year DESC<br/>issue: issue_number ASC| LO
    LO --> CAT[concatenate results<br/>slice to one page]

    LE --> CFG[buildResourceConfig<br/>subquery + JOINs]
    DE --> CFG
    CFG --> Q
    Q --> F[parseFilters<br/>LIKE partial, exact volume id, ranges]
    F --> SO[parseSort — volume only<br/>else id ASC]
    SO --> L[resolveLimit<br/>list 100 / search 10 / max 100<br/>searchForcedLimit = search only]
    L --> Q

    Q --> B[buildResult<br/>parseJsonColumn / parseCredits]
    B --> FL[field_list projection]
    FL --> EN[comicVine envelope<br/>error, limit, offset, counts, status_code, results]
    CAT --> EN
    DE --> EN
    EN --> FM[format: json / xml / jsonp]
    FM --> C

    subgraph DB [localcv.db — 7 tables]
        Q
        PUB[cv_publisher]
        VOL[cv_volume]
        ISS[cv_issue]
        PER[cv_person]
        TEAM[cv_team]
        ARC[cv_storyarc]
        CON[cv_concept]
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

    SP & SP2 & SV & SI & ST & SA & SC --> J["jsonify every bound value<br/>obj → JSON text, bool → 1/0"]
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
        TEXT characters "JSON array"
        TEXT story_arcs "JSON array"
        TEXT teams "JSON array"
        TEXT volumes "JSON array"
    }
    cv_volume {
        INTEGER id PK
        TEXT name
        TEXT start_year
        INTEGER publisher_id FK
        INTEGER count_of_issues
        INTEGER credits_presence "bitmask: which credit arrays are non-null"
    }
    cv_volume_credit {
        INTEGER volume_id FK
        TEXT credit_type "character/concept/location/object/person/team"
        INTEGER position "array order"
        INTEGER credit_id
        TEXT name
        TEXT count
        TEXT api_detail_url
        TEXT site_detail_url
    }
    cv_volume_issue_ref {
        INTEGER volume_id FK
        TEXT ref_type "first/last"
        INTEGER issue_id FK "resolves to cv_issue"
        TEXT key_order "emitted key order, byte-for-byte"
    }
    cv_issue {
        INTEGER id PK
        INTEGER volume_id FK
        TEXT name
        TEXT issue_number
        TEXT person_credits "JSON + role"
        TEXT character_credits "JSON"
        TEXT team_credits "JSON"
        TEXT story_arc_credits "JSON"
        TEXT location_credits "JSON"
        TEXT concept_credits "JSON"
        TEXT object_credits "JSON"
    }
    cv_person {
        INTEGER id PK
        TEXT name
        TEXT birth
        TEXT death "JSON object"
        TEXT created_characters "JSON"
        TEXT issue_credits "JSON"
        TEXT volume_credits "JSON"
        TEXT story_arc_credits "JSON"
    }
    cv_team {
        INTEGER id PK
        TEXT name
        TEXT publisher "JSON object"
        TEXT characters "JSON"
        TEXT issue_credits "JSON"
        TEXT volume_credits "JSON"
        TEXT movies "JSON"
    }
    cv_storyarc {
        INTEGER id PK
        TEXT name
        TEXT publisher "JSON object"
        TEXT issues "JSON"
        TEXT movies "JSON"
    }
    cv_concept {
        INTEGER id PK
        TEXT name
        TEXT aliases
        TEXT first_appeared_in_issue "JSON object"
        INTEGER count_of_issue_appearances
        TEXT start_year
    }

    cv_volume ||--o{ cv_issue : volume_id
    cv_publisher ||--o{ cv_volume : publisher_id
    cv_volume ||--o{ cv_volume_credit : "SRV-6c"
    cv_volume ||--o{ cv_volume_issue_ref : "SRV-6c"
    cv_issue ||--o{ cv_volume_issue_ref : "first/last issue"
    cv_issue }o..o{ cv_person : person_credits
    cv_issue }o..o{ cv_storyarc : story_arc_credits
    cv_issue }o..o{ cv_team : team_credits
    cv_person }o..o{ cv_volume : volume_credits
    cv_person }o..o{ cv_issue : issue_credits
    cv_team }o..o{ cv_issue : issue_credits
    cv_publisher }o..o{ cv_volume : volumes
    cv_storyarc }o..o{ cv_issue : issues
```

Notes on the schema:

- `cv_sync_metadata` (endpoint, last_sync_date, last_sync_timestamp, resume_state) tracks updater progress per endpoint — not shown above.
- **`cv_volume` is normalized (SRV-6c):** its credit collections and first/last issue references live in the `cv_volume_credit` / `cv_volume_issue_ref` join tables, not JSON columns (the JSON columns are dropped by the updater backfill). `credits_presence` is a bitmask the server uses to tell an empty `[]` from a `null` collection. The other tables still store their relationships as JSON text (dotted edges) and are staged for the same treatment (SRV-6a/b/d/e/f).
- **`cv_volume_issue_ref` is a true join to `cv_issue`:** it stores only the issue `id` (FK) and the emitted `key_order`; the server resolves `name`/`issue_number`/`api_detail_url` by joining `cv_issue`. Unlike the credit entities (no local table), issues *do* have a local table, so the denormalized snapshot is not needed. A `LEFT JOIN` keeps a ref whose issue id isn't in the (synced-subset) `cv_issue` table, emitting the id with `null` display fields.
- Referenced ids inside JSON collections usually do **not** resolve to local rows (the DB is a synced subset), and character/location/object/movie have no local table at all — the denormalized fields inside the JSON are the only source of that data. In `cv_volume_credit` the credit rows likewise keep `name`/`api_detail_url`/`site_detail_url` inline for the same reason.
- `comicdb_*.db` (raw dumps), dated `localcv-*.db` snapshots, and the FTS tables (`volume_fts*`, `comic_covers`, `comic_files`) are out of scope for the API and excluded here.

## Notes

- **Server** is a single file, zero npm deps: `node:http` + `node:sqlite`. Every **list** endpoint honors `?sort=` (SRV-1); only `search` honors `COMICVINE_FORCED_LIMIT`.
- **Search** matches `name LIKE %query%` per selected resource (volumes newest-first, issues by numeric issue number), concatenates the hits in resource order, then slices one page — so `number_of_total_results` is the combined count across resources.
- **Updater** is incremental by default (`date_last_updated` filter since last safe sync date); `--full` drops the filter but is gated behind a `yes` confirmation (UPD-2). `validateApiKey` runs once at startup — a `100` there aborts the whole run (`exit 1`); a `100`/exhausted-`107` *mid-run* just makes `apiCall` return `null` and that endpoint is skipped. Skipped endpoints don't advance `cv_sync_metadata`, so the next run re-syncs from the old start date.
- Credit/relationship columns are JSON text; the server parses them in JS, never in SQL.
