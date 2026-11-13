#!/usr/bin/env node
/**
 * ComicVine SQLite Database Updater (Node.js)
 *
 * A stand-alone script to keep a localcv.db SQLite database updated with
 * new ComicVine data. Fetches publishers, people, volumes, issues, teams,
 * story arcs, and concepts that have been added or modified since the last sync.
 *
 * Uses node:sqlite + global fetch (zero npm dependencies).
 *
 * Configuration is read from `.env` (COMICVINE_API_KEY) or the process
 * environment.
 *
 * Usage:
 *   node src/updater.js [database_path]
 *   node src/updater.js --non-interactive --db-dir /path/to/db
 *   node src/updater.js --full [database_path]
 *   node src/updater.js --full --yes [database_path]
 *   node src/updater.js --resource issues [database_path]
 *   COMICVINE_API_KEY=your_key node src/updater.js --non-interactive --db-dir /path/to/db
 *
 * npm run sync          — incremental sync
 * npm run sync:full     — one-time full sync (thousands of API calls)
 *
 * A full sync is expensive (one call per page across all ten endpoints, i.e.
 * ~1.1M issue-detail calls). It is gated behind an interactive "yes" prompt,
 * or the --yes flag in non-interactive runs (UPD-2).
 *
 * --resource <name> restricts the run to specific resource(s) instead of all
 * ten — repeatable and/or comma-separated, accepting the endpoint name, the
 * cv_* table name, or the singular (e.g. issue / issues / cv_issue). Post-sync
 * maintenance (volume/issue-count recalc, FTS rebuild) runs only for the
 * selected resources (UPD-12).
 */

"use strict";

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline/promises");

// ─── API Configuration ───────────────────────────────────────────────────────
const API_BASE_URL = "https://comicvine.gamespot.com/api/";
const HEADERS = {
  "User-Agent": "LocalCVUpdater/1.0",
  From: "comicvine-user@example.com"
};
const API_DELAY_SECONDS = 1.5;
const MAX_RETRIES = 5;
const RATE_LIMIT_STATUS = 107;
const RATE_LIMIT_BACKOFF_SECONDS = 60;

// ─── Resources (UPD-12) ──────────────────────────────────────────────────────
//
// The ten endpoints runSync can sync, in the order they run. `name` is the
// endpoint (and the cv_sync_metadata key); `method` is the sync method;
// `table` is the cv_* table; `stats` is the stats-key prefix (note: the
// `people` endpoint reports under `persons_*`); `statsLabel` is the display
// name in the summary; `fts` is the FTS5 index; `aliases` are the other names
// a user may pass to --resource (singular + table name).
const RESOURCES = [
  { name: "publishers", method: "syncPublishers", label: "publishers",  stats: "publishers", statsLabel: "Publishers",  table: "cv_publisher", fts: "cv_publisher_fts", aliases: ["publisher", "cv_publisher"] },
  { name: "people",     method: "syncPersons",    label: "people",      stats: "persons",    statsLabel: "Persons",     table: "cv_person",    fts: "cv_person_fts",    aliases: ["person", "persons", "cv_person"] },
  { name: "volumes",    method: "syncVolumes",    label: "volumes",     stats: "volumes",    statsLabel: "Volumes",     table: "cv_volume",    fts: "cv_volume_fts",    aliases: ["volume", "cv_volume"] },
  { name: "issues",     method: "syncIssues",     label: "issues",      stats: "issues",     statsLabel: "Issues",      table: "cv_issue",     fts: "cv_issue_fts",     aliases: ["issue", "cv_issue"] },
  { name: "teams",      method: "syncTeams",      label: "teams",       stats: "teams",      statsLabel: "Teams",       table: "cv_team",      fts: "cv_team_fts",      aliases: ["team", "cv_team"] },
  { name: "storyarcs",  method: "syncStoryarcs",  label: "story arcs",  stats: "storyarcs",  statsLabel: "Story arcs",   table: "cv_storyarc",  fts: "cv_storyarc_fts",  aliases: ["storyarc", "story_arc", "story_arcs", "cv_storyarc"] },
  { name: "concepts",   method: "syncConcepts",   label: "concepts",    stats: "concepts",   statsLabel: "Concepts",    table: "cv_concept",   fts: "cv_concept_fts",   aliases: ["concept", "cv_concept"] },
  // SRV-3: the three remaining 404 resources (object stays open). Their live
  // list endpoints return the scalar fields plus the relationship collections,
  // so a single-phase list-paging sync (the teams/publishers pattern) is
  // sufficient — no two-phase detail calls.
  { name: "characters", method: "syncCharacters", label: "characters",  stats: "characters", statsLabel: "Characters",  table: "cv_character", fts: "cv_character_fts", aliases: ["character", "cv_character"] },
  { name: "locations",  method: "syncLocations",  label: "locations",   stats: "locations",  statsLabel: "Locations",   table: "cv_location",  fts: "cv_location_fts",  aliases: ["location", "cv_location"] },
  { name: "powers",     method: "syncPowers",     label: "powers",      stats: "powers",     statsLabel: "Powers",      table: "cv_power",     fts: "cv_power_fts",     aliases: ["power", "cv_power"] }
];

// Resolve a user-supplied resource name (endpoint name, cv_* table name, or
// singular) to its registry entry. Returns null for an unknown name.
function resolveResource(input) {
  const key = String(input).trim().toLowerCase();
  return RESOURCES.find((r) => r.name === key || r.aliases.includes(key)) || null;
}

// Resolve a list of user-supplied names (each may itself be comma-separated)
// to registry entries, preserving first-seen order and deduplicating. Returns
// { resources, unknown } where `unknown` lists the names that did not resolve.
function resolveResources(inputs) {
  const resources = [];
  const unknown = [];
  const seen = new Set();
  for (const input of inputs) {
    for (const token of String(input).split(",").map((t) => t.trim()).filter(Boolean)) {
      const r = resolveResource(token);
      if (!r) {
        unknown.push(token);
        continue;
      }
      if (!seen.has(r.name)) {
        seen.add(r.name);
        resources.push(r);
      }
    }
  }
  return { resources, unknown };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function dateAddDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime());
}

