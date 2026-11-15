#!/usr/bin/env node
/**
 * Schema migration module (UPD-17).
 *
 * Extracts the updater's schema-creation and one-shot-migration code into a
 * stand-alone, independently testable module. `migrate(conn)` brings a
 * database to the final schema in two phases:
 *
 *   1. Final schema (idempotent CREATEs): creates the tables a database needs
 *      (metadata, resource, join, FTS). These run on every call and are no-ops
 *      where the objects already exist; a fresh database gets the final schema
 *      directly.
 *   2. One-shot migrations (versioned): an ordered list of {version, up} that
 *      upgrade pre-existing databases (ALTER/backfill/drop). Each is idempotent
 *      (PRAGMA-guarded) and guarded by a `schema_version` stamp: only migrations
 *      with version > the stamped version run, and the stamp advances only when
 *      a migration fully completes (a partial migration re-runs on the next
 *      call — safe because the migrations are idempotent).
 *
 * The updater's `runSync` calls `migrate(conn, log)` first, preserving today's
 * zero-friction self-healing (a new release's migration applies on the next
 * sync, including the Docker cron deployment) while making schema changes
 * explicit and fail-fast: a fatal migration error aborts before any API calls
 * or sync-state mutation, instead of entangling with resume logic mid-sync.
 * The server stays read-only and adaptive — it never migrates, so this is
 * updater-side only.
 *
 * The `schema_version` stamp lives in a dedicated single-row `schema_version`
 * table rather than a sentinel row in `cv_sync_metadata`: a sentinel row would
 * appear in the server's `/api/status` `sync_metadata` array (a visible
 * behavior change requiring a server edit), and a `cv_*`-prefixed table would
 * appear in its `tables` object. Prefix-less (like `sync_errors`), the stamp
 * table is invisible to the server and requires no server change.
 *
 * Usage:
 *   node src/migrate.js [--db <path>]
 *   npm run migrate
 *
 * Uses node:sqlite (zero npm dependencies). No API calls are made.
 */
