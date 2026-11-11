#!/usr/bin/env node
/**
 * ComicVine Raw API Sync (Node.js)
 *
 * A stand-alone process (distinct from src/server.js and src/updater.js) that
 * keeps the rawapi database in step with the LIVE ComicVine API. For every
 * entity that has been added or modified since the last sync it fetches the
 * entity's full detail object and stores it VERBATIM (JSON.stringify of the
 * API's `results` object) into the matching cv_* table.
 *
 * Unlike the updater (which normalizes the API into typed columns for the
 * served API), this process preserves the API's exact JSON so the static
 * snapshot doubles as a structural ground-truth record of what the live API
 * returns. All eleven cv_* tables share one uniform shape:
 *
 *   id INTEGER PRIMARY KEY, date_last_updated TEXT, site_detail_url TEXT,
 *   raw_api_response TEXT
 *
 * date_last_updated and site_detail_url are denormalized from the top-level
 * fields of the stored JSON (both are always present on a ComicVine entity).
 *
 * Sync order: resources are synced smallest-first so the long-running,
 * highest-volume table (cv_issue, ~1.1M rows) is always done LAST.
 *
 * Two-phase sync per resource (mirrors the updater's syncIssues):
 *   1. list endpoint (field_list=id, date_last_updated filter) → collect ids
 *   2. detail endpoint per id → upsert the verbatim JSON
 * Interrupted runs resume from saved state; a list call that still fails after
 * all retries skips that table and the sync continues with the rest.
 *
 * Uses node:sqlite + global fetch (zero npm dependencies).
 *
 * Configuration is read from `.env` (COMICVINE_API_KEY) or the process
 * environment.
 *
 * Usage:
 *   node src/rawapi.js [database_path]
 *   node src/rawapi.js --db /path/to/comicvine_rawapi_YYYYMMDD.db
 *   node src/rawapi.js --full --yes
 *   COMICVINE_API_KEY=your_key node src/rawapi.js --non-interactive
 *
 * npm run rawapi          — incremental sync
 * npm run rawapi:full     — one-time full sync (~1.5M API calls)
 *
 * A full sync makes one detail call per entity across all eleven tables
 * (~1.5M calls). It is gated behind an interactive "yes" prompt, or the --yes
 * flag in non-interactive runs.
 */

"use strict";

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");

// ─── API Configuration ───────────────────────────────────────────────────────
const API_BASE_URL = "https://comicvine.gamespot.com/api/";
const HEADERS = {
  "User-Agent": "LocalCVRawApi/1.0",
  From: "comicvine-user@example.com"
};
const API_DELAY_SECONDS = 1.5;
const MAX_RETRIES = 5;
const RATE_LIMIT_STATUS = 107;
const RATE_LIMIT_BACKOFF_SECONDS = 60;
// The list endpoints intermittently return HTTP 401 / status_code 100
// ("Invalid API Key") for a VALID key under load — a rate-limit artifact that
// clears after ~30s. Back off this long before retrying.
const INVALID_KEY_BACKOFF_SECONDS = 30;

// The rawapi database is a static snapshot (comicvine_rawapi_20260122.db,
// content through 2026-01-21). Endpoints with no recorded sync start here.
const SNAPSHOT_DATE = "2026-01-22";

// ─── Resources ───────────────────────────────────────────────────────────────
//
// Ordered smallest-first (by snapshot row count) so the largest table,
// cv_issue, is synced LAST. `detail` is the API detail prefix (the domain
// prefix is extracted from the snapshot's api_detail_url values); `list` is
// the plural list endpoint.
const RESOURCES = [
  { name: "power",     table: "cv_power",     list: "powers/",     detail: "power/4035-" },
  { name: "concept",   table: "cv_concept",   list: "concepts/",   detail: "concept/4015-" },
  { name: "story_arc", table: "cv_storyarc",  list: "story_arcs/", detail: "story_arc/4045-" },
  { name: "object",    table: "cv_object",    list: "objects/",    detail: "object/4055-" },
  { name: "publisher", table: "cv_publisher", list: "publishers/", detail: "publisher/4010-" },
  { name: "location",  table: "cv_location",  list: "locations/",  detail: "location/4020-" },
  { name: "team",      table: "cv_team",      list: "teams/",      detail: "team/4060-" },
  { name: "person",    table: "cv_person",    list: "people/",     detail: "person/4040-" },
  { name: "volume",    table: "cv_volume",    list: "volumes/",    detail: "volume/4050-" },
  { name: "character", table: "cv_character", list: "characters/", detail: "character/4005-" },
  { name: "issue",     table: "cv_issue",     list: "issues/",     detail: "issue/4000-" } // LAST — largest table
];

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