// Make a value safe to bind into a SQLite parameter.
//
// The ComicVine API sometimes returns nested objects or arrays in fields that
// are otherwise scalar (e.g. `publisher` on teams/story arcs, an occasional
// dict `gender`). dict/list values are serialized to JSON text (matching the
// backfill storage format); null/undefined becomes SQL NULL.
//
// Booleans are coerced to 1/0: Python's sqlite3 module binds True/False as
// integers, but node:sqlite rejects booleans outright. Mirrors the Python
// updater's _jsonify() storage behavior.
function jsonify(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

// ─── Log Capture ─────────────────────────────────────────────────────────────

class LogCapture {
  constructor() {
    this._buffer = "";
    this._startTime = Date.now();
  }
  write(message) {
    if (!message.endsWith("\n")) message += "\n";
    this._buffer += message;
  }
  getContents() {
    return this._buffer;
  }
  getDuration() {
    const elapsed = Math.floor((Date.now() - this._startTime) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }
}

// ─── ComicVineUpdater ────────────────────────────────────────────────────────

class ComicVineUpdater {
  constructor(dbPath, apiKey, options = {}) {
    this.dbPath = dbPath;
    this.apiKey = apiKey;
    this.verbose = options.verbose !== false;
    this.logCapture = options.logCapture || null;
    this.full = Boolean(options.full);
    // UPD-12: restrict the run to specific resources (RESOURCES registry
    // entries). null/undefined = all ten.
    this.resources = options.resources || null;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    // Injectable delays (tests pass 0 to skip the real waits).
    this.apiDelayMs = options.apiDelayMs ?? API_DELAY_SECONDS * 1000;
    this.rateLimitBackoffMs = options.rateLimitBackoffMs ?? RATE_LIMIT_BACKOFF_SECONDS * 1000;
    this.http420BackoffMs = options.http420BackoffMs ?? 600 * 1000;
    this.conn = null;
    this.stats = {
      publishers_added: 0, publishers_updated: 0,
      persons_added: 0, persons_updated: 0,
      volumes_added: 0, volumes_updated: 0,
      issues_added: 0, issues_updated: 0,
      teams_added: 0, teams_updated: 0,
      storyarcs_added: 0, storyarcs_updated: 0,
      concepts_added: 0, concepts_updated: 0,
      characters_added: 0, characters_updated: 0,
      locations_added: 0, locations_updated: 0,
      powers_added: 0, powers_updated: 0,
      api_calls: 0
    };
  }

  log(message, { force = false } = {}) {
    if (this.verbose || force) {
      const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
      const line = `[${timestamp}] ${message}`;
      if (message.startsWith("ERROR")) console.error(line);
      else console.log(line);
    }
    if (this.logCapture) {
      const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
      this.logCapture.write(`[${timestamp}] ${message}`);
    }
  }

  connect() {
    if (!fs.existsSync(this.dbPath)) {
      this.log(`ERROR: Database not found: ${this.dbPath}`, { force: true });
      return false;
    }
    try {
      this.conn = new DatabaseSync(this.dbPath);
      this.conn.exec("PRAGMA journal_mode=WAL");
      this.conn.exec("PRAGMA synchronous=NORMAL");
      // Enforce FKs on this connection. The live API returns ids for volumes
      // that have no local row (the DB is a synced subset), and node:sqlite
      // only throws FOREIGN KEY constraint failed when the pragma is ON, so
      // enabling it makes every upsert validate its FK references.
      this.conn.exec("PRAGMA foreign_keys=ON");
      this.log(`Connected to database: ${this.dbPath}`);
      return true;
    } catch (e) {
      this.log(`ERROR: Could not connect to database: ${e.message}`, { force: true });
      return false;
    }
  }

  close() {
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }
  }

  // Executes a statement, and on a FOREIGN KEY constraint failure logs exactly
  // which row/SQL/value caused it: the FK definition (PRAGMA
  // foreign_key_list), the FK's bound value, the full statement, and every
  // bound parameter. Dumps the offending row to sync_errors so there is a
  // persistent record, then rethrows so callers can continue/skip as before.
  runWithFkDiagnostics(table, sql, params, context) {
    try {
      return this.conn.prepare(sql).run(...params);
    } catch (e) {
      if (!/FOREIGN KEY constraint failed/i.test(e.message)) throw e;
      this.log(`  FK CONSTRAINT FAILED upserting ${table} (${context})`, { force: true });
      this.log(`    SQL: ${sql.replace(/\s+/g, " ").trim()}`, { force: true });
      this.log(`    Params: ${JSON.stringify(params)}`, { force: true });
      let fk = [];
      try {
        fk = this.conn.prepare(`PRAGMA foreign_key_list(${table})`).all();
      } catch {
        // Table may not exist / no FKs — diagnostics still work with empty list.
      }
      // Map column name -> parameter index in the upsert, by counting the ?
      // placeholders that precede each column name in the column list.
      const upsertSql = sql.replace(/\s+/g, " ").trim();
      const cols = (() => {
        try { return this.conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); }
        catch { return []; }
      })();
      const colParamPos = {};
      for (const col of cols) {
        const idx = upsertSql.indexOf(col);
        if (idx >= 0) colParamPos[col] = (upsertSql.slice(0, idx).match(/\?/g) || []).length;
      }
      for (const f of fk) {
        const paramPos = f.from in colParamPos ? colParamPos[f.from] : -1;
        const refKey = paramPos >= 0 && paramPos < params.length ? params[paramPos] : undefined;
        let refRow = null;
        if (refKey != null) {
          try {
            refRow = this.conn.prepare(`SELECT id, name FROM ${f.table} WHERE id = ?`).get(refKey);
          } catch {
            try { refRow = this.conn.prepare(`SELECT id FROM ${f.table} WHERE id = ?`).get(refKey); }
            catch { refRow = null; }
          }
        }
        this.log(
          `    FK: ${table}.${f.from} -> ${f.table}.${f.to}; value=${JSON.stringify(refKey)}; ` +
          `referenced row ${refRow ? `exists (id=${refRow.id}, name=${refRow.name})` : "MISSING locally"}`,
          { force: true }
        );
      }
      try {
        this.conn.prepare(
          `INSERT INTO sync_errors (table_name, action, error, row_data, created_at)
           VALUES (?, 'upsert', ?, ?, ?)`
        ).run(
          table, e.message,
          JSON.stringify({ context, params }),
          new Date().toISOString()
        );
      } catch {
        this.log("    (could not record row in sync_errors)", { force: true });
      }
      throw e;
    }
  }

  // ─── Schema helpers ─────────────────────────────────────────────────────

  ensureResourceTables() {
    if (!this.conn) return;
    this.conn.exec(`
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
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS cv_storyarc (
        id INTEGER PRIMARY KEY, name TEXT, publisher TEXT, aliases TEXT,
        count_of_issue_appearances INTEGER, deck TEXT, description TEXT,
        date_added TEXT, date_last_updated TEXT, image_url TEXT,
        site_detail_url TEXT, first_appeared_in_issue TEXT, issues TEXT, movies TEXT
      )
    `);
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS cv_concept (
        id INTEGER PRIMARY KEY, name TEXT, aliases TEXT,
        deck TEXT, description TEXT, date_added TEXT, date_last_updated TEXT,
        image_url TEXT, site_detail_url TEXT, first_appeared_in_issue_id INTEGER,
        count_of_issue_appearances INTEGER, start_year TEXT
      )
    `);
    // UPD-13: drop the api_detail_url column the server now derives from the id
    // (buildApiDetailUrl). The live value equals the canonical form for every row,
    // so the stored copy is redundant. Idempotent: no-op on a fresh table.
    const conceptCols = this.conn.prepare("PRAGMA table_info(cv_concept)").all().map((c) => c.name);
    if (conceptCols.includes("api_detail_url")) {
      this.log("  Dropping cv_concept.api_detail_url (now derived from the id)...");
      try {
        this.conn.exec("ALTER TABLE cv_concept DROP COLUMN api_detail_url");
      } catch (e) {
        this.log(`  Warning: Could not drop cv_concept.api_detail_url: ${e.message}`);
      }
    }
    // UPD-15: store first_appeared_in_issue as the issue id, not a JSON blob. The
    // object is fully determined by the id, so the server derives it (api_detail_url
    // via buildApiDetailUrl, name/issue_number via a LEFT JOIN cv_issue). Add the id
    // column to pre-UPD-15 databases, backfill it from the legacy JSON column, then
    // drop that column. Idempotent: a fresh table already has the id column and no
    // JSON column, so both blocks are no-ops.
    if (!conceptCols.includes("first_appeared_in_issue_id")) {
      this.log("  Adding first_appeared_in_issue_id column to cv_concept...");
      try {
        this.conn.exec("ALTER TABLE cv_concept ADD COLUMN first_appeared_in_issue_id INTEGER");
      } catch (e) {
        this.log(`  Warning: Could not add first_appeared_in_issue_id: ${e.message}`);
      }
    }
    if (conceptCols.includes("first_appeared_in_issue")) {
      this.log("  Backfilling cv_concept.first_appeared_in_issue_id from the JSON column...");
      let backfillOk = true;
      try {
        this.conn.exec("BEGIN");
        const pending = this.conn.prepare(
          "SELECT id, first_appeared_in_issue FROM cv_concept " +
          "WHERE first_appeared_in_issue IS NOT NULL AND first_appeared_in_issue_id IS NULL"
        ).all();
        const update = this.conn.prepare(
          "UPDATE cv_concept SET first_appeared_in_issue_id = ? WHERE id = ?"
        );
        let filled = 0;
        for (const row of pending) {
          let parsed;
          try { parsed = JSON.parse(row.first_appeared_in_issue); } catch { continue; }
          const issueId = parsed && parsed.id != null ? parsed.id : null;
          if (issueId != null) { update.run(issueId, row.id); filled++; }
        }
        this.conn.exec("COMMIT");
        this.log(`  Backfilled ${filled} first_appeared_in_issue_id values.`);
      } catch (e) {
        try { this.conn.exec("ROLLBACK"); } catch { /* not in a transaction */ }
        backfillOk = false;
        this.log(`  Warning: first_appeared_in_issue_id backfill failed: ${e.message}`);
      }
      // Only drop the JSON column once the id is safely backfilled; otherwise keep
      // it so no data is lost (the server still reads it as a fallback).
      if (backfillOk) {
        this.log("  Dropping cv_concept.first_appeared_in_issue (now derived from the id)...");
        try {
          this.conn.exec("ALTER TABLE cv_concept DROP COLUMN first_appeared_in_issue");
        } catch (e) {
          this.log(`  Warning: Could not drop cv_concept.first_appeared_in_issue: ${e.message}`);
        }
      } else {
        this.log("  Keeping cv_concept.first_appeared_in_issue (backfill did not complete).");
      }
    }
    // SRV-3: the three remaining 404 resources (object stays open). The
    // relationship collections are stored as JSON text (the pre-SRV-6
    // denormalized pattern); their normalization belongs with SRV-6.
    // first_appeared_in_issue is stored as the issue id (the UPD-15 concept
    // pattern) so the server can derive the object and join cv_issue.
    this.conn.exec(`
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
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS cv_location (
        id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, deck TEXT,
        description TEXT, start_year TEXT, date_added TEXT, date_last_updated TEXT,
        image_url TEXT, site_detail_url TEXT, first_appeared_in_issue_id INTEGER,
        count_of_issue_appearances INTEGER,
        issue_credits TEXT, volume_credits TEXT, story_arc_credits TEXT, movies TEXT
      )
    `);
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS cv_power (
        id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, description TEXT,
        date_added TEXT, date_last_updated TEXT, image_url TEXT,
        site_detail_url TEXT, characters TEXT
      )
    `);
    // Seed last_sync_date for new endpoints at the raw-dump snapshot date.
    const snapshot = "2026-01-22";
    const timestamp = new Date().toISOString();
    for (const endpoint of ["teams", "storyarcs", "concepts", "characters", "locations", "powers"]) {
      this.conn.prepare(
        `INSERT INTO cv_sync_metadata (endpoint, last_sync_date, last_sync_timestamp)
         VALUES (?, ?, ?)
         ON CONFLICT(endpoint) DO NOTHING`
      ).run(endpoint, snapshot, timestamp);
    }
  }

  // ─── SRV-6c: volume credit/issue-reference normalization ───────────────

  // The six volume credit collections and the first/last issue references are
  // stored as JSON text on cv_volume. This method normalizes them into join
  // tables so the server can generate the collections directly:
  //   - cv_volume_credit: one row per credit entry (credit_type + position).
  //   - cv_volume_issue_ref: one row per first/last issue reference, a true
  //     join to cv_issue (stores only the issue id + the emitted key order; the
  //     display fields are resolved from the issue row on read).
  //   - cv_volume.credits_presence: a bitmask (bit i = credit type i) that
  //     distinguishes an empty [] collection from a null one.
  // It backfills the join tables from the JSON columns and then drops those
  // columns. The live API returns collections only for issues, so volume
  // credits are historical; first/last issue keep refreshing via syncVolumes.
  ensureVolumeCreditTables() {
    if (!this.conn) return;
    this.conn.exec(`
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
    this.conn.exec(`
      CREATE INDEX IF NOT EXISTS idx_volume_credit_type
        ON cv_volume_credit (credit_type, credit_id)
    `);
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS cv_volume_issue_ref (
        volume_id INTEGER NOT NULL,
        ref_type TEXT NOT NULL,
        issue_id INTEGER,
        key_order TEXT,
        PRIMARY KEY (volume_id, ref_type)
      )
    `);
    // SRV-6c: drop the denormalized snapshot columns if an older version of the
    // table still carries them (the display fields now come from cv_issue).
    for (const col of ["name", "issue_number", "api_detail_url"]) {
      const cols = this.conn.prepare("PRAGMA table_info(cv_volume_issue_ref)").all().map((c) => c.name);
      if (cols.includes(col)) {
        try { this.conn.exec(`ALTER TABLE cv_volume_issue_ref DROP COLUMN ${col}`); } catch { /* ignore */ }
      }
    }

    // Add the presence bitmask column to older databases (idempotent).
    const volumeCols = this.conn.prepare("PRAGMA table_info(cv_volume)").all().map((c) => c.name);
    if (!volumeCols.includes("credits_presence")) {
      this.log("  Adding credits_presence column to cv_volume...");
      try {
        this.conn.exec("ALTER TABLE cv_volume ADD COLUMN credits_presence INTEGER");
      } catch (e) {
        this.log(`  Warning: Could not add credits_presence: ${e.message}`);
      }
    }

    const creditCols = volumeCols.filter((c) => c.endsWith("_credits"));
    const hasFirstLast = volumeCols.includes("first_issue") || volumeCols.includes("last_issue");
    // Nothing to migrate if the JSON columns are already gone (new schema).
    if (creditCols.length === 0 && !hasFirstLast) return;

    this.log("  Normalizing volume credits into join tables...");
    try {
      const creditTypes = ["character", "concept", "location", "object", "person", "team"];
      const insertCredit = this.conn.prepare(
        `INSERT OR REPLACE INTO cv_volume_credit
           (volume_id, credit_type, position, credit_id, name, count, api_detail_url, site_detail_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertRef = this.conn.prepare(
        `INSERT OR REPLACE INTO cv_volume_issue_ref
           (volume_id, ref_type, issue_id, key_order)
         VALUES (?, ?, ?, ?)`
      );
      const setMask = this.conn.prepare(
        "UPDATE cv_volume SET credits_presence = ? WHERE id = ?"
      );
      const deleteCredits = this.conn.prepare(
        "DELETE FROM cv_volume_credit WHERE volume_id = ? AND credit_type = ?"
      );
      const deleteRef = this.conn.prepare(
        "DELETE FROM cv_volume_issue_ref WHERE volume_id = ? AND ref_type = ?"
      );

      // Process in id-ordered batches so memory stays bounded (the DB has ~160k
      // volumes and ~4M credit rows). The DELETE-then-INSERT per (volume, type)
      // makes the migration idempotent on re-run.
      const batchSize = 2000;
      let minId = null;
      let migrated = 0;
      for (;;) {
        const rows = this.conn.prepare(
          `SELECT * FROM cv_volume WHERE id > ? ORDER BY id LIMIT ?`
        ).all(minId ?? 0, batchSize);
        if (rows.length === 0) break;

        // One transaction per batch keeps the WAL bounded; a failure after a
        // committed batch is safe because the migration is idempotent (the
        // DELETE-then-INSERT re-runs cleanly) and the column drop runs only
        // after every batch has committed.
        this.conn.exec("BEGIN");
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
        this.conn.exec("COMMIT");

        minId = rows[rows.length - 1].id;
        this.log(`  Migrated ${migrated} volumes...`);
        if (rows.length < batchSize) break;
      }

      // Drop the now-redundant JSON columns to complete the normalization.
      const dropNames = [...creditCols];
      for (const f of ["first_issue", "last_issue"]) if (volumeCols.includes(f)) dropNames.push(f);
      if (dropNames.length > 0) {
        this.conn.exec("BEGIN");
        for (const name of dropNames) {
          this.conn.exec(`ALTER TABLE cv_volume DROP COLUMN ${name}`);
        }
        this.conn.exec("COMMIT");
      }
      this.log(`  Normalized volume credits for ${migrated} volumes.`);
    } catch (e) {
      try { this.conn.exec("ROLLBACK"); } catch { /* not in a transaction */ }
      this.log(`  Warning: could not normalize volume credits: ${e.message}`, { force: true });
    }
  }

  // ─── UPD-14: concept credit normalization ─────────────────────────────────

  // The three concept relationship collections (issue_credits, movies,
  // volume_credits) are stored in a join table so the server can generate them
  // directly (SRV-26). Modeled on SRV-6c's cv_volume_credit, minus the count
  // column (concept entries carry no count/role). No presence bitmask is needed:
  // the live API never returns null for these (always an array), so the server
  // emits [] for a concept with no rows. credit_id has no FK: movies have no
  // local table (SRV-3), and issue/volume refs may be absent from the subset DB;
  // the denormalized display fields are kept inline per the SRV-6 design note.
  // There is no backfill: the collections were never stored on cv_concept, so a
  // full concepts sync populates the table.
  ensureConceptCreditTables() {
    if (!this.conn) return;
    this.conn.exec(`
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
    this.conn.exec(`
      CREATE INDEX IF NOT EXISTS idx_concept_credit_type
        ON cv_concept_credit (credit_type, credit_id)
    `);
  }

  // ─── SRV-5: FTS5 full-text search indexes ────────────────────────────────

  // The seven resource tables, in the order the server searches them. Each is
  // indexed on the searchable text columns (name, aliases, deck, description);
  // the trigram tokenizer is case-insensitive and matches substrings, which is
  // the same semantics the server's legacy LIKE matching used (SRV-5).
  get FTS_RESOURCES() {
    // Derived from the RESOURCES registry (UPD-12) so the FTS indexes and the
    // sync endpoints stay in lockstep (same seven tables, same order).
    return RESOURCES.map((r) => ({ table: r.table, fts: r.fts }));
  }

  // Create the per-resource FTS5 trigram tables (external-content, keyed on the
  // base table's id/rowid). Idempotent: only creates a table if it is missing.
  // Only the text columns that actually exist on the base table are indexed.
  ensureFtsTables() {
    if (!this.conn) return;
    for (const { table, fts } of this.FTS_RESOURCES) {
      let exists;
      try {
        exists = this.conn.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
        ).get(table)?.name;
      } catch {
        exists = null;
      }
      if (!exists) continue; // base resource table absent (e.g. minimal DB)

      const baseColumns = this.conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!baseColumns.includes("id")) continue;
      const columns = ["name", "aliases", "deck", "description"].filter((c) => baseColumns.includes(c));
      if (columns.length === 0) continue;

      const ftsExists = this.conn.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(fts)?.name;
      if (ftsExists) continue; // already created; rebuilt in rebuildFtsIndex

      try {
        this.conn.exec(
          `CREATE VIRTUAL TABLE ${fts} USING fts5(${columns.join(", ")}, ` +
          `content='${table}', content_rowid='id', tokenize='trigram case_sensitive 0')`
        );
        this.log(`  Created ${fts} (${columns.join(", ")})`);
      } catch (e) {
        this.log(`  Warning: could not create ${fts}: ${e.message}`);
      }
    }
  }

  ensureMetadataTable() {
    if (!this.conn) return;
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS cv_sync_metadata (
        endpoint TEXT PRIMARY KEY,
        last_sync_date TEXT NOT NULL,
        last_sync_timestamp TEXT NOT NULL,
        resume_state TEXT
      )
    `);
    // Persistent record of rows the updater could not store (FK failures etc.)
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS sync_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        action TEXT NOT NULL,
        error TEXT,
        row_data TEXT,
        created_at TEXT NOT NULL
      )
    `);
    // Migration: add resume_state column to older DBs
    const cols = this.conn.prepare("PRAGMA table_info(cv_sync_metadata)").all();
    const names = cols.map((c) => c.name);
    if (!names.includes("resume_state")) {
      this.log("  Adding resume_state column to cv_sync_metadata...");
      try {
        this.conn.exec("ALTER TABLE cv_sync_metadata ADD COLUMN resume_state TEXT");
      } catch (e) {
        this.log(`  Warning: Could not add resume_state column: ${e.message}`);
      }
    }
  }

  // ─── Metadata ───────────────────────────────────────────────────────────

  getEndpointLastSync(endpoint) {
    if (!this.conn) return null;
    try {
      const row = this.conn.prepare(
        "SELECT last_sync_date FROM cv_sync_metadata WHERE endpoint = ?"
      ).get(endpoint);
      return row ? row.last_sync_date : null;
    } catch {
      return null;
    }
  }

  setEndpointLastSync(endpoint, dateStr) {
    if (!this.conn) return;
    const timestamp = new Date().toISOString();
    this.conn.prepare(
      `INSERT INTO cv_sync_metadata (endpoint, last_sync_date, last_sync_timestamp)
       VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         last_sync_date=excluded.last_sync_date,
         last_sync_timestamp=excluded.last_sync_timestamp`
    ).run(endpoint, dateStr, timestamp);
  }

  getResumeState(endpoint) {
    if (!this.conn) return null;
    try {
      const row = this.conn.prepare(
        "SELECT resume_state FROM cv_sync_metadata WHERE endpoint = ?"
      ).get(endpoint);
      if (row && row.resume_state) return JSON.parse(row.resume_state);
      return null;
    } catch {
      return null;
    }
  }

  saveResumeState(endpoint, state) {
    if (!this.conn) return;
    try {
      const stateJson = JSON.stringify(state);
      const result = this.conn.prepare(
        "UPDATE cv_sync_metadata SET resume_state = ? WHERE endpoint = ?"
      ).run(stateJson, endpoint);
      if (result.changes === 0) {
        // Fallback: insert if the row doesn't exist yet
        this.conn.prepare(
          `INSERT INTO cv_sync_metadata (endpoint, last_sync_date, last_sync_timestamp, resume_state)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET resume_state = excluded.resume_state`
        ).run(endpoint, todayStr(), new Date().toISOString(), stateJson);
      }
    } catch (e) {
      this.log(`  Warning: Could not save resume state: ${e.message}`);
    }
  }

  clearResumeState(endpoint) {
    if (!this.conn) return;
    try {
      this.conn.prepare(
        "UPDATE cv_sync_metadata SET resume_state = NULL WHERE endpoint = ?"
      ).run(endpoint);
    } catch { /* ignore */ }
  }

  calculateSafeStartDate(endpoint) {
    const lastSync = this.getEndpointLastSync(endpoint);
    if (lastSync) {
      if (isValidDate(lastSync)) return dateAddDays(lastSync, -1);
    }
    return dateAddDays(todayStr(), -30);
  }

  // ─── API Call ───────────────────────────────────────────────────────────

  async apiCall(endpoint, params = {}) {
    params.api_key = this.apiKey;
    params.format = "json";

    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined) searchParams.set(k, String(v));
    }
    const url = `${API_BASE_URL}${endpoint}?${searchParams.toString()}`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (this.apiDelayMs > 0) await sleep(this.apiDelayMs);
        this.stats.api_calls++;

        const response = await this.fetchFn(url, { headers: HEADERS });

        if (response.status === 420) {
          const waitMs = this.http420BackoffMs * (attempt + 1);
          this.log(`  Rate limited (HTTP 420). Waiting ${Math.round(waitMs / 1000)}s...`);
          if (waitMs > 0) await sleep(waitMs);
          continue;
        }

        if (!response.ok) {
          this.log(`  HTTP ${response.status} error`);
          if (attempt < MAX_RETRIES - 1) {
            await sleep(5000);
            continue;
          }
          return null;
        }

        const data = await response.json();

        if (data.status_code === RATE_LIMIT_STATUS) {
          const waitMs = this.rateLimitBackoffMs * (attempt + 1);
          this.log(
            `  Rate limit exceeded (status 107). Waiting ${Math.round(waitMs / 1000)}s ` +
            `before retry (${attempt + 1}/${MAX_RETRIES})...`
          );
          if (waitMs > 0) await sleep(waitMs);
          continue;
        }

        if (data.status_code === 100) {
          this.log("ERROR: Invalid API key!", { force: true });
          return null;
        }

        if (data.status_code !== 1) {
          const safeUrl = url.replace(/api_key=[^&]*/g, "api_key=***");
          this.log(`  API error: ${data.error || "Unknown error"} (${safeUrl})`);
          return null;
        }

        return data;
      } catch (e) {
        this.log(`  Request error: ${e.message} (attempt ${attempt + 1}/${MAX_RETRIES})`);
        if (attempt < MAX_RETRIES - 1) {
          await sleep(5000);
        }
      }
    }
    return null;
  }

  // ─── Sync Methods ───────────────────────────────────────────────────────

  async syncPublishers(startDate, endDate, full = false) {
    this.log(`\n--- Syncing Publishers ---${full ? " (FULL)" : ""}`);
    if (!this.conn) return;

    let offset = 0;
    const limit = 100;

    while (true) {
      const params = {
        field_list: "id,name,aliases,api_detail_url,deck,description," +
          "date_added,date_last_updated,location_address," +
          "location_city,location_state,image,site_detail_url",
        offset, limit
      };
      if (!full) params.filter = `date_last_updated:${startDate}|${endDate}`;
      params.sort = "date_last_updated:asc";

      const data = await this.apiCall("publishers/", params);
      if (!data) throw new Error("API call failed for publishers");

      const results = data.results || [];
      if (results.length === 0) break;

      this.conn.exec("BEGIN");
      for (const pub of results) {
        const pubId = pub.id;
        if (!pubId) continue;

        const image = pub.image || null;
        const imageUrl = image ? image.original_url : null;
        const exists = this.conn.prepare("SELECT id FROM cv_publisher WHERE id = ?").get(pubId);

        this.conn.prepare(`
          INSERT INTO cv_publisher
            (id, name, image_url, site_detail_url, aliases, api_detail_url,
             deck, description, date_added, date_last_updated,
             location_address, location_city, location_state,
             characters, story_arcs, teams, volumes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  COALESCE(?, '[]'), COALESCE(?, '[]'),
                  COALESCE(?, '[]'), COALESCE(?, '[]'))
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            image_url = excluded.image_url,
            site_detail_url = excluded.site_detail_url,
            aliases = excluded.aliases,
            api_detail_url = excluded.api_detail_url,
            deck = excluded.deck,
            description = excluded.description,
            date_added = excluded.date_added,
            date_last_updated = excluded.date_last_updated,
            location_address = excluded.location_address,
            location_city = excluded.location_city,
            location_state = excluded.location_state
        `).run(
          pubId, jsonify(pub.name), imageUrl, pub.site_detail_url,
          jsonify(pub.aliases), pub.api_detail_url,
          jsonify(pub.deck), jsonify(pub.description),
          jsonify(pub.date_added), jsonify(pub.date_last_updated),
          jsonify(pub.location_address), jsonify(pub.location_city),
          jsonify(pub.location_state),
          null, null, null, null
        );

        if (exists) this.stats.publishers_updated++;
        else this.stats.publishers_added++;
      }
      this.conn.exec("COMMIT");

      const total = data.number_of_total_results || 0;
      this.log(`  Processed ${offset + results.length}/${total} publishers`);

      if (results.length < limit) break;
      offset += limit;
    }

    this.setEndpointLastSync("publishers", endDate);
  }

  async syncPersons(startDate, endDate, full = false) {
    this.log(`\n--- Syncing Persons ---${full ? " (FULL)" : ""}`);
    if (!this.conn) return;

    let offset = 0;
    const limit = 100;

    while (true) {
      const params = {
        field_list: "id,name,aliases,api_detail_url,birth,country,death," +
          "gender,hometown,email,website,image,site_detail_url," +
          "count_of_isssue_appearances,deck,description," +
          "date_added,date_last_updated",
        offset, limit
      };
      if (!full) params.filter = `date_last_updated:${startDate}|${endDate}`;
      params.sort = "date_last_updated:asc";

      const data = await this.apiCall("people/", params);
      if (!data) throw new Error("API call failed for people");

      const results = data.results || [];
      if (results.length === 0) break;

      this.conn.exec("BEGIN");
      for (const person of results) {
        const personId = person.id;
        if (!personId) continue;

        const image = person.image || null;
        const imageUrl = image ? image.original_url : null;
        const exists = this.conn.prepare("SELECT id FROM cv_person WHERE id = ?").get(personId);

        const countOfIssueAppearances =
          person.count_of_isssue_appearances || person.count_of_issue_appearances;

        this.conn.prepare(`
          INSERT INTO cv_person
            (id, name, aliases, api_detail_url, birth, country, death,
             gender, hometown, email, website, image_url, deck,
             description, date_added, date_last_updated,
             count_of_issue_appearances, site_detail_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            aliases = excluded.aliases,
            api_detail_url = excluded.api_detail_url,
            birth = excluded.birth,
            country = excluded.country,
            death = excluded.death,
            gender = excluded.gender,
            hometown = excluded.hometown,
            email = excluded.email,
            website = excluded.website,
            image_url = excluded.image_url,
            deck = excluded.deck,
            description = excluded.description,
            date_added = excluded.date_added,
            date_last_updated = excluded.date_last_updated,
            count_of_issue_appearances = excluded.count_of_issue_appearances,
            site_detail_url = excluded.site_detail_url
        `).run(
          personId,
          person.name, jsonify(person.aliases),
          person.api_detail_url, jsonify(person.birth),
          jsonify(person.country), jsonify(person.death),
          jsonify(person.gender), jsonify(person.hometown),
          jsonify(person.email), jsonify(person.website), imageUrl,
          jsonify(person.deck), jsonify(person.description),
          jsonify(person.date_added), jsonify(person.date_last_updated),
          jsonify(countOfIssueAppearances), person.site_detail_url
        );

        if (exists) this.stats.persons_updated++;
        else this.stats.persons_added++;
      }
      this.conn.exec("COMMIT");

      const total = data.number_of_total_results || 0;
      this.log(`  Processed ${offset + results.length}/${total} persons`);

      if (results.length < limit) break;
      offset += limit;
    }

    this.setEndpointLastSync("people", endDate);
  }

  // Shared volume upsert (used by syncVolumes and by the issue-sync FK
  // recovery path, which back-fills a missing volume before retrying the issue).
  // Returns true on success, false if the upsert fails (e.g. missing
  // cv_volume_issue_ref table in a minimal DB) so callers can skip gracefully.
  upsertVolume(vol) {
    const volId = vol.id;
    if (!volId) return false;

    const image = vol.image || null;
    const imageUrl = image ? image.original_url : null;
    const publisher = vol.publisher || null;
    const publisherId = publisher ? publisher.id : null;
    const exists = this.conn.prepare("SELECT id FROM cv_volume WHERE id = ?").get(volId);

    try {
      this.conn.prepare(`
        INSERT INTO cv_volume
          (id, name, aliases, start_year, publisher_id, count_of_issues,
           description, image_url, site_detail_url, api_detail_url,
           deck, date_added, date_last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          aliases = excluded.aliases,
          start_year = excluded.start_year,
          publisher_id = excluded.publisher_id,
          count_of_issues = excluded.count_of_issues,
          description = excluded.description,
          image_url = excluded.image_url,
          site_detail_url = excluded.site_detail_url,
          api_detail_url = excluded.api_detail_url,
          deck = excluded.deck,
          date_added = excluded.date_added,
          date_last_updated = excluded.date_last_updated
      `).run(
        volId,
        jsonify(vol.name), jsonify(vol.aliases),
        jsonify(vol.start_year), publisherId,
        jsonify(vol.count_of_issues),
        jsonify(vol.description), imageUrl,
        vol.site_detail_url, vol.api_detail_url,
        jsonify(vol.deck), jsonify(vol.date_added),
        jsonify(vol.date_last_updated)
      );

      // SRV-6c: first/last issue live in the join table (the JSON columns were
      // dropped by the backfill). Preserve the live API's key order for output.
      for (const [ref, refType] of [[vol.first_issue, "first"], [vol.last_issue, "last"]]) {
        if (ref && typeof ref === "object") {
          this.runWithFkDiagnostics("cv_volume_issue_ref", `
        INSERT INTO cv_volume_issue_ref
          (volume_id, ref_type, issue_id, key_order)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(volume_id, ref_type) DO UPDATE SET
          issue_id = excluded.issue_id,
          key_order = excluded.key_order
      `, [volId, refType, ref.id ?? null, JSON.stringify(Object.keys(ref))],
            `volume ${volId} ${refType}_issue ref`);
        }
      }
    } catch (e) {
      this.log(`    ✗ Failed to upsert volume ${volId}: ${e.message}`);
      return false;
    }

    if (exists) this.stats.volumes_updated++;
    else this.stats.volumes_added++;
    return true;
  }

  // Fetch a single volume's detail from the live API (mirrors fetchIssueDetails).
  // Returns the volume object, or null if the API call fails / rate-limits.
  async fetchVolumeDetails(volumeId) {
    const fieldList = "id,name,aliases,start_year,publisher,count_of_issues," +
      "description,image,site_detail_url,api_detail_url,deck," +
      "date_added,date_last_updated,first_issue,last_issue";
    const data = await this.apiCall(`volume/4050-${volumeId}/`, { field_list: fieldList });
    if (data) return data.results;
    return null;
  }

  async syncVolumes(startDate, endDate, full = false) {
    this.log(`\n--- Syncing Volumes ---${full ? " (FULL)" : ""}`);
    if (!this.conn) return;

    let offset = 0;
    const limit = 100;

    while (true) {
      const params = {
        field_list: "id,name,aliases,start_year,publisher,count_of_issues," +
          "description,image,site_detail_url,api_detail_url,deck," +
          "date_added,date_last_updated,first_issue,last_issue",
        offset, limit
      };
      if (!full) params.filter = `date_last_updated:${startDate}|${endDate}`;
      params.sort = "date_last_updated:asc";

      const data = await this.apiCall("volumes/", params);
      if (!data) throw new Error("API call failed for volumes");

      const results = data.results || [];
      if (results.length === 0) break;

      this.conn.exec("BEGIN");
      for (const vol of results) {
        if (vol.id) this.upsertVolume(vol);
      }
      this.conn.exec("COMMIT");

      const total = data.number_of_total_results || 0;
      this.log(`  Processed ${offset + results.length}/${total} volumes`);

      if (results.length < limit) break;
      offset += limit;
    }

    this.setEndpointLastSync("volumes", endDate);
  }

  async fetchIssueDetails(issueId) {
    const data = await this.apiCall(`issue/4000-${issueId}/`);
    if (data) return data.results;
    return null;
  }

  // Upsert a single issue. Returns true on success, false if the INSERT
  // fails (typically a foreign-key constraint, e.g. a missing volume). The FK
  // failure is surfaced via runWithFkDiagnostics (which logs the failing
  // row/SQL and records it in sync_errors) and then swallowed here so the
  // caller can attempt recovery.
  upsertIssue(issueId, issueData, volumeId) {
    const issueSql = `
      INSERT OR REPLACE INTO cv_issue
        (id, volume_id, name, issue_number, cover_date, store_date,
         description, image_url, site_detail_url,
         character_credits, person_credits, team_credits,
         location_credits, story_arc_credits, associated_images,
         aliases, api_detail_url, deck, date_added, date_last_updated,
         object_credits, concept_credits, character_died_in,
         team_disbanded_in, first_appearance_characters,
         first_appearance_concepts, first_appearance_locations,
         first_appearance_objects, first_appearance_storyarcs,
         first_appearance_teams, has_staff_review)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      issueId, volumeId,
      jsonify(issueData.name), jsonify(issueData.issue_number),
      jsonify(issueData.cover_date), jsonify(issueData.store_date),
      jsonify(issueData.description),
      issueData.image ? issueData.image.original_url : null,
      issueData.site_detail_url,
      JSON.stringify(issueData.character_credits || []),
      JSON.stringify(issueData.person_credits || []),
      JSON.stringify(issueData.team_credits || []),
      JSON.stringify(issueData.location_credits || []),
      JSON.stringify(issueData.story_arc_credits || []),
      JSON.stringify(issueData.associated_images || []),
      jsonify(issueData.aliases), issueData.api_detail_url,
      jsonify(issueData.deck), jsonify(issueData.date_added),
      jsonify(issueData.date_last_updated),
      JSON.stringify(issueData.object_credits || []),
      JSON.stringify(issueData.concept_credits || []),
      JSON.stringify(issueData.character_died_in || []),
      JSON.stringify(issueData.team_disbanded_in || []),
      JSON.stringify(issueData.first_appearance_characters || []),
      JSON.stringify(issueData.first_appearance_concepts || []),
      JSON.stringify(issueData.first_appearance_locations || []),
      JSON.stringify(issueData.first_appearance_objects || []),
      JSON.stringify(issueData.first_appearance_storyarcs || []),
      JSON.stringify(issueData.first_appearance_teams || []),
      jsonify(issueData.has_staff_review)
    ];
    try {
      this.runWithFkDiagnostics("cv_issue", issueSql, params, `issue ${issueId} (${issueData.name})`);
      return true;
    } catch (e) {
      this.log(`    ✗ Failed to upsert issue ${issueId}: ${e.message}`);
      return false;
    }
  }

  async syncIssues(startDate, endDate, full = false) {
    this.log(`\n--- Syncing Issues ---${full ? " (FULL)" : ""}`);
    if (!this.conn) return;

    // Resume state
    const resumeState = this.getResumeState("issues");
    let processedIds = new Set();
    if (resumeState && resumeState.processed_ids) {
      processedIds = new Set(resumeState.processed_ids);
      this.log(`  Resuming from previous run. Skipping ${processedIds.size} already processed issues.`);
    }

    // Ensure metadata row exists
    this.conn.prepare(
      `INSERT INTO cv_sync_metadata (endpoint, last_sync_date, last_sync_timestamp)
       VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO NOTHING`
    ).run("issues", startDate, new Date().toISOString());

    // Get list of updated issue IDs
    const issueIds = [];
    let offset = 0;
    const limit = 100;

    this.log(`  Finding updated issues...${full ? " (full sync)" : ""}`);
    while (true) {
      const params = {
        field_list: "id",
        offset, limit
      };
      if (!full) params.filter = `date_last_updated:${startDate}|${endDate}`;
      params.sort = "date_last_updated:asc";

      const data = await this.apiCall("issues/", params);
      if (!data) throw new Error("API call failed for issues");

      const results = data.results || [];
      if (results.length === 0) break;

      for (const issue of results) {
        if (issue.id) issueIds.push(issue.id);
      }

      const total = data.number_of_total_results || 0;
      this.log(`    Found ${offset + results.length}/${total} issues to update`);

      if (results.length < limit) break;
      offset += limit;
    }

    // Filter out already-processed issues
    const initialCount = issueIds.length;
    const remaining = issueIds.filter((id) => !processedIds.has(id));
    const skipped = initialCount - remaining.length;
    if (skipped > 0) {
      this.log(`  Skipping ${skipped} issues (already processed). ${remaining.length} remaining.`);
    }

    // Fetch details for each issue
    this.log(`  Fetching details for ${remaining.length} issues...`);
    for (let i = 0; i < remaining.length; i++) {
      const issueId = remaining[i];
      const issueData = await this.fetchIssueDetails(issueId);
      if (!issueData) continue;

      const volume = issueData.volume || null;
      const volumeId = volume ? volume.id : null;

      const exists = this.conn.prepare("SELECT id FROM cv_issue WHERE id = ?").get(issueId);

      // UPD-4: if the upsert fails on a foreign-key constraint (e.g. the
      // issue's volume isn't in the local DB yet), back-fill the missing
      // volume from the live API and retry the issue once.
      let upserted = this.upsertIssue(issueId, issueData, volumeId);
      if (!upserted && volumeId) {
        const volRow = this.conn.prepare("SELECT id FROM cv_volume WHERE id = ?").get(volumeId);
        if (!volRow) {
          this.log(`    ⚠ FK failure for issue ${issueId}: volume ${volumeId} missing locally — fetching from live API`);
          const volData = await this.fetchVolumeDetails(volumeId);
          if (volData) {
            this.upsertVolume(volData);
            upserted = this.upsertIssue(issueId, issueData, volumeId);
            if (upserted) this.log(`    ✓ Recovered volume ${volumeId} and added issue ${issueId}`);
          } else {
            this.log(`    ✗ Could not fetch volume ${volumeId} from live API — skipping issue ${issueId}`);
          }
        }
      }
      if (!upserted) continue;

      if (exists) this.stats.issues_updated++;
      else this.stats.issues_added++;

      if (this.verbose || (i + 1) % 100 === 0) {
        const action = exists ? "Updated" : "Added";
        this.log(`    [${i + 1}/${remaining.length}] ${action} issue: ${issueData.name} (#${issueData.issue_number})`);
      }

      processedIds.add(issueId);

      // Commit periodically and save state
      if ((i + 1) % 50 === 0) {
        this.saveResumeState("issues", { processed_ids: [...processedIds] });
        this.log(`    --- SAVED RESUME STATE (${i + 1}/${remaining.length}) ---`);
      }
    }

    // Clear resume state on successful completion
    this.clearResumeState("issues");
    this.log(`  Completed ${remaining.length} issues`);

    this.setEndpointLastSync("issues", endDate);
  }

  async syncTeams(startDate, endDate, full = false) {
    this.log(`\n--- Syncing Teams ---${full ? " (FULL)" : ""}`);
    if (!this.conn) return;

    let offset = 0;
    const limit = 100;

    while (true) {
      const params = {
        field_list: "id,name,publisher,aliases,count_of_team_members," +
          "count_of_isssue_appearances,deck,description," +
          "date_added,date_last_updated,image,site_detail_url," +
          "first_appeared_in_issue",
        offset, limit
      };
      if (!full) params.filter = `date_last_updated:${startDate}|${endDate}`;
      params.sort = "date_last_updated:asc";

      const data = await this.apiCall("teams/", params);
      if (!data) throw new Error("API call failed for teams");

      const results = data.results || [];
      if (results.length === 0) break;

      this.conn.exec("BEGIN");
      for (const team of results) {
        const teamId = team.id;
        if (!teamId) continue;

        const image = team.image || null;
        const imageUrl = image ? image.original_url : null;
        const exists = this.conn.prepare("SELECT id FROM cv_team WHERE id = ?").get(teamId);

        const countOfIssueAppearances =
          team.count_of_isssue_appearances || team.count_of_issue_appearances;
        const firstAppeared = team.first_appeared_in_issue
          ? JSON.stringify(team.first_appeared_in_issue)
          : null;

        this.conn.prepare(`
          INSERT INTO cv_team
            (id, name, publisher, aliases, count_of_team_members,
             count_of_issue_appearances, deck, description,
             date_added, date_last_updated, image_url, site_detail_url,
             first_appeared_in_issue)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            publisher = excluded.publisher,
            aliases = excluded.aliases,
            count_of_team_members = excluded.count_of_team_members,
            count_of_issue_appearances = excluded.count_of_issue_appearances,
            deck = excluded.deck,
            description = excluded.description,
            date_added = excluded.date_added,
            date_last_updated = excluded.date_last_updated,
            image_url = excluded.image_url,
            site_detail_url = excluded.site_detail_url,
            first_appeared_in_issue = COALESCE(excluded.first_appeared_in_issue, cv_team.first_appeared_in_issue)
        `).run(
          teamId, jsonify(team.name), jsonify(team.publisher),
          jsonify(team.aliases),
          jsonify(team.count_of_team_members),
          jsonify(countOfIssueAppearances),
          jsonify(team.deck), jsonify(team.description),
          jsonify(team.date_added), jsonify(team.date_last_updated),
          imageUrl, team.site_detail_url, firstAppeared
        );

        if (exists) this.stats.teams_updated++;
        else this.stats.teams_added++;
      }
      this.conn.exec("COMMIT");

      const total = data.number_of_total_results || 0;
      this.log(`  Processed ${offset + results.length}/${total} teams`);

      if (results.length < limit) break;
      offset += limit;
    }

    this.setEndpointLastSync("teams", endDate);
  }

  async syncStoryarcs(startDate, endDate, full = false) {
    this.log(`\n--- Syncing Story Arcs ---${full ? " (FULL)" : ""}`);
    if (!this.conn) return;

    let offset = 0;
    const limit = 100;

    while (true) {
      const params = {
        field_list: "id,name,publisher,aliases,count_of_isssue_appearances," +
          "deck,description,date_added,date_last_updated,image," +
          "site_detail_url,first_appeared_in_issue",
        offset, limit
      };
      if (!full) params.filter = `date_last_updated:${startDate}|${endDate}`;
      params.sort = "date_last_updated:asc";

      const data = await this.apiCall("story_arcs/", params);
      if (!data) throw new Error("API call failed for storyarcs");

      const results = data.results || [];
      if (results.length === 0) break;

      this.conn.exec("BEGIN");
      for (const arc of results) {
        const arcId = arc.id;
        if (!arcId) continue;

        const image = arc.image || null;
        const imageUrl = image ? image.original_url : null;
        const exists = this.conn.prepare("SELECT id FROM cv_storyarc WHERE id = ?").get(arcId);

        const countOfIssueAppearances =
          arc.count_of_isssue_appearances || arc.count_of_issue_appearances;
        const firstAppeared = arc.first_appeared_in_issue
          ? JSON.stringify(arc.first_appeared_in_issue)
          : null;

        this.conn.prepare(`
          INSERT INTO cv_storyarc
            (id, name, publisher, aliases, count_of_issue_appearances,
             deck, description, date_added, date_last_updated,
             image_url, site_detail_url, first_appeared_in_issue)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            publisher = excluded.publisher,
            aliases = excluded.aliases,
            count_of_issue_appearances = excluded.count_of_issue_appearances,
            deck = excluded.deck,
            description = excluded.description,
            date_added = excluded.date_added,
            date_last_updated = excluded.date_last_updated,
            image_url = excluded.image_url,
            site_detail_url = excluded.site_detail_url,
            first_appeared_in_issue = COALESCE(excluded.first_appeared_in_issue, cv_storyarc.first_appeared_in_issue)
        `).run(
          arcId, jsonify(arc.name), jsonify(arc.publisher),
          jsonify(arc.aliases),
          jsonify(countOfIssueAppearances),
          jsonify(arc.deck), jsonify(arc.description),
          jsonify(arc.date_added), jsonify(arc.date_last_updated),
          imageUrl, arc.site_detail_url, firstAppeared
        );

        if (exists) this.stats.storyarcs_updated++;
        else this.stats.storyarcs_added++;
      }
      this.conn.exec("COMMIT");

      const total = data.number_of_total_results || 0;
      this.log(`  Processed ${offset + results.length}/${total} story arcs`);

      if (results.length < limit) break;
      offset += limit;
    }

    this.setEndpointLastSync("storyarcs", endDate);
  }

  // SRV-3: single-phase list-paging sync (the teams/publishers pattern). The
  // live characters/ list endpoint returns the scalar fields plus the
  // relationship collections, so no two-phase detail calls are needed.
  // first_appeared_in_issue is stored as the issue id (the UPD-15 concept
  // pattern); the collections are stored as JSON text (pre-SRV-6 pattern).
  async syncCharacters(startDate, endDate, full = false) {
    this.log(`\n--- Syncing Characters ---${full ? " (FULL)" : ""}`);
    if (!this.conn) return;

    let offset = 0;
    const limit = 100;

    while (true) {
      const params = {
        field_list: "id,name,aliases,real_name,birth,gender,deck,description," +
          "date_added,date_last_updated,image,site_detail_url," +
          "count_of_issue_appearances,first_appeared_in_issue," +
          "publisher,origin,teams,movies,powers,creators," +
          "issue_credits,volume_credits,story_arc_credits," +
          "issues_died_in,character_enemies,character_friends," +
          "team_enemies,team_friends",
        offset, limit
      };
      if (!full) params.filter = `date_last_updated:${startDate}|${endDate}`;
      params.sort = "date_last_updated:asc";

      const data = await this.apiCall("characters/", params);
      if (!data) throw new Error("API call failed for characters");

      const results = data.results || [];
      if (results.length === 0) break;

      this.conn.exec("BEGIN");
      for (const character of results) {
        const characterId = character.id;
        if (!characterId) continue;

        const image = character.image || null;
        const imageUrl = image ? image.original_url : null;
        const exists = this.conn.prepare("SELECT id FROM cv_character WHERE id = ?").get(characterId);

        const firstAppearedId = character.first_appeared_in_issue?.id ?? null;

        this.conn.prepare(`
          INSERT INTO cv_character
            (id, name, aliases, real_name, birth, gender, deck, description,
             date_added, date_last_updated, image_url, site_detail_url,
             first_appeared_in_issue_id, count_of_issue_appearances,
             publisher, origin, teams, movies, powers, creators,
             issue_credits, volume_credits, story_arc_credits,
             issues_died_in, character_enemies, character_friends,
             team_enemies, team_friends)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            aliases = excluded.aliases,
            real_name = excluded.real_name,
            birth = excluded.birth,
            gender = excluded.gender,
            deck = excluded.deck,
            description = excluded.description,
            date_added = excluded.date_added,
            date_last_updated = excluded.date_last_updated,
            image_url = excluded.image_url,
            site_detail_url = excluded.site_detail_url,
            first_appeared_in_issue_id = COALESCE(excluded.first_appeared_in_issue_id, cv_character.first_appeared_in_issue_id),
            count_of_issue_appearances = excluded.count_of_issue_appearances,
            publisher = excluded.publisher,
            origin = excluded.origin,
            teams = excluded.teams,
            movies = excluded.movies,
            powers = excluded.powers,
            creators = excluded.creators,
            issue_credits = excluded.issue_credits,
            volume_credits = excluded.volume_credits,
            story_arc_credits = excluded.story_arc_credits,
            issues_died_in = excluded.issues_died_in,
            character_enemies = excluded.character_enemies,
            character_friends = excluded.character_friends,
            team_enemies = excluded.team_enemies,
            team_friends = excluded.team_friends
        `).run(
          characterId, jsonify(character.name), jsonify(character.aliases),
          jsonify(character.real_name), jsonify(character.birth),
          jsonify(character.gender), jsonify(character.deck),
          jsonify(character.description),
          jsonify(character.date_added), jsonify(character.date_last_updated),
          imageUrl, character.site_detail_url, firstAppearedId,
          jsonify(character.count_of_issue_appearances),
          jsonify(character.publisher), jsonify(character.origin),
          jsonify(character.teams), jsonify(character.movies),
          jsonify(character.powers), jsonify(character.creators),
          jsonify(character.issue_credits), jsonify(character.volume_credits),
          jsonify(character.story_arc_credits), jsonify(character.issues_died_in),
          jsonify(character.character_enemies), jsonify(character.character_friends),
          jsonify(character.team_enemies), jsonify(character.team_friends)
        );

        if (exists) this.stats.characters_updated++;
        else this.stats.characters_added++;
      }
      this.conn.exec("COMMIT");

      const total = data.number_of_total_results || 0;
      this.log(`  Processed ${offset + results.length}/${total} characters`);

      if (results.length < limit) break;
      offset += limit;
    }

    this.setEndpointLastSync("characters", endDate);
  }

  // SRV-3: single-phase list-paging sync (the teams/publishers pattern).
  async syncLocations(startDate, endDate, full = false) {
    this.log(`\n--- Syncing Locations ---${full ? " (FULL)" : ""}`);
    if (!this.conn) return;

    let offset = 0;
    const limit = 100;

    while (true) {
      const params = {
        field_list: "id,name,aliases,deck,description,start_year," +
          "date_added,date_last_updated,image,site_detail_url," +
          "count_of_issue_appearances,first_appeared_in_issue," +
          "issue_credits,volume_credits,story_arc_credits,movies",
        offset, limit
      };
      if (!full) params.filter = `date_last_updated:${startDate}|${endDate}`;
      params.sort = "date_last_updated:asc";

      const data = await this.apiCall("locations/", params);
      if (!data) throw new Error("API call failed for locations");

      const results = data.results || [];
      if (results.length === 0) break;

      this.conn.exec("BEGIN");
      for (const location of results) {
        const locationId = location.id;
        if (!locationId) continue;

        const image = location.image || null;
        const imageUrl = image ? image.original_url : null;
        const exists = this.conn.prepare("SELECT id FROM cv_location WHERE id = ?").get(locationId);

        const firstAppearedId = location.first_appeared_in_issue?.id ?? null;

        this.conn.prepare(`
          INSERT INTO cv_location
            (id, name, aliases, deck, description, start_year,
             date_added, date_last_updated, image_url, site_detail_url,
             first_appeared_in_issue_id, count_of_issue_appearances,
             issue_credits, volume_credits, story_arc_credits, movies)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            aliases = excluded.aliases,
            deck = excluded.deck,
            description = excluded.description,
            start_year = excluded.start_year,
            date_added = excluded.date_added,
            date_last_updated = excluded.date_last_updated,
            image_url = excluded.image_url,
            site_detail_url = excluded.site_detail_url,
            first_appeared_in_issue_id = COALESCE(excluded.first_appeared_in_issue_id, cv_location.first_appeared_in_issue_id),
            count_of_issue_appearances = excluded.count_of_issue_appearances,
            issue_credits = excluded.issue_credits,
            volume_credits = excluded.volume_credits,
            story_arc_credits = excluded.story_arc_credits,
            movies = excluded.movies
        `).run(
          locationId, jsonify(location.name), jsonify(location.aliases),
          jsonify(location.deck), jsonify(location.description),
          jsonify(location.start_year),
          jsonify(location.date_added), jsonify(location.date_last_updated),
          imageUrl, location.site_detail_url, firstAppearedId,
          jsonify(location.count_of_issue_appearances),
          jsonify(location.issue_credits), jsonify(location.volume_credits),
          jsonify(location.story_arc_credits), jsonify(location.movies)
        );

        if (exists) this.stats.locations_updated++;
        else this.stats.locations_added++;
      }
      this.conn.exec("COMMIT");

      const total = data.number_of_total_results || 0;
      this.log(`  Processed ${offset + results.length}/${total} locations`);

      if (results.length < limit) break;
      offset += limit;
    }

    this.setEndpointLastSync("locations", endDate);
  }

  // SRV-3: single-phase list-paging sync (the teams/publishers pattern).
  // Powers have no deck, appearance count, or first_appeared_in_issue.
  async syncPowers(startDate, endDate, full = false) {
    this.log(`\n--- Syncing Powers ---${full ? " (FULL)" : ""}`);
    if (!this.conn) return;

    let offset = 0;
    const limit = 100;

    while (true) {
      const params = {
        field_list: "id,name,aliases,description,date_added,date_last_updated," +
          "image,site_detail_url,characters",
        offset, limit
      };
      if (!full) params.filter = `date_last_updated:${startDate}|${endDate}`;
      params.sort = "date_last_updated:asc";

      const data = await this.apiCall("powers/", params);
      if (!data) throw new Error("API call failed for powers");

      const results = data.results || [];
      if (results.length === 0) break;

      this.conn.exec("BEGIN");
      for (const power of results) {
        const powerId = power.id;
        if (!powerId) continue;

        const image = power.image || null;
        const imageUrl = image ? image.original_url : null;
        const exists = this.conn.prepare("SELECT id FROM cv_power WHERE id = ?").get(powerId);

        this.conn.prepare(`
          INSERT INTO cv_power
            (id, name, aliases, description, date_added, date_last_updated,
             image_url, site_detail_url, characters)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            aliases = excluded.aliases,
            description = excluded.description,
            date_added = excluded.date_added,
            date_last_updated = excluded.date_last_updated,
            image_url = excluded.image_url,
            site_detail_url = excluded.site_detail_url,
            characters = excluded.characters
        `).run(
          powerId, jsonify(power.name), jsonify(power.aliases),
          jsonify(power.description),
          jsonify(power.date_added), jsonify(power.date_last_updated),
          imageUrl, power.site_detail_url, jsonify(power.characters)
        );

        if (exists) this.stats.powers_updated++;
        else this.stats.powers_added++;
      }
      this.conn.exec("COMMIT");

      const total = data.number_of_total_results || 0;
      this.log(`  Processed ${offset + results.length}/${total} powers`);

      if (results.length < limit) break;
      offset += limit;
    }

    this.setEndpointLastSync("powers", endDate);
  }

  // Fetch a single concept's detail from the live API (mirrors fetchVolumeDetails).
  // The detail call returns the three relationship collections the list endpoint
  // silently drops, plus the same scalar fields the list call requests.
  // Returns the concept object, or null if the API call fails / rate-limits.
  async fetchConceptDetails(conceptId) {
    const fieldList = "id,name,aliases,count_of_isssue_appearances," +
      "deck,description,date_added,date_last_updated,image," +
      "site_detail_url,first_appeared_in_issue,start_year," +
      "issue_credits,movies,volume_credits";
    const data = await this.apiCall(`concept/4015-${conceptId}/`, { field_list: fieldList });
    if (data) return data.results;
    return null;
  }

  // Upsert a single concept: the scalar columns plus the three relationship
  // collections written as cv_concept_credit join rows (UPD-14). The scalar
  // upsert is unchanged; the join rows are DELETE-then-INSERT per credit type
  // (idempotent, the SRV-6c pattern). Wrapped in a transaction so the scalars
  // and the collections commit atomically. Returns true on success, false if the
  // upsert fails (the caller then skips the concept, mirroring upsertIssue).
  upsertConcept(conceptId, conceptData) {
    const image = conceptData.image || null;
    const imageUrl = image ? image.original_url : null;

    const countOfIssueAppearances =
      conceptData.count_of_isssue_appearances || conceptData.count_of_issue_appearances;
    // UPD-15: store the issue id, not the JSON blob. The server derives the full
    // object (api_detail_url + the issue's name/issue_number) from this id.
    const firstAppearedId = conceptData.first_appeared_in_issue?.id ?? null;

    const insertCredit = this.conn.prepare(`
      INSERT INTO cv_concept_credit
        (concept_id, credit_type, position, credit_id, name, api_detail_url, site_detail_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const deleteCredits = this.conn.prepare(
      "DELETE FROM cv_concept_credit WHERE concept_id = ? AND credit_type = ?"
    );

    try {
      this.conn.exec("BEGIN");
      this.conn.prepare(`
        INSERT INTO cv_concept
          (id, name, aliases, deck, description,
           date_added, date_last_updated, image_url, site_detail_url,
           first_appeared_in_issue_id, count_of_issue_appearances, start_year)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          aliases = excluded.aliases,
          deck = excluded.deck,
          description = excluded.description,
          date_added = excluded.date_added,
          date_last_updated = excluded.date_last_updated,
          image_url = excluded.image_url,
          site_detail_url = excluded.site_detail_url,
          first_appeared_in_issue_id = COALESCE(excluded.first_appeared_in_issue_id, cv_concept.first_appeared_in_issue_id),
          count_of_issue_appearances = excluded.count_of_issue_appearances,
          start_year = excluded.start_year
      `).run(
        conceptId, jsonify(conceptData.name), jsonify(conceptData.aliases),
        jsonify(conceptData.deck), jsonify(conceptData.description),
        jsonify(conceptData.date_added), jsonify(conceptData.date_last_updated),
        imageUrl, conceptData.site_detail_url, firstAppearedId,
        jsonify(countOfIssueAppearances), jsonify(conceptData.start_year)
      );

      // UPD-14: the three relationship collections as join rows. The live API
      // never returns null for these (always an array), so a missing/empty
      // collection simply yields no rows (the server emits []).
      for (const [field, type] of [["issue_credits", "issue"], ["movies", "movie"], ["volume_credits", "volume"]]) {
        deleteCredits.run(conceptId, type);
        const entries = conceptData[field];
        if (!Array.isArray(entries)) continue;
        entries.forEach((entry, position) => {
          insertCredit.run(
            conceptId, type, position,
            entry.id ?? null, entry.name ?? null,
            entry.api_detail_url ?? null, entry.site_detail_url ?? null
          );
        });
      }
      this.conn.exec("COMMIT");
    } catch (e) {
      try { this.conn.exec("ROLLBACK"); } catch { /* not in a transaction */ }
      this.log(`    ✗ Failed to upsert concept ${conceptId}: ${e.message}`);
      return false;
    }

    return true;
  }

  async syncConcepts(startDate, endDate, full = false) {
    this.log(`\n--- Syncing Concepts ---${full ? " (FULL)" : ""}`);
    if (!this.conn) return;

    // Resume state
    const resumeState = this.getResumeState("concepts");
    let processedIds = new Set();
    if (resumeState && resumeState.processed_ids) {
      processedIds = new Set(resumeState.processed_ids);
      this.log(`  Resuming from previous run. Skipping ${processedIds.size} already processed concepts.`);
    }

    // Ensure metadata row exists
    this.conn.prepare(
      `INSERT INTO cv_sync_metadata (endpoint, last_sync_date, last_sync_timestamp)
       VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO NOTHING`
    ).run("concepts", startDate, new Date().toISOString());

    // UPD-14 phase 1: collect the changed ids. The live concepts/ list endpoint
    // silently drops the relationship collections (verified 2026-11-12: a list
    // call requesting them returns only id), so a cheap field_list=id is all the
    // list phase needs; the collections come from the detail calls in phase 2.
    const conceptIds = [];
    let offset = 0;
    const limit = 100;

    this.log(`  Finding updated concepts...${full ? " (full sync)" : ""}`);
    while (true) {
      const params = {
        field_list: "id",
        offset, limit
      };
      if (!full) params.filter = `date_last_updated:${startDate}|${endDate}`;
      params.sort = "date_last_updated:asc";

      const data = await this.apiCall("concepts/", params);
      if (!data) throw new Error("API call failed for concepts");

      const results = data.results || [];
      if (results.length === 0) break;

      for (const concept of results) {
        if (concept.id) conceptIds.push(concept.id);
      }

      const total = data.number_of_total_results || 0;
      this.log(`    Found ${offset + results.length}/${total} concepts to update`);

      if (results.length < limit) break;
      offset += limit;
    }

    // Filter out already-processed concepts
    const initialCount = conceptIds.length;
    const remaining = conceptIds.filter((id) => !processedIds.has(id));
    const skipped = initialCount - remaining.length;
    if (skipped > 0) {
      this.log(`  Skipping ${skipped} concepts (already processed). ${remaining.length} remaining.`);
    }

    // UPD-14 phase 2: one detail call per id (returns the collections the list
    // endpoint drops) and an upsert of the scalars + cv_concept_credit join rows.
    this.log(`  Fetching details for ${remaining.length} concepts...`);
    for (let i = 0; i < remaining.length; i++) {
      const conceptId = remaining[i];
      const conceptData = await this.fetchConceptDetails(conceptId);
      if (!conceptData) continue;

      const exists = this.conn.prepare("SELECT id FROM cv_concept WHERE id = ?").get(conceptId);
      if (!this.upsertConcept(conceptId, conceptData)) continue;

      if (exists) this.stats.concepts_updated++;
      else this.stats.concepts_added++;

      if (this.verbose || (i + 1) % 100 === 0) {
        const action = exists ? "Updated" : "Added";
        this.log(`    [${i + 1}/${remaining.length}] ${action} concept: ${conceptData.name}`);
      }

      processedIds.add(conceptId);

      // Commit periodically and save state
      if ((i + 1) % 50 === 0) {
        this.saveResumeState("concepts", { processed_ids: [...processedIds] });
        this.log(`    --- SAVED RESUME STATE (${i + 1}/${remaining.length}) ---`);
      }
    }

    // Clear resume state on successful completion
    this.clearResumeState("concepts");
    this.log(`  Completed ${remaining.length} concepts`);

    this.setEndpointLastSync("concepts", endDate);
  }

  // ─── Post-sync maintenance ──────────────────────────────────────────────

  recalculateVolumeIssueCounts() {
    this.log("\n--- Recalculating Volume Issue Counts ---");
    if (!this.conn) return;

    try {
      const mismatches = this.conn.prepare(`
        SELECT v.id, v.name, v.count_of_issues as stored_count,
               COALESCE(i.actual_count, 0) as actual_count
        FROM cv_volume v
        LEFT JOIN (
          SELECT volume_id, COUNT(*) as actual_count
          FROM cv_issue
          GROUP BY volume_id
        ) i ON v.id = i.volume_id
        WHERE v.count_of_issues != COALESCE(i.actual_count, 0)
           OR (v.count_of_issues IS NULL AND i.actual_count > 0)
      `).all();

      if (mismatches.length === 0) {
        this.log("  All volume issue counts are accurate");
        return;
      }

      this.log(`  Found ${mismatches.length} volumes with incorrect counts`);

      let updated = 0;
      for (const row of mismatches) {
        this.conn.prepare("UPDATE cv_volume SET count_of_issues = ? WHERE id = ?")
          .run(row.actual_count, row.id);
        updated++;
        if (this.verbose && updated <= 5) {
          this.log(`    ${row.name}: ${row.stored_count} -> ${row.actual_count}`);
        }
      }
      if (updated > 5) this.log(`    ... and ${updated - 5} more`);
      this.log(`  Updated ${updated} volume counts`);
    } catch (e) {
      this.log(`  Error recalculating counts: ${e.message}`);
    }
  }

  rebuildFtsIndex(tables = null) {
    this.log("\n--- Rebuilding Search Index ---");
    if (!this.conn) return;

    // SRV-5: rebuild every per-resource FTS5 trigram index from the base tables.
    // UPD-12: when `tables` is given, rebuild only those (a scoped --resource
    // run touches only the selected resources' indexes).
    const targets = tables
      ? this.FTS_RESOURCES.filter(({ fts }) => tables.includes(fts))
      : this.FTS_RESOURCES;
    for (const { fts } of targets) {
      try {
        const exists = this.conn.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
        ).get(fts);
        if (exists) {
          this.conn.exec(`INSERT INTO ${fts}(${fts}) VALUES('rebuild')`);
          this.log(`  ${fts} rebuilt`);
        }
      } catch (e) {
        this.log(`  Warning: could not rebuild ${fts}: ${e.message}`);
      }
    }

    // Legacy raw-dump index (out of scope for the API, but kept in sync). It
    // indexes cv_volume, so rebuild it only when volumes was in the selection.
    const rebuildLegacy = !tables || tables.includes("cv_volume_fts");
    if (rebuildLegacy) {
      try {
        const row = this.conn.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='volume_fts'"
        ).get();
        if (row) {
          this.conn.exec("INSERT INTO volume_fts(volume_fts) VALUES('rebuild')");
          this.log("  volume_fts rebuilt");
        }
      } catch (e) {
        this.log(`  Warning: Could not rebuild volume_fts: ${e.message}`);
      }
    }
  }

  printStats() {
    const s = this.stats;
    this.log("\n" + "=".repeat(50), { force: true });
    this.log("SYNC COMPLETE", { force: true });
    this.log("=".repeat(50), { force: true });
    this.log(`API calls made:     ${s.api_calls}`, { force: true });
    // UPD-12: report only the resources this run synced (all ten by default).
    // Labels are padded to a fixed width so the counts stay column-aligned.
    for (const r of this.selectedResources()) {
      const added = `${r.statsLabel} added:`.padEnd(20) + s[`${r.stats}_added`];
      const updated = `${r.statsLabel} updated:`.padEnd(20) + s[`${r.stats}_updated`];
      this.log(added, { force: true });
      this.log(updated, { force: true });
    }
  }

  // UPD-12: the resources this run will sync, in registry order. All seven
  // when no subset was requested (this.resources is null).
  selectedResources() {
    return this.resources ? RESOURCES.filter((r) => this.resources.includes(r)) : RESOURCES;
  }

  async runSync(startDate = null) {
    this.ensureMetadataTable();
    this.ensureResourceTables();
    this.ensureVolumeCreditTables();
    this.ensureConceptCreditTables();
    this.ensureFtsTables();

    const endDate = todayStr();

    const endpoints = this.selectedResources();

    for (const ep of endpoints) {
      const start = startDate || this.calculateSafeStartDate(ep.name);
      const last = this.getEndpointLastSync(ep.name);
      if (last) this.log(`${ep.label} last synced: ${last}`);
      this.log(`Syncing ${ep.label} from ${start} to ${endDate}${this.full ? " (FULL)" : ""}`);
      try {
        await this[ep.method](start, endDate, this.full);
      } catch (e) {
        this.log(`ERROR: ${e.message}. Skipping metadata update for ${ep.name}.`, { force: true });
      }
    }

    // UPD-12: post-sync maintenance runs only when a relevant resource was in
    // the selection — the volume/issue-count recalc needs volumes or issues,
    // and the FTS rebuild is scoped to the selected resources' indexes.
    const names = new Set(endpoints.map((r) => r.name));
    if (names.has("volumes") || names.has("issues")) {
      this.recalculateVolumeIssueCounts();
    }
    this.rebuildFtsIndex(endpoints.map((r) => r.fts));
    this.printStats();

    return true;
  }
}

// ─── API Key Validation ──────────────────────────────────────────────────────

async function validateApiKey(apiKey, verbose = true) {
  if (verbose) console.log("Validating API key...");
  try {
    const url = `${API_BASE_URL}publishers/?api_key=${encodeURIComponent(apiKey)}&format=json&limit=1`;
    const response = await fetch(url, { headers: HEADERS });
    const data = await response.json();

    if (data.status_code === 100) {
      if (verbose) console.log("ERROR: Invalid API key!");
      return false;
    }
    if (data.status_code === RATE_LIMIT_STATUS) {
      if (verbose) console.log("API key is valid, but the rate limit is currently exhausted. Proceeding; calls will back off and retry.");
      return true;
    }
    if (data.status_code === 1) {
      if (verbose) console.log("API key validated successfully!");
      return true;
    }
    if (verbose) console.log(`Unexpected API response: ${data.error || "Unknown"}`);
    return false;
  } catch (e) {
    if (verbose) console.log(`ERROR: Could not connect to ComicVine: ${e.message}`);
    return false;
  }
}

// ─── Dated Database Management ───────────────────────────────────────────────

function findLatestDatabase(dbDir, today) {
  let files;
  try {
    files = fs.readdirSync(dbDir).filter((f) => f.startsWith("localcv-") && f.endsWith(".db"));
  } catch {
    return null;
  }
  files.sort().reverse();

  for (const file of files) {
    const dateStr = file.replace("localcv-", "").replace(".db", "");
    if (dateStr < today && isValidDate(dateStr)) {
      return path.join(dbDir, file);
    }
  }

  const defaultDb = path.join(dbDir, "localcv.db");
  if (fs.existsSync(defaultDb)) return defaultDb;
  return null;
}

function createTodaysDatabase(dbDir, today, verbose = true) {
  const sourceDb = findLatestDatabase(dbDir, today);
  if (!sourceDb) {
    if (verbose) {
      console.error(`ERROR: No source database found in ${dbDir}`);
      console.error("Expected format: localcv-YYYY-MM-DD.db or localcv.db");
    }
    return null;
  }

  const targetDb = path.join(dbDir, `localcv-${today}.db`);
  if (fs.existsSync(targetDb)) {
    if (verbose) console.log(`Database for ${today} already exists: ${targetDb}`);
    return targetDb;
  }

  if (verbose) console.log(`Creating ${path.basename(targetDb)} from ${path.basename(sourceDb)}...`);

  try {
    const sourceSize = fs.statSync(sourceDb).size;
    if (verbose && sourceSize > 100 * 1024 * 1024) {
      console.log(`  Copying ${(sourceSize / (1024 ** 3)).toFixed(2)} GB database...`);
    }

    fs.copyFileSync(sourceDb, targetDb);

    // Also copy WAL and SHM files if they exist
    for (const ext of ["-wal", "-shm"]) {
      const sourceAux = sourceDb + ext;
      if (fs.existsSync(sourceAux)) {
        fs.copyFileSync(sourceAux, targetDb + ext);
      }
    }

    if (verbose) console.log("  Database copied successfully");
    return targetDb;
  } catch (e) {
    if (verbose) console.error(`ERROR: Failed to copy database: ${e.message}`);
    return null;
  }
}

function cleanupOldDatabases(dbDir, keepDays = 7, verbose = true) {
  if (verbose) console.log(`\n--- Cleaning Up Old Databases (keeping last ${keepDays} days) ---`);

  let files;
  try {
    files = fs.readdirSync(dbDir).filter((f) => f.startsWith("localcv-") && f.endsWith(".db"));
  } catch {
    return 0;
  }

  const dated = [];
  for (const file of files) {
    const dateStr = file.replace("localcv-", "").replace(".db", "");
    if (isValidDate(dateStr)) {
      dated.push({ date: dateStr, file: path.join(dbDir, file) });
    }
  }
  dated.sort((a, b) => b.date.localeCompare(a.date));

  if (dated.length === 0) {
    if (verbose) console.log("  No dated database files found");
    return 0;
  }

  const toDelete = dated.slice(keepDays);
  if (toDelete.length === 0) {
    if (verbose) console.log(`  Only ${dated.length} database(s) found, nothing to delete`);
    return 0;
  }

  let deletedCount = 0;
  let totalSizeFreed = 0;

  for (const { file } of toDelete) {
    try {
      const size = fs.statSync(file).size;
      fs.unlinkSync(file);
      deletedCount++;
      totalSizeFreed += size;
      if (verbose) console.log(`  Deleted: ${path.basename(file)} (${(size / (1024 ** 2)).toFixed(1)} MB)`);

      for (const ext of ["-wal", "-shm"]) {
        const aux = file + ext;
        if (fs.existsSync(aux)) {
          totalSizeFreed += fs.statSync(aux).size;
          fs.unlinkSync(aux);
        }
      }
    } catch (e) {
      if (verbose) console.log(`  Warning: Could not delete ${path.basename(file)}: ${e.message}`);
    }
  }

  if (verbose && deletedCount > 0) {
    console.log(`  Deleted ${deletedCount} old database(s), freed ${(totalSizeFreed / (1024 ** 3)).toFixed(2)} GB`);
  }
  return deletedCount;
}

// ─── Full-Sync Confirmation (UPD-2) ─────────────────────────────────────────

// A full sync issues one unfiltered call per page across all ten endpoints.
// With the live API's ~1.1M issues and the 200-calls/hour rate limit, a full
// pass cannot be parallelized and takes on the order of weeks of continuous
// calls to complete. Gate it behind an explicit confirmation so it is never
// triggered by accident (e.g. a stray `npm run sync:full` in cron).
async function confirmFullSync({ interactive, yes, resources = null }) {
  if (yes) return true;

  // UPD-12: scale the warning to the selected resources — a full `publishers`
  // sync is trivial, but a full `issues` sync is still ~1.1M detail calls.
  const scope = resources
    ? resources.map((r) => r.label).join(", ")
    : "all ten endpoints";
  const calls = resources
    ? `one unfiltered call per page for ${scope}` +
      (resources.some((r) => r.name === "issues")
        ? " — the issues endpoint alone is ~1.1M detail calls"
        : "")
    : "~1.1 million (one per issue detail, plus per-page calls for the other eight endpoints)";
  const line = "=".repeat(50);
  console.error(`\n${line}`);
  console.error("FULL SYNC WARNING");
  console.error(line);
  console.error(`A full sync makes ${calls} live API calls.`);
  console.error(`At the ComicVine rate limit (200 calls/hour, then a 1-hour ban),`);
  console.error(`a full pass cannot be parallelized and takes on the order of WEEKS`);
  console.error(`of continuous calls to complete. It also exhausts your daily quota`);
  console.error(`and blocks incremental syncs for the same period.`);
  console.error(`${line}\n`);

  if (!interactive) {
    console.error("Non-interactive run: refusing to start a full sync without explicit confirmation.");
    console.error("Re-run with --yes to confirm, or drop --full for an incremental sync.");
    return false;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question("Type 'yes' to confirm the full sync: ")).trim().toLowerCase();
    return answer === "yes";
  } finally {
    rl.close();
  }
}

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    database: null, dbPath: null, dbDir: null,
    apiKey: null, startDate: null,
    full: false, nonInteractive: false, quiet: false,
    noCopy: false, keepDays: 7, yes: false,
    resources: []
  };

  let positional = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--full") args.full = true;
    else if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg === "--non-interactive") args.nonInteractive = true;
    else if (arg === "--quiet") args.quiet = true;
    else if (arg === "--no-copy") args.noCopy = true;
    else if (arg === "--db") args.dbPath = argv[++i];
    else if (arg === "--db-dir") args.dbDir = argv[++i];
    else if (arg === "--api-key") args.apiKey = argv[++i];
    else if (arg === "--start-date") args.startDate = argv[++i];
    else if (arg === "--keep-days") args.keepDays = parseInt(argv[++i], 10);
    else if (arg === "--resource") {
      // UPD-12: repeatable and/or comma-separated resource names.
      const value = argv[++i];
      if (value) {
        for (const token of value.split(",").map((t) => t.trim()).filter(Boolean)) {
          args.resources.push(token);
        }
      }
    }
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith("-") && positional === 0) {
      args.database = arg;
      positional++;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
ComicVine SQLite Database Updater (Node.js)

Usage:
  node src/updater.js [database_path]
  node src/updater.js --non-interactive --db-dir /path/to/db
  node src/updater.js --full [database_path]

Options:
  --db <path>          Path to a specific database file
  --db-dir <path>      Directory containing dated databases (non-interactive mode)
  --api-key <key>      ComicVine API key (overrides .env COMICVINE_API_KEY)
  --start-date <date>  Custom start date YYYY-MM-DD (default: automatic)
  --full               Full sync: fetch every record (no date filter)
  --yes, -y            Confirm a full sync without an interactive prompt
  --resource <name>    Sync only the named resource(s) — repeatable and/or
                       comma-separated. Accepts the endpoint name, the cv_*
                       table name, or the singular (e.g. issue / issues /
                       cv_issue all mean issues). Valid: publishers, people,
                       volumes, issues, teams, storyarcs, concepts,
                       characters, locations, powers.
                       Default: all ten.
  --non-interactive    Run without prompts (for cron)
  --quiet              Reduce output verbosity
  --no-copy            Don't create dated copy, update in place
  --keep-days <n>      Number of dated databases to keep (default: 7)

Environment:
  COMICVINE_API_KEY    API key (from .env or process environment)
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const interactive = !args.nonInteractive;
  const verbose = !args.quiet;

  // UPD-12: resolve --resource names up front so an unknown name is rejected
  // before any work (database discovery, API-key validation, …) is done.
  let resources = null;
  if (args.resources.length > 0) {
    const resolved = resolveResources(args.resources);
    if (resolved.unknown.length > 0) {
      console.error(`ERROR: Unknown resource(s): ${resolved.unknown.join(", ")}`);
      console.error(`Valid resources: ${RESOURCES.map((r) => r.name).join(", ")}`);
      console.error("(Each may be the endpoint name, the cv_* table name, or the singular;");
      console.error("comma-separate them or repeat --resource for several.)");
      process.exit(1);
    }
    resources = resolved.resources;
  }

  const today = todayStr();

  if (interactive && verbose) {
    console.log("=".repeat(50));
    console.log("ComicVine SQLite Database Updater (Node.js)");
    console.log("=".repeat(50));
    console.log();
    console.log(`Configuration source: .env / process environment`);
    console.log();
  }

  // Determine database path
  let dbPath = null;
  let dbDirForCleanup = null;

  if (args.dbDir) {
    const dbDir = args.dbDir;
    if (!fs.existsSync(dbDir)) {
      console.error(`ERROR: Directory not found: ${dbDir}`);
      process.exit(1);
    }
    if (args.noCopy) {
      dbPath = findLatestDatabase(dbDir, today);
      if (!dbPath) {
        console.error(`ERROR: No database found in ${dbDir}`);
        process.exit(1);
      }
    } else {
      dbPath = createTodaysDatabase(dbDir, today, verbose);
      if (!dbPath) process.exit(1);
      dbDirForCleanup = dbDir;
    }
  } else if (args.dbPath) {
    dbPath = args.dbPath;
  } else if (args.database) {
    dbPath = args.database;
  } else if (interactive) {
    // Look for default in cwd
    const defaultPath = path.join(process.cwd(), "localcv.db");
    if (fs.existsSync(defaultPath)) {
      console.log(`Found database: ${defaultPath}`);
      // In non-interactive fallback, just use it
      dbPath = defaultPath;
    }
    if (!dbPath) {
      console.error("ERROR: No database found. Use --db or --db-dir to specify location.");
      process.exit(1);
    }
  } else {
    // Non-interactive without db-dir: look in cwd
    const cwd = process.cwd();
    if (args.noCopy) {
      dbPath = findLatestDatabase(cwd, today);
    } else {
      dbPath = createTodaysDatabase(cwd, today, verbose);
      dbDirForCleanup = cwd;
    }
    if (!dbPath) {
      console.error("ERROR: No database found. Use --db-dir or --db to specify location.");
      process.exit(1);
    }
  }

  if (!dbPath) {
    console.error("No database selected. Exiting.");
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`ERROR: Database not found: ${dbPath}`);
    process.exit(1);
  }

  // Get API key
  const apiKey = args.apiKey || process.env.COMICVINE_API_KEY;
  if (!apiKey) {
    console.error("ERROR: No API key provided.");
    console.error(`Add COMICVINE_API_KEY to .env (or set it in the process environment)`);
    console.error("Or pass the --api-key flag");
    process.exit(1);
  }

  // Validate API key
  if (!await validateApiKey(apiKey, verbose)) {
    process.exit(1);
  }

  // UPD-2: gate an expensive full sync behind explicit confirmation.
  // UPD-12: scale the warning to the selected resources.
  if (args.full) {
    const confirmed = await confirmFullSync({ interactive, yes: args.yes, resources });
    if (!confirmed) {
      console.error("Full sync not confirmed. Exiting without syncing.");
      process.exit(1);
    }
  }

  // Validate custom start date
  let startDate = null;
  if (!args.full) {
    startDate = args.startDate;
    if (startDate) {
      if (!isValidDate(startDate)) {
        console.error(`ERROR: Invalid date format: ${startDate} (use YYYY-MM-DD)`);
        process.exit(1);
      }
    }
  }

  // Run the updater (UPD-12: `resources` restricts the run to --resource).
  const updater = new ComicVineUpdater(dbPath, apiKey, { verbose, full: args.full, resources });
  if (!updater.connect()) {
    process.exit(1);
  }

  let syncSuccess = false;
  let exitCode = 0;
  let errorMessage = null;

  try {
    await updater.runSync(startDate);
    syncSuccess = true;

    if (syncSuccess && dbDirForCleanup && args.keepDays > 0) {
      cleanupOldDatabases(dbDirForCleanup, args.keepDays, verbose);
    }
  } catch (e) {
    if (e.name === "AbortError" || e.code === "ERR_ABORTED") {
      errorMessage = "Interrupted by user. Progress has been saved.";
      console.error(`\n\n${errorMessage}`);
      exitCode = 130;
    } else {
      errorMessage = `Sync failed: ${e.message}`;
      console.error(`\nERROR: ${errorMessage}`);
      console.error(e.stack);
      exitCode = 1;
    }
  } finally {
    updater.close();
  }

  process.exit(exitCode);
}

// ─── CLI Entry ───────────────────────────────────────────────────────────────

if (require.main === module) {
  main().catch((e) => {
    console.error(`Fatal: ${e.message}`);
    process.exit(1);
  });
}

module.exports = {
  ComicVineUpdater,
  RESOURCES,
  resolveResource,
  resolveResources,
  validateApiKey,
  findLatestDatabase,
  createTodaysDatabase,
  cleanupOldDatabases,
  confirmFullSync,
  jsonify,
  API_BASE_URL,
  HEADERS,
  MAX_RETRIES,
  RATE_LIMIT_BACKOFF_SECONDS,
  API_DELAY_SECONDS
};