"use strict";

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Column names of a table (an empty list when the table does not exist — a
// PRAGMA on an absent table yields no rows, so the guards below are no-ops).
function tableColumns(conn, table) {
  return conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// Run fn() inside a transaction; roll back and rethrow on failure. SQLite DDL
// is transactional, so a failed migration leaves no partial state behind.
function inTransaction(conn, fn) {
  conn.exec("BEGIN");
  try {
    fn();
    conn.exec("COMMIT");
  } catch (e) {
    try { conn.exec("ROLLBACK"); } catch { /* not in a transaction */ }
    throw e;
  }
}

// The eleven resource base tables, in the RESOURCES registry order (updater.js).
// Kept in lockstep with that registry: when a resource is added there, add its
// table here too (a new base table gets an FTS index on the next migrate).
// migrate.js deliberately does not require updater.js (the updater requires
// this module, so a reverse require would be circular).
const FTS_BASE_TABLES = [
  { table: "cv_publisher", fts: "cv_publisher_fts" },
  { table: "cv_person",    fts: "cv_person_fts" },
  { table: "cv_volume",    fts: "cv_volume_fts" },
  { table: "cv_issue",     fts: "cv_issue_fts" },
  { table: "cv_team",      fts: "cv_team_fts" },
  { table: "cv_storyarc",  fts: "cv_storyarc_fts" },
  { table: "cv_concept",   fts: "cv_concept_fts" },
  { table: "cv_character", fts: "cv_character_fts" },
  { table: "cv_location",  fts: "cv_location_fts" },
  { table: "cv_power",     fts: "cv_power_fts" },
  { table: "cv_object",    fts: "cv_object_fts" }
];

// ─── Final schema: idempotent CREATEs ────────────────────────────────────────
// These create the *final* schema (fresh databases get it directly; existing
// databases are untouched by CREATE ... IF NOT EXISTS). The one-shot upgrades
// for pre-existing databases live in the versioned MIGRATIONS list below.

// Sync bookkeeping: per-endpoint last-sync tracking (+ resume state) and the
// persistent record of rows the updater could not store (FK failures etc.).
function ensureMetadataTables(conn, log) {
  if (!conn) return;
  conn.exec(`
    CREATE TABLE IF NOT EXISTS cv_sync_metadata (
      endpoint TEXT PRIMARY KEY,
      last_sync_date TEXT NOT NULL,
      last_sync_timestamp TEXT NOT NULL,
      resume_state TEXT
    )
  `);
  conn.exec(`
    CREATE TABLE IF NOT EXISTS sync_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      action TEXT NOT NULL,
      error TEXT,
      row_data TEXT,
      created_at TEXT NOT NULL
    )
  `);
  // UPD-17: the schema_version stamp table (single row; invisible to the
  // server's /api/status, which enumerates cv_* tables and cv_sync_metadata).
  conn.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY,
      version INTEGER NOT NULL
    )
  `);
}

// The seven resource tables the Node updater creates (the four legacy tables —
// cv_publisher/cv_issue/cv_volume/cv_person — are Python-updater heritage and
// are never created here; see DB-3). The CREATEs describe the final schema:
// cv_concept already carries first_appeared_in_issue_id and no
// api_detail_url / first_appeared_in_issue JSON (the UPD-13/UPD-11/UPD-15
// upgrades for pre-existing databases are versioned migrations below).
function ensureResourceTables(conn, log) {
  if (!conn) return;
  conn.exec(`
    CREATE TABLE IF NOT EXISTS cv_team (
      id INTEGER PRIMARY KEY, name TEXT, publisher TEXT, aliases TEXT,
      count_of_team_members INTEGER, count_of_issue_appearances INTEGER,
      deck TEXT, description TEXT, date_added TEXT, date_last_updated TEXT,
      image_url TEXT, site_detail_url TEXT, first_appeared_in_issue TEXT,
      character_enemies TEXT, character_friends TEXT, characters TEXT,
      disbanded_in_issues TEXT, issue_credits TEXT, issues_disbanded_in TEXT,
      movies TEXT, story_arc_credits TEXT, volume_credits TEXT
    )
  `);
  conn.exec(`
    CREATE TABLE IF NOT EXISTS cv_storyarc (
      id INTEGER PRIMARY KEY, name TEXT, publisher TEXT, aliases TEXT,
      count_of_issue_appearances INTEGER, deck TEXT, description TEXT,
      date_added TEXT, date_last_updated TEXT, image_url TEXT,
      site_detail_url TEXT, first_appeared_in_issue TEXT, issues TEXT, movies TEXT
    )
  `);
  conn.exec(`
    CREATE TABLE IF NOT EXISTS cv_concept (
      id INTEGER PRIMARY KEY, name TEXT, aliases TEXT,
      deck TEXT, description TEXT, date_added TEXT, date_last_updated TEXT,
      image_url TEXT, site_detail_url TEXT, first_appeared_in_issue_id INTEGER,
      count_of_issue_appearances INTEGER, start_year TEXT
    )
  `);
  // SRV-3: the four 404 resources. The relationship collections are stored as
  // JSON text (the pre-SRV-6 denormalized pattern); their normalization
  // belongs with SRV-6. first_appeared_in_issue is stored as the issue id (the
  // UPD-15 concept pattern) so the server can derive the object and join
  // cv_issue.
  conn.exec(`
    CREATE TABLE IF NOT EXISTS cv_character (
      id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, real_name TEXT,
      birth TEXT, gender INTEGER, deck TEXT, description TEXT,
      date_added TEXT, date_last_updated TEXT, image_url TEXT,
      site_detail_url TEXT, first_appeared_in_issue_id INTEGER,
      count_of_issue_appearances INTEGER,
      publisher TEXT, origin TEXT, teams TEXT, movies TEXT, powers TEXT,
      creators TEXT, issue_credits TEXT, volume_credits TEXT,
      story_arc_credits TEXT, issues_died_in TEXT, character_enemies TEXT,
      character_friends TEXT, team_enemies TEXT, team_friends TEXT
    )
  `);
  conn.exec(`
    CREATE TABLE IF NOT EXISTS cv_location (
      id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, deck TEXT,
      description TEXT, start_year TEXT, date_added TEXT, date_last_updated TEXT,
      image_url TEXT, site_detail_url TEXT, first_appeared_in_issue_id INTEGER,
      count_of_issue_appearances INTEGER,
      issue_credits TEXT, volume_credits TEXT, story_arc_credits TEXT, movies TEXT
    )
  `);
  conn.exec(`
    CREATE TABLE IF NOT EXISTS cv_power (
      id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, description TEXT,
      date_added TEXT, date_last_updated TEXT, image_url TEXT,
      site_detail_url TEXT, characters TEXT
    )
  `);
  // SRV-3: object — the same shape as location (17 fields, verified against
  // the verbatim raw-API dump on 2026-11-14).
  conn.exec(`
    CREATE TABLE IF NOT EXISTS cv_object (
      id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, deck TEXT,
      description TEXT, start_year TEXT, date_added TEXT, date_last_updated TEXT,
      image_url TEXT, site_detail_url TEXT, first_appeared_in_issue_id INTEGER,
      count_of_issue_appearances INTEGER,
      issue_credits TEXT, volume_credits TEXT, story_arc_credits TEXT, movies TEXT
    )
  `);
  // Seed last_sync_date for new endpoints at the raw-dump snapshot date.
  const snapshot = "2026-01-22";
  const timestamp = new Date().toISOString();
  for (const endpoint of ["teams", "storyarcs", "concepts", "characters", "locations", "objects", "powers"]) {
    conn.prepare(
      `INSERT INTO cv_sync_metadata (endpoint, last_sync_date, last_sync_timestamp)
       VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO NOTHING`
    ).run(endpoint, snapshot, timestamp);
  }
}

// The n:n join tables (final schema). SRV-6c's cv_volume_credit /
// cv_volume_issue_ref and UPD-14's cv_concept_credit; the credit entries'
// denormalized display fields are kept inline per the SRV-6 design note.
function ensureJoinTables(conn, log) {
  if (!conn) return;
  conn.exec(`
    CREATE TABLE IF NOT EXISTS cv_volume_credit (
      volume_id INTEGER NOT NULL,
      credit_type TEXT NOT NULL,
      position INTEGER NOT NULL,
      credit_id INTEGER,
      name TEXT,
      count TEXT,
      api_detail_url TEXT,
      site_detail_url TEXT,
      PRIMARY KEY (volume_id, credit_type, position)
    )
  `);
  conn.exec(`
    CREATE INDEX IF NOT EXISTS idx_volume_credit_type
      ON cv_volume_credit (credit_type, credit_id)
  `);
  conn.exec(`
    CREATE TABLE IF NOT EXISTS cv_volume_issue_ref (
      volume_id INTEGER NOT NULL,
      ref_type TEXT NOT NULL,
      issue_id INTEGER,
      key_order TEXT,
      PRIMARY KEY (volume_id, ref_type)
    )
  `);
  conn.exec(`
    CREATE TABLE IF NOT EXISTS cv_concept_credit (
      concept_id INTEGER NOT NULL,
      credit_type TEXT NOT NULL,
      position INTEGER NOT NULL,
      credit_id INTEGER,
      name TEXT,
      api_detail_url TEXT,
      site_detail_url TEXT,
      PRIMARY KEY (concept_id, credit_type, position)
    )
  `);
  conn.exec(`
    CREATE INDEX IF NOT EXISTS idx_concept_credit_type
      ON cv_concept_credit (credit_type, credit_id)
  `);
  // SRV-6a: the four publisher relationship collections (characters, story_arcs,
  // teams, volumes) normalized into a single join table (the concepts pattern,
  // UPD-14 — no count column, since the entries carry none). The live API never
  // returns null for these (always an array), so no presence bitmask is needed.
  conn.exec(`
    CREATE TABLE IF NOT EXISTS cv_publisher_credit (
      publisher_id INTEGER NOT NULL,
      credit_type TEXT NOT NULL,
      position INTEGER NOT NULL,
      credit_id INTEGER,
      name TEXT,
      api_detail_url TEXT,
      site_detail_url TEXT,
      PRIMARY KEY (publisher_id, credit_type, position)
    )
  `);
  conn.exec(`
    CREATE INDEX IF NOT EXISTS idx_publisher_credit_type
      ON cv_publisher_credit (credit_type, credit_id)
  `);
}

// SRV-5: FTS5 full-text search indexes (final schema, not a migration). The
// eleven resource tables, in the order the server searches them. Each is indexed
// on the searchable text columns (name, aliases, deck, description); the
// trigram tokenizer is case-insensitive and matches substrings, which is the
// same semantics the server's legacy LIKE matching used (SRV-5).
function ensureFtsTables(conn, log) {
  if (!conn) return;
  for (const { table, fts } of FTS_BASE_TABLES) {
    let exists;
    try {
      exists = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table)?.name;
    } catch {
      exists = null;
    }
    if (!exists) continue; // base resource table absent (e.g. minimal DB)

    const baseColumns = tableColumns(conn, table);
    if (!baseColumns.includes("id")) continue;
    const columns = ["name", "aliases", "deck", "description"].filter((c) => baseColumns.includes(c));
    if (columns.length === 0) continue;

    const ftsExists = conn.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(fts)?.name;
    if (ftsExists) continue; // already created; rebuilt in rebuildFtsIndex

    try {
      conn.exec(
        `CREATE VIRTUAL TABLE ${fts} USING fts5(${columns.join(", ")}, ` +
        `content='${table}', content_rowid='id', tokenize='trigram case_sensitive 0')`
      );
      log(`  Created ${fts} (${columns.join(", ")})`);
    } catch (e) {
      log(`  Warning: could not create ${fts}: ${e.message}`);
    }
  }
}

// ─── One-shot migrations (versioned) ─────────────────────────────────────────
// Ordered list of {version, up(conn, log)} that upgrade pre-existing databases
// (the Python-updater heritage through the Node rewrite). Each `up` is
// idempotent (PRAGMA-guarded, so re-running on an already-migrated database is
// a no-op) and returns true when it fully completes, false when it could not
// (the stamp then does not advance, and the migration re-runs on the next
// call — safe because the work is idempotent). A thrown error is fatal and
// aborts migrate() before any sync work.
//
// v2 (SRV-6c) and v5 (UPD-15) manage their own transactions (v2 batches to
// bound the WAL over ~160k volumes; v5 is one atomic add/backfill/drop); the
// single-ALTER migrations (v1, v3, v4) are atomic as single statements.

// v1: the resume_state column on cv_sync_metadata (Python-updater heritage
// databases predate it).
const MIGRATIONS = [
  {
    version: 1,
    name: "cv_sync_metadata.resume_state",
    up(conn, log) {
      const names = tableColumns(conn, "cv_sync_metadata");
      if (names.includes("resume_state")) return true;
      log("  Adding resume_state column to cv_sync_metadata...");
      try {
        conn.exec("ALTER TABLE cv_sync_metadata ADD COLUMN resume_state TEXT");
        return true;
      } catch (e) {
        log(`  Warning: Could not add resume_state column: ${e.message}`);
        return false;
      }
    }
  },

  // v2: SRV-6c — the six volume credit collections and the first/last issue
  // references are stored as JSON text on cv_volume. This normalizes them into
  // join tables so the server can generate the collections directly:
  //   - cv_volume_credit: one row per credit entry (credit_type + position).
  //   - cv_volume_issue_ref: one row per first/last issue reference, a true
  //     join to cv_issue (stores only the issue id + the emitted key order; the
  //     display fields are resolved from the issue row on read).
  //   - cv_volume.credits_presence: a bitmask (bit i = credit type i) that
  //     distinguishes an empty [] collection from a null one.
  // It backfills the join tables from the JSON columns and then drops those
  // columns. The live API returns collections only for issues, so volume
  // credits are historical; first/last issue keep refreshing via syncVolumes.
  {
    version: 2,
    name: "SRV-6c volume credit/issue-ref normalization",
    up(conn, log) {
      // Drop the denormalized snapshot columns if an older version of the
      // table still carries them (the display fields now come from cv_issue).
      for (const col of ["name", "issue_number", "api_detail_url"]) {
        const cols = tableColumns(conn, "cv_volume_issue_ref");
        if (cols.includes(col)) {
          try { conn.exec(`ALTER TABLE cv_volume_issue_ref DROP COLUMN ${col}`); } catch { /* ignore */ }
        }
      }

      // Add the presence bitmask column to older databases (idempotent).
      const volumeCols = tableColumns(conn, "cv_volume");
      if (!volumeCols.includes("credits_presence")) {
        log("  Adding credits_presence column to cv_volume...");
        try {
          conn.exec("ALTER TABLE cv_volume ADD COLUMN credits_presence INTEGER");
        } catch (e) {
          log(`  Warning: Could not add credits_presence: ${e.message}`);
        }
      }

      const creditCols = volumeCols.filter((c) => c.endsWith("_credits"));
      const hasFirstLast = volumeCols.includes("first_issue") || volumeCols.includes("last_issue");
      // Nothing to migrate if the JSON columns are already gone (new schema).
      if (creditCols.length === 0 && !hasFirstLast) return true;

      log("  Normalizing volume credits into join tables...");
      try {
        const creditTypes = ["character", "concept", "location", "object", "person", "team"];
        const insertCredit = conn.prepare(
          `INSERT OR REPLACE INTO cv_volume_credit
             (volume_id, credit_type, position, credit_id, name, count, api_detail_url, site_detail_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const insertRef = conn.prepare(
          `INSERT OR REPLACE INTO cv_volume_issue_ref
             (volume_id, ref_type, issue_id, key_order)
           VALUES (?, ?, ?, ?)`
        );
        const setMask = conn.prepare(
          "UPDATE cv_volume SET credits_presence = ? WHERE id = ?"
        );
        const deleteCredits = conn.prepare(
          "DELETE FROM cv_volume_credit WHERE volume_id = ? AND credit_type = ?"
        );
        const deleteRef = conn.prepare(
          "DELETE FROM cv_volume_issue_ref WHERE volume_id = ? AND ref_type = ?"
        );

        // Process in id-ordered batches so memory stays bounded (the DB has ~160k
        // volumes and ~4M credit rows). The DELETE-then-INSERT per (volume, type)
        // makes the migration idempotent on re-run.
        const batchSize = 2000;
        let minId = null;
        let migrated = 0;
        for (;;) {
          const rows = conn.prepare(
            `SELECT * FROM cv_volume WHERE id > ? ORDER BY id LIMIT ?`
          ).all(minId ?? 0, batchSize);
          if (rows.length === 0) break;

          // One transaction per batch keeps the WAL bounded; a failure after a
          // committed batch is safe because the migration is idempotent (the
          // DELETE-then-INSERT re-runs cleanly) and the column drop runs only
          // after every batch has committed.
          conn.exec("BEGIN");
          for (const row of rows) {
            let mask = 0;
            for (let i = 0; i < creditTypes.length; i++) {
              const type = creditTypes[i];
              const col = `${type}_credits`;
              if (!volumeCols.includes(col)) continue;
              const raw = row[col];
              if (raw === null || raw === undefined) continue; // null: leave bit 0
              mask |= 1 << i; // non-null (array, possibly []): set the bit
              let entries;
              try {
                entries = JSON.parse(raw);
              } catch {
                continue;
              }
              if (!Array.isArray(entries)) continue;
              deleteCredits.run(row.id, type);
              entries.forEach((entry, position) => {
                insertCredit.run(
                  row.id, type, position,
                  entry.id ?? null, entry.name ?? null, entry.count ?? null,
                  entry.api_detail_url ?? null, entry.site_detail_url ?? null
                );
              });
            }

            for (const [field, refType] of [["first_issue", "first"], ["last_issue", "last"]]) {
              if (!volumeCols.includes(field)) continue;
              const raw = row[field];
              deleteRef.run(row.id, refType);
              if (raw === null || raw === undefined) continue;
              let ref;
              try {
                ref = JSON.parse(raw);
              } catch {
                continue;
              }
              if (!ref || typeof ref !== "object") continue;
              insertRef.run(
                row.id, refType,
                ref.id ?? null, JSON.stringify(Object.keys(ref))
              );
            }

            setMask.run(mask, row.id);
            migrated++;
          }
          conn.exec("COMMIT");

          minId = rows[rows.length - 1].id;
          log(`  Migrated ${migrated} volumes...`);
          if (rows.length < batchSize) break;
        }

        // Drop the now-redundant JSON columns to complete the normalization.
        const dropNames = [...creditCols];
        for (const f of ["first_issue", "last_issue"]) if (volumeCols.includes(f)) dropNames.push(f);
        if (dropNames.length > 0) {
          conn.exec("BEGIN");
          for (const name of dropNames) {
            conn.exec(`ALTER TABLE cv_volume DROP COLUMN ${name}`);
          }
          conn.exec("COMMIT");
        }
        log(`  Normalized volume credits for ${migrated} volumes.`);
        return true;
      } catch (e) {
        try { conn.exec("ROLLBACK"); } catch { /* not in a transaction */ }
        log(`  Warning: could not normalize volume credits: ${e.message}`, { force: true });
        return false;
      }
    }
  },

  // v3: UPD-13 — drop the api_detail_url column the server now derives from the
  // id (buildApiDetailUrl). The live value equals the canonical form for every
  // row, so the stored copy is redundant. Idempotent: no-op on a fresh table.
  {
    version: 3,
    name: "UPD-13 cv_concept.api_detail_url drop",
    up(conn, log) {
      const conceptCols = tableColumns(conn, "cv_concept");
      if (!conceptCols.includes("api_detail_url")) return true;
      log("  Dropping cv_concept.api_detail_url (now derived from the id)...");
      try {
        conn.exec("ALTER TABLE cv_concept DROP COLUMN api_detail_url");
        return true;
      } catch (e) {
        log(`  Warning: Could not drop cv_concept.api_detail_url: ${e.message}`);
        return false;
      }
    }
  },

  // v4: UPD-11 — drop the api_detail_url columns the server now derives from
  // the id (buildApiDetailUrl) for the four legacy tables. The live value
  // equals the canonical form for every non-NULL row (verified against
  // localcv.db), so the stored copies are redundant; NULL rows are filled by
  // the derivation (the UPD-7 window for issues). Idempotent: a PRAGMA on an
  // absent table yields no columns, so this is a no-op where a legacy table
  // does not exist.
  {
    version: 4,
    name: "UPD-11 legacy api_detail_url drops",
    up(conn, log) {
      let ok = true;
      for (const table of ["cv_publisher", "cv_issue", "cv_volume", "cv_person"]) {
        const cols = tableColumns(conn, table);
        if (cols.includes("api_detail_url")) {
          log(`  Dropping ${table}.api_detail_url (now derived from the id)...`);
          try {
            conn.exec(`ALTER TABLE ${table} DROP COLUMN api_detail_url`);
          } catch (e) {
            log(`  Warning: Could not drop ${table}.api_detail_url: ${e.message}`);
            ok = false;
          }
        }
      }
      return ok;
    }
  },

  // v5: UPD-15 — store first_appeared_in_issue as the issue id, not a JSON
  // blob. The object is fully determined by the id, so the server derives it
  // (api_detail_url via buildApiDetailUrl, name/issue_number via a LEFT JOIN
  // cv_issue). One atomic transaction: add the id column, backfill it from the
  // legacy JSON column, then drop that column. A failure rolls the whole thing
  // back (the JSON column is kept and the server falls back to reading it), so
  // no data is lost and no half-migrated state remains.
  {
    version: 5,
    name: "UPD-15 cv_concept.first_appeared_in_issue JSON→id",
    up(conn, log) {
      const conceptCols = tableColumns(conn, "cv_concept");
      const needsIdColumn = !conceptCols.includes("first_appeared_in_issue_id");
      const hasJsonColumn = conceptCols.includes("first_appeared_in_issue");
      // Nothing to migrate if the table is already on the final schema.
      if (!needsIdColumn && !hasJsonColumn) return true;

      try {
        inTransaction(conn, () => {
          if (needsIdColumn) {
            log("  Adding first_appeared_in_issue_id column to cv_concept...");
            conn.exec("ALTER TABLE cv_concept ADD COLUMN first_appeared_in_issue_id INTEGER");
          }
          if (hasJsonColumn) {
            log("  Backfilling cv_concept.first_appeared_in_issue_id from the JSON column...");
            const pending = conn.prepare(
              "SELECT id, first_appeared_in_issue FROM cv_concept " +
              "WHERE first_appeared_in_issue IS NOT NULL AND first_appeared_in_issue_id IS NULL"
            ).all();
            const update = conn.prepare(
              "UPDATE cv_concept SET first_appeared_in_issue_id = ? WHERE id = ?"
            );
            let filled = 0;
            for (const row of pending) {
              let parsed;
              try { parsed = JSON.parse(row.first_appeared_in_issue); } catch { continue; }
              const issueId = parsed && parsed.id != null ? parsed.id : null;
              if (issueId != null) { update.run(issueId, row.id); filled++; }
            }
            log(`  Backfilled ${filled} first_appeared_in_issue_id values.`);
            log("  Dropping cv_concept.first_appeared_in_issue (now derived from the id)...");
            conn.exec("ALTER TABLE cv_concept DROP COLUMN first_appeared_in_issue");
          }
        });
        return true;
      } catch (e) {
        log(`  Warning: first_appeared_in_issue_id migration failed: ${e.message}`);
        log("  Keeping cv_concept.first_appeared_in_issue (backfill did not complete).");
        return false;
      }
    }
  },

  // v6: UPD-8 — the six first_appearance_* collections are always `null` on the
  // live API, but the pre-UPD-8 updater stored them as `"[]"` (the `|| []`
  // coercion), so the server answered `[]` where the live API answers `null`.
  // Convert the `"[]"` rows to SQL NULL so the server (parseCredits) emits
  // `null`. The other ten collections are never null on the live API, so they
  // keep their `"[]"`/populated values. Idempotent: a re-run is a no-op (the
  // rows are already NULL). One transaction per column keeps the WAL bounded on
  // the ~1.1M-row table; a failure after a committed column is safe because the
  // backfill is idempotent and the migration re-runs on the next sync.
  {
    version: 6,
    name: "UPD-8 cv_issue first_appearance_* '[]'→NULL",
    up(conn, log) {
      const issueCols = tableColumns(conn, "cv_issue");
      const cols = [
        "first_appearance_characters", "first_appearance_concepts",
        "first_appearance_locations", "first_appearance_objects",
        "first_appearance_storyarcs", "first_appearance_teams"
      ].filter((c) => issueCols.includes(c));
      if (cols.length === 0) return true; // no cv_issue table (fresh DB) or no columns
      try {
        for (const c of cols) {
          inTransaction(conn, () => {
            const r = conn.prepare(`UPDATE cv_issue SET ${c} = NULL WHERE ${c} = '[]'`).run();
            log(`  Set ${r.changes} ${c} rows from "[]" to NULL.`);
          });
        }
        return true;
      } catch (e) {
        log(`  Warning: first_appearance_* backfill failed: ${e.message}`);
        return false;
      }
    }
  },

  // v7: SRV-6a — the four publisher relationship collections (characters,
  // story_arcs, teams, volumes) are stored as JSON text on cv_publisher. This
  // normalizes them into the cv_publisher_credit join table so the server can
  // generate the collections directly (one row per entry, credit_type + position).
  // The live API never returns null for these collections (always an array —
  // verified against the verbatim raw-API dump: null=0 across all 9,778
  // publishers), so no presence bitmask is needed (the concepts pattern, UPD-14):
  // a publisher with no join rows emits [] for each. It backfills the join table
  // from the JSON columns and then drops those columns. The collections are
  // historical (the updater's field_list never requests them), so they are
  // backfilled once and not refreshed by sync.
  {
    version: 7,
    name: "SRV-6a publisher collection normalization",
    up(conn, log) {
      const publisherCols = tableColumns(conn, "cv_publisher");
      const collectionCols = ["characters", "story_arcs", "teams", "volumes"].filter((c) => publisherCols.includes(c));
      // Nothing to migrate if the JSON columns are already gone (final schema) or
      // the table is absent (a fresh database has no cv_publisher — it is
      // Python-updater heritage, see DB-3).
      if (collectionCols.length === 0) return true;

      log("  Normalizing publisher collections into cv_publisher_credit...");
      try {
        const creditTypes = { characters: "character", story_arcs: "story_arc", teams: "team", volumes: "volume" };
        const insertCredit = conn.prepare(
          `INSERT OR REPLACE INTO cv_publisher_credit
             (publisher_id, credit_type, position, credit_id, name, api_detail_url, site_detail_url)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        const deleteCredits = conn.prepare(
          "DELETE FROM cv_publisher_credit WHERE publisher_id = ? AND credit_type = ?"
        );

        // Process in id-ordered batches so memory stays bounded. The
        // DELETE-then-INSERT per (publisher, type) makes the migration idempotent
        // on re-run. One transaction per batch keeps the WAL bounded; a failure
        // after a committed batch is safe because the migration is idempotent and
        // the column drop runs only after every batch has committed.
        const batchSize = 2000;
        let minId = null;
        let migrated = 0;
        for (;;) {
          const rows = conn.prepare(
            `SELECT * FROM cv_publisher WHERE id > ? ORDER BY id LIMIT ?`
          ).all(minId ?? 0, batchSize);
          if (rows.length === 0) break;

          conn.exec("BEGIN");
          for (const row of rows) {
            for (const [col, type] of Object.entries(creditTypes)) {
              if (!publisherCols.includes(col)) continue;
              const raw = row[col];
              if (raw === null || raw === undefined) continue; // null: no rows
              let entries;
              try {
                entries = JSON.parse(raw);
              } catch {
                continue;
              }
              if (!Array.isArray(entries)) continue;
              deleteCredits.run(row.id, type);
              entries.forEach((entry, position) => {
                insertCredit.run(
                  row.id, type, position,
                  entry.id ?? null, entry.name ?? null,
                  entry.api_detail_url ?? null, entry.site_detail_url ?? null
                );
              });
            }
            migrated++;
          }
          conn.exec("COMMIT");

          minId = rows[rows.length - 1].id;
          log(`  Migrated ${migrated} publishers...`);
          if (rows.length < batchSize) break;
        }

        // Drop the now-redundant JSON columns to complete the normalization.
        conn.exec("BEGIN");
        for (const col of collectionCols) {
          conn.exec(`ALTER TABLE cv_publisher DROP COLUMN ${col}`);
        }
        conn.exec("COMMIT");
        log(`  Normalized publisher collections for ${migrated} publishers.`);
        return true;
      } catch (e) {
        try { conn.exec("ROLLBACK"); } catch { /* not in a transaction */ }
        log(`  Warning: could not normalize publisher collections: ${e.message}`, { force: true });
        return false;
      }
    }
  }
];

// The final schema version: the highest migration version. A database stamped
// at this version needs no further one-shot migrations.
const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

// ─── schema_version stamp ────────────────────────────────────────────────────

// The current schema version (0 when the stamp table is absent or empty —
// pre-UPD-17 databases, which then run every migration; all are idempotent,
// so an un-stamped database is upgraded safely and then stamped).
function readSchemaVersion(conn) {
  try {
    const row = conn.prepare("SELECT version FROM schema_version WHERE id = 1").get();
    return row ? row.version : 0;
  } catch {
    return 0;
  }
}

// Stamp the database at the given schema version (single row, id = 1).
function stampSchemaVersion(conn, version) {
  conn.prepare(
    "INSERT INTO schema_version (id, version) VALUES (1, ?) " +
    "ON CONFLICT(id) DO UPDATE SET version = excluded.version"
  ).run(version);
}

// ─── migrate() ───────────────────────────────────────────────────────────────

// Bring the database to the final schema: apply the idempotent final-schema
// CREATEs, then run the one-shot migrations newer than the stamped version.
// Returns the resulting schema version. A fatal migration error throws (the
// caller — runSync or the CLI — aborts before any sync work); a migration that
// completes only partially logs a warning, leaves the stamp in place, and will
// re-run on the next call.
function migrate(conn, log = defaultLog) {
  if (!conn) return 0;

  // 1. Final schema (idempotent; no-ops on an already-final database).
  ensureMetadataTables(conn, log);
  ensureResourceTables(conn, log);
  ensureJoinTables(conn, log);
  ensureFtsTables(conn, log);

  // 2. One-shot migrations, guarded by the schema_version stamp.
  const current = readSchemaVersion(conn);
  if (current >= SCHEMA_VERSION) return current;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    log(`  Applying migration v${migration.version} (${migration.name})...`);
    let completed;
    try {
      completed = migration.up(conn, log);
    } catch (e) {
      // A thrown error (corrupt/locked database) is fatal: abort before any
      // API calls or sync-state mutation.
      throw new Error(`schema migration v${migration.version} (${migration.name}) failed: ${e.message}`);
    }
    if (!completed) {
      log(`  Migration v${migration.version} did not complete; it will re-run on the next sync.`, { force: true });
      break; // later migrations run once this one completes
    }
    stampSchemaVersion(conn, migration.version);
  }
  return readSchemaVersion(conn);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

// Console logger with the updater's log() signature (message, { force }).
// The CLI always logs (there is no --quiet: a standalone migration run should
// show what it did); the updater passes its own log() so --quiet is honored.
function defaultLog(message, { force = false } = {}) {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${timestamp}] ${message}`;
  if (message.startsWith("ERROR")) console.error(line);
  else console.log(line);
}

function parseArgs(argv) {
  const args = { dbPath: null, help: false, bad: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") args.dbPath = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else args.bad = arg;
  }
  return args;
}

function printHelp() {
  console.log(`
ComicVine SQLite Schema Migrator (Node.js)

Applies the schema migrations (src/migrate.js) to a localcv.db database:
creates any missing final-schema tables and runs the one-shot migrations
newer than the stamped schema_version. No API calls are made.

Usage:
  node src/migrate.js [--db <path>]
  npm run migrate

Options:
  --db <path>      Path to the database file (default: ./localcv.db)
  --help, -h       Show this help

The updater runs the same migrations automatically at the start of every
sync (npm run sync), so this command is only needed to migrate a database
without syncing (e.g. right after pulling a release with new migrations).
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.bad) {
    console.error(`ERROR: Unknown argument: ${args.bad} (see --help)`);
    process.exit(1);
  }

  const dbPath = args.dbPath || "./localcv.db";
  if (!fs.existsSync(dbPath)) {
    console.error(`ERROR: Database not found: ${dbPath}`);
    process.exit(1);
  }

  let conn;
  try {
    conn = new DatabaseSync(dbPath);
    // Same pragmas as the updater's connect(): WAL + NORMAL for the sync
    // workload, and FK enforcement so any migration write validates refs.
    conn.exec("PRAGMA journal_mode=WAL");
    conn.exec("PRAGMA synchronous=NORMAL");
    conn.exec("PRAGMA foreign_keys=ON");
  } catch (e) {
    console.error(`ERROR: Could not open database ${dbPath}: ${e.message}`);
    process.exit(1);
  }

  console.log(`Migrating database: ${dbPath}`);
  try {
    const version = migrate(conn, defaultLog);
    console.log(`Schema version: ${version} (final: ${SCHEMA_VERSION})`);
  } catch (e) {
    console.error(`ERROR: Migration failed: ${e.message}`);
    process.exit(1);
  } finally {
    conn.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  migrate,
  MIGRATIONS,
  SCHEMA_VERSION,
  readSchemaVersion,
  stampSchemaVersion,
  ensureMetadataTables,
  ensureResourceTables,
  ensureJoinTables,
  ensureFtsTables,
  FTS_BASE_TABLES
};