// ─── RawApiSync ──────────────────────────────────────────────────────────────

class RawApiSync {
  constructor(dbPath, apiKey, options = {}) {
    this.dbPath = dbPath;
    this.apiKey = apiKey;
    this.verbose = options.verbose !== false;
    this.logCapture = options.logCapture || null;
    this.full = Boolean(options.full);
    this.fetchFn = options.fetchFn || globalThis.fetch;
    // Injectable delays (tests pass 0 to skip the real waits).
    this.apiDelayMs = options.apiDelayMs ?? API_DELAY_SECONDS * 1000;
    this.rateLimitBackoffMs = options.rateLimitBackoffMs ?? RATE_LIMIT_BACKOFF_SECONDS * 1000;
    this.http420BackoffMs = options.http420BackoffMs ?? 600 * 1000;
    this.invalidKeyBackoffMs = options.invalidKeyBackoffMs ?? INVALID_KEY_BACKOFF_SECONDS * 1000;
    this.conn = null;
    this.stats = { api_calls: 0 };
    for (const r of RESOURCES) {
      this.stats[`${r.name}_added`] = 0;
      this.stats[`${r.name}_updated`] = 0;
      this.stats[`${r.name}_failed`] = 0;
    }
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
      // The cv_* tables carry no foreign keys, so leave enforcement OFF
      // (the default) to keep the verbatim upserts fast.
      this.conn.exec("PRAGMA foreign_keys=OFF");
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

  // ─── Schema ───────────────────────────────────────────────────────────────

  ensureTables() {
    if (!this.conn) return;
    for (const r of RESOURCES) {
      this.conn.exec(`
        CREATE TABLE IF NOT EXISTS ${r.table} (
          id INTEGER PRIMARY KEY,
          date_last_updated TEXT,
          site_detail_url TEXT,
          raw_api_response TEXT
        )
      `);
    }
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS cv_sync_metadata (
        endpoint TEXT PRIMARY KEY,
        last_sync_date TEXT NOT NULL,
        last_sync_timestamp TEXT NOT NULL,
        resume_state TEXT
      )
    `);
  }

  // ─── Metadata ─────────────────────────────────────────────────────────────

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

  // No recorded sync yet → start at the snapshot date. Otherwise overlap by
  // one day (mirrors the updater) so a same-day update is not missed.
  calculateSafeStartDate(endpoint) {
    const lastSync = this.getEndpointLastSync(endpoint);
    if (lastSync && isValidDate(lastSync)) return dateAddDays(lastSync, -1);
    return SNAPSHOT_DATE;
  }

  // ─── API Call ─────────────────────────────────────────────────────────────

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
          // HTTP 401 on a pre-validated key is a transient rate-limit
          // artifact (observed on list endpoints under load); it clears
          // after ~30s. Back off and retry.
          this.log(`  HTTP ${response.status} error (attempt ${attempt + 1}/${MAX_RETRIES})`);
          if (attempt < MAX_RETRIES - 1) {
            await sleep(this.invalidKeyBackoffMs);
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
          // "Invalid API Key" for a key that validated at startup is the same
          // transient rate-limit artifact; back off and retry (the updater
          // treats 100 as a hard failure, but this process pre-validates).
          const waitMs = this.invalidKeyBackoffMs * (attempt + 1);
          this.log(
            `  Transient invalid-key (status 100). Waiting ${Math.round(waitMs / 1000)}s ` +
            `before retry (${attempt + 1}/${MAX_RETRIES})...`
          );
          if (waitMs > 0) await sleep(waitMs);
          continue;
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

  // ─── Sync ─────────────────────────────────────────────────────────────────

  // Fetch one entity's full detail object. Returns the `results` object, or
  // null if the call fails or the entity is gone (deleted → results is null).
  async fetchDetails(resource, id) {
    const data = await this.apiCall(`${resource.detail}${id}/`);
    if (data && data.results) return data.results;
    return null;
  }

  // Store an entity's verbatim JSON. Returns "added" | "updated" | null.
  upsertRaw(resource, entity) {
    const id = entity.id;
    if (!id) return null;
    const raw = JSON.stringify(entity);
    const exists = this.conn
      .prepare(`SELECT id FROM ${resource.table} WHERE id = ?`)
      .get(id);
    this.conn.prepare(`
      INSERT INTO ${resource.table}
        (id, date_last_updated, site_detail_url, raw_api_response)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        date_last_updated = excluded.date_last_updated,
        site_detail_url = excluded.site_detail_url,
        raw_api_response = excluded.raw_api_response
    `).run(
      id,
      entity.date_last_updated ?? null,
      entity.site_detail_url ?? null,
      raw
    );
    return exists ? "updated" : "added";
  }

  async syncResource(resource, startDate, endDate) {
    this.log(`\n--- Syncing ${resource.name} ---${this.full ? " (FULL)" : ""}`);
    if (!this.conn) return;

    // Resume state from a previous (interrupted) run.
    const resumeState = this.getResumeState(resource.name);
    let processedIds = new Set();
    if (resumeState && resumeState.processed_ids) {
      processedIds = new Set(resumeState.processed_ids);
      this.log(`  Resuming from previous run. Skipping ${processedIds.size} already processed ${resource.name}.`);
    }

    // Ensure a metadata row exists for this endpoint.
    this.conn.prepare(
      `INSERT INTO cv_sync_metadata (endpoint, last_sync_date, last_sync_timestamp)
       VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO NOTHING`
    ).run(resource.name, startDate, new Date().toISOString());

    // Phase 1: discover changed ids via the (cheap) list endpoint.
    const ids = [];
    let offset = 0;
    const limit = 100;

    this.log(`  Finding changed ${resource.name}...${this.full ? " (full sync)" : ""}`);
    while (true) {
      const params = { field_list: "id", offset, limit };
      if (!this.full) params.filter = `date_last_updated:${startDate}|${endDate}`;
      params.sort = "date_last_updated:asc";

      const data = await this.apiCall(resource.list, params);
      if (!data) {
        // A list call that still fails after all retries (e.g. a persistent
        // 401 rate-limit artifact) skips this table; the sync continues with
        // the remaining resources. last_sync_date stays at `startDate`, so
        // the next run re-covers this window.
        this.log(
          `  WARNING: could not list ${resource.name} after ${MAX_RETRIES} attempts — skipping this table.`,
          { force: true }
        );
        return;
      }

      const results = data.results || [];
      if (results.length === 0) break;

      for (const row of results) {
        if (row.id) ids.push(row.id);
      }

      const total = data.number_of_total_results || 0;
      this.log(`    Found ${offset + results.length}/${total} ${resource.name} to update`);

      if (results.length < limit) break;
      offset += limit;
    }

    // Skip ids already processed in a previous run.
    const initialCount = ids.length;
    const remaining = ids.filter((id) => !processedIds.has(id));
    const skipped = initialCount - remaining.length;
    if (skipped > 0) {
      this.log(`  Skipping ${skipped} ${resource.name} (already processed). ${remaining.length} remaining.`);
    }

    // Phase 2: fetch each entity's full detail and store it verbatim.
    this.log(`  Fetching details for ${remaining.length} ${resource.name}...`);
    for (let i = 0; i < remaining.length; i++) {
      const id = remaining[i];
      const entity = await this.fetchDetails(resource, id);
      if (!entity) {
        // Deleted or transiently unavailable; skip gracefully (it will be
        // re-discovered if it is updated again within a future window).
        this.stats[`${resource.name}_failed`]++;
        this.log(`    Skipping ${resource.name} ${id} (detail fetch failed)`);
        continue;
      }

      const action = this.upsertRaw(resource, entity);
      if (action === "added") this.stats[`${resource.name}_added`]++;
      else if (action === "updated") this.stats[`${resource.name}_updated`]++;

      if (this.verbose || (i + 1) % 100 === 0) {
        const label = action ? action[0].toUpperCase() + action.slice(1) : "Skipped";
        this.log(`    [${i + 1}/${remaining.length}] ${label} ${resource.name}: ${entity.name || id}`);
      }

      processedIds.add(id);

      // Commit periodically and save resume state.
      if ((i + 1) % 50 === 0) {
        this.saveResumeState(resource.name, { processed_ids: [...processedIds] });
        this.log(`    --- SAVED RESUME STATE (${i + 1}/${remaining.length}) ---`);
      }
    }

    // Clear resume state on successful completion.
    this.clearResumeState(resource.name);
    this.log(`  Completed ${remaining.length} ${resource.name}`);

    this.setEndpointLastSync(resource.name, endDate);
  }

  async runSync(startDate = null) {
    this.ensureTables();

    const endDate = todayStr();

    // RESOURCES is ordered smallest-first so issue (the largest table) is
    // always synced last.
    for (const resource of RESOURCES) {
      const start = startDate || this.calculateSafeStartDate(resource.name);
      const last = this.getEndpointLastSync(resource.name);
      if (last) this.log(`${resource.name} last synced: ${last}`);
      this.log(`Syncing ${resource.name} from ${start} to ${endDate}${this.full ? " (FULL)" : ""}`);
      try {
        await this.syncResource(resource, start, endDate);
      } catch (e) {
        // A single table's unexpected failure should not abort the whole
        // sync (issue is last and the most important).
        this.log(`ERROR: ${resource.name} sync failed: ${e.message}`, { force: true });
      }
    }

    this.printStats();
  }

  printStats() {
    this.log("\n" + "=".repeat(50), { force: true });
    this.log("RAW API SYNC COMPLETE", { force: true });
    this.log("=".repeat(50), { force: true });
    this.log(`API calls made: ${this.stats.api_calls}`, { force: true });
    for (const r of RESOURCES) {
      this.log(
        `${r.name.padEnd(12)} added: ${this.stats[`${r.name}_added`]}, ` +
        `updated: ${this.stats[`${r.name}_updated`]}, failed: ${this.stats[`${r.name}_failed`]}`,
        { force: true }
      );
    }
    this.log("=".repeat(50), { force: true });
  }
}

// ─── API Key Validation ──────────────────────────────────────────────────────

// Validates the key against a list endpoint. A status 100 ("Invalid API Key")
// is retried: the list endpoints intermittently return it for a VALID key
// under load (a rate-limit artifact that clears after ~30s), so a single 100
// must not be treated as a definitively bad key.
async function validateApiKey(apiKey, verbose = true, fetchFn = globalThis.fetch) {
  if (verbose) console.log("Validating API key...");
  const url = `${API_BASE_URL}publishers/?api_key=${encodeURIComponent(apiKey)}&format=json&limit=1`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchFn(url, { headers: HEADERS });
      const data = await response.json();

      if (data.status_code === 1) {
        if (verbose) console.log("API key validated successfully!");
        return true;
      }
      if (data.status_code === RATE_LIMIT_STATUS) {
        if (verbose) console.log("API key is valid, but the rate limit is currently exhausted. Proceeding; calls will back off and retry.");
        return true;
      }
      if (data.status_code === 100) {
        if (attempt < MAX_RETRIES) {
          if (verbose) console.log(`  Transient "Invalid API Key" (status 100) — retrying in ${INVALID_KEY_BACKOFF_SECONDS}s (${attempt}/${MAX_RETRIES})...`);
          await sleep(INVALID_KEY_BACKOFF_SECONDS * 1000);
          continue;
        }
        if (verbose) console.log("ERROR: API key rejected (status 100) after all retries.");
        return false;
      }
      if (verbose) console.log(`Unexpected API response: ${data.error || "Unknown"}`);
      return false;
    } catch (e) {
      if (verbose) console.log(`ERROR: Could not connect to ComicVine: ${e.message}`);
      return false;
    }
  }
  return false;
}

// ─── Database Discovery ──────────────────────────────────────────────────────

// The rawapi database is updated in place (no dated-copy mechanism), so the
// default target is the most recent comicvine_rawapi_*.db in the directory.
function findLatestRawApiDatabase(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith("comicvine_rawapi_") && f.endsWith(".db"));
  } catch {
    return null;
  }
  files.sort().reverse();
  if (files.length > 0) return path.join(dir, files[0]);
  return null;
}

// ─── Full-Sync Confirmation ──────────────────────────────────────────────────

// A full sync makes one detail call per entity across all eleven tables
// (~1.5M calls, dominated by the ~1.1M issues). At the ComicVine rate limit
// (200 calls/hour, then a 1-hour ban) it takes on the order of weeks. Gate it
// behind an explicit confirmation so it is never triggered by accident.
async function confirmFullSync({ interactive, yes }) {
  if (yes) return true;

  const calls = "~1.5 million (one detail call per entity across all eleven tables)";
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
    dbPath: null,
    apiKey: null, startDate: null,
    full: false, nonInteractive: false, quiet: false, yes: false
  };

  let positional = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--full") args.full = true;
    else if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg === "--non-interactive") args.nonInteractive = true;
    else if (arg === "--quiet") args.quiet = true;
    else if (arg === "--db") args.dbPath = argv[++i];
    else if (arg === "--api-key") args.apiKey = argv[++i];
    else if (arg === "--start-date") args.startDate = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith("-") && positional === 0) {
      args.dbPath = arg;
      positional++;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
ComicVine Raw API Sync (Node.js)

Fetches the live ComicVine API and stores each entity's verbatim JSON into the
rawapi database's eleven cv_* tables, so the static snapshot tracks the live API.

Usage:
  node src/rawapi.js [database_path]
  node src/rawapi.js --db /path/to/comicvine_rawapi_YYYYMMDD.db
  node src/rawapi.js --full --yes

Options:
  --db <path>          Path to the rawapi database
                       (default: most recent comicvine_rawapi_*.db in the cwd)
  --api-key <key>      ComicVine API key (overrides .env COMICVINE_API_KEY)
  --start-date <date>  Custom start date YYYY-MM-DD (default: automatic)
  --full               Full sync: fetch every record (no date filter)
  --yes, -y            Confirm a full sync without an interactive prompt
  --non-interactive    Run without prompts (for cron)
  --quiet              Reduce output verbosity

Environment:
  COMICVINE_API_KEY    API key (from .env or process environment)

npm run rawapi         — incremental sync
npm run rawapi:full    — one-time full sync (~1.5M API calls)
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const interactive = !args.nonInteractive;
  const verbose = !args.quiet;

  if (interactive && verbose) {
    console.log("=".repeat(50));
    console.log("ComicVine Raw API Sync (Node.js)");
    console.log("=".repeat(50));
    console.log();
  }

  // Determine database path.
  let dbPath = args.dbPath;
  if (!dbPath) {
    dbPath = findLatestRawApiDatabase(process.cwd());
    if (dbPath && verbose) console.log(`Found database: ${dbPath}`);
  }
  if (!dbPath) {
    console.error("ERROR: No rawapi database found. Use --db to specify location.");
    console.error("Expected a file named comicvine_rawapi_*.db in the current directory.");
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`ERROR: Database not found: ${dbPath}`);
    process.exit(1);
  }

  // Get API key.
  const apiKey = args.apiKey || process.env.COMICVINE_API_KEY;
  if (!apiKey) {
    console.error("ERROR: No API key provided.");
    console.error("Add COMICVINE_API_KEY to .env (or set it in the process environment)");
    console.error("Or pass the --api-key flag");
    process.exit(1);
  }

  // Validate API key.
  if (!await validateApiKey(apiKey, verbose)) {
    process.exit(1);
  }

  // Gate an expensive full sync behind explicit confirmation.
  if (args.full) {
    const confirmed = await confirmFullSync({ interactive, yes: args.yes });
    if (!confirmed) {
      console.error("Full sync not confirmed. Exiting without syncing.");
      process.exit(1);
    }
  }

  // Validate custom start date.
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

  // Run the sync.
  const sync = new RawApiSync(dbPath, apiKey, { verbose, full: args.full });
  if (!sync.connect()) {
    process.exit(1);
  }

  let exitCode = 0;
  try {
    await sync.runSync(startDate);
  } catch (e) {
    if (e.name === "AbortError" || e.code === "ERR_ABORTED") {
      console.error(`\n\nInterrupted by user. Progress has been saved.`);
      exitCode = 130;
    } else {
      console.error(`\nERROR: Sync failed: ${e.message}`);
      console.error(e.stack);
      exitCode = 1;
    }
  } finally {
    sync.close();
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
  RawApiSync,
  RESOURCES,
  SNAPSHOT_DATE,
  validateApiKey,
  findLatestRawApiDatabase,
  confirmFullSync,
  API_BASE_URL,
  HEADERS,
  MAX_RETRIES,
  RATE_LIMIT_BACKOFF_SECONDS,
  API_DELAY_SECONDS
};
