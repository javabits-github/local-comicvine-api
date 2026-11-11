"use strict";
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const {
  RawApiSync,
  RESOURCES,
  SNAPSHOT_DATE,
  confirmFullSync,
  findLatestRawApiDatabase
} = require("../src/rawapi.js");

// ─── Test fixtures ───────────────────────────────────────────────────────────

// An empty database file. RawApiSync.ensureTables() creates the eleven uniform
// cv_* tables plus cv_sync_metadata, so the tests start from a bare file.
function makeEmptyDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "comicvine-rawapi-test-"));
  const dbPath = path.join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  db.close();
  return { dir, dbPath };
}

// Remove a per-test temp dir, tolerating EPERM/EBUSY. On Windows a just-closed
// WAL-mode SQLite DB can still be locked momentarily (WinError 32), so rmSync
// throws before the OS releases it. Fall back to a deferred async rm at process
// exit (by which point the lock is gone) so temp dirs don't accumulate.
function cleanupTempDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    process.once("exit", () => {
      try { require("node:fs").rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });
  }
}

// A deterministic entity for a given (singular) resource type + id. Shared by
// the mock fetch and the assertions so the verbatim-JSON comparison is exact.
function makeEntity(type, id) {
  return {
    id,
    name: `${type} ${id}`,
    date_last_updated: "2026-01-05 00:00:00",
    site_detail_url: `https://example.com/${type}/${id}`,
    api_detail_url: `https://comicvine.gamespot.com/api/${type}/x-${id}/`,
    description: `A ${type}`
  };
}

// One entity per resource (by plural list-endpoint name).
const ID_BY_LIST = {
  powers: 1, concepts: 2, story_arcs: 3, objects: 4, publishers: 5,
  locations: 6, teams: 7, people: 8, volumes: 9, characters: 10, issues: 11
};

// Mock fetch: each list endpoint returns one id; each detail endpoint returns
// the full entity. Records every requested pathname in `calls` for ordering
// assertions.
function makeMockFetch() {
  const calls = [];
  const fn = async (url) => {
    const u = new URL(url);
    const ep = u.pathname;
    calls.push(ep);

    // List endpoint: /api/<plural>/
    const listMatch = ep.match(/^\/api\/([a-z_]+)\/$/);
    if (listMatch) {
      const id = ID_BY_LIST[listMatch[1]];
      return { status: 200, ok: true, json: async () => ({ status_code: 1, results: [{ id }], number_of_total_results: 1 }) };
    }

    // Detail endpoint: /api/<singular>/<prefix>-<id>/
    const detailMatch = ep.match(/^\/api\/([a-z_]+)\/\d+-(\d+)\//);
    if (detailMatch) {
      const entity = makeEntity(detailMatch[1], parseInt(detailMatch[2], 10));
      return { status: 200, ok: true, json: async () => ({ status_code: 1, results: entity }) };
    }

    return { status: 200, ok: true, json: async () => ({ status_code: 1, results: [], number_of_total_results: 0 }) };
  };
  return { fn, calls };
}

// ─── runSync: verbatim storage, ordering, metadata ──────────────────────────

test("runSync stores verbatim JSON, syncs issue last, and records metadata", async () => {
  const { dir, dbPath } = makeEmptyDb();
  try {
    const { fn, calls } = makeMockFetch();
    const sync = new RawApiSync(dbPath, "test-key", { verbose: false, full: false, fetchFn: fn, apiDelayMs: 0 });
    assert.ok(sync.connect());
    await sync.runSync("2026-01-01");
    sync.close();

    const db = new DatabaseSync(dbPath);

    // Verbatim storage: raw_api_response is exactly JSON.stringify of the entity.
    const pub = db.prepare("SELECT * FROM cv_publisher WHERE id=5").get();
    assert.ok(pub, "publisher row should exist");
    const expected = makeEntity("publisher", 5);
    assert.equal(pub.raw_api_response, JSON.stringify(expected));
    // Denormalized columns come from the top-level JSON fields.
    assert.equal(pub.date_last_updated, expected.date_last_updated);
    assert.equal(pub.site_detail_url, expected.site_detail_url);

    // Every one of the eleven tables received its row.
    for (const r of RESOURCES) {
      const row = db.prepare(`SELECT id FROM ${r.table}`).get();
      assert.ok(row, `expected a row in ${r.table}`);
    }

    // Metadata: all eleven endpoints recorded.
    const metaCount = db.prepare("SELECT COUNT(*) c FROM cv_sync_metadata").get().c;
    assert.equal(metaCount, RESOURCES.length);

    // Ordering: the smallest (power) is first; issue is LAST (its detail call
    // is the final API call of the whole sync).
    assert.equal(calls[0], "/api/powers/");
    assert.equal(calls[calls.length - 2], "/api/issues/");
    assert.equal(calls[calls.length - 1], "/api/issue/4000-11/");

    db.close();
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── Upsert: the "updated" branch ───────────────────────────────────────────

test("upserting an existing row updates it in place (ON CONFLICT DO UPDATE)", async () => {
  const { dir, dbPath } = makeEmptyDb();
  try {
    const { fn } = makeMockFetch();
    const sync = new RawApiSync(dbPath, "test-key", { verbose: false, full: false, fetchFn: fn, apiDelayMs: 0 });
    assert.ok(sync.connect());
    sync.ensureTables();
    const publisher = RESOURCES.find((r) => r.name === "publisher");

    // First run: the row does not exist yet → "added".
    await sync.syncResource(publisher, "2026-01-01", "2026-01-02");
    assert.equal(sync.stats.publisher_added, 1);
    assert.equal(sync.stats.publisher_updated, 0);

    // Second run over the same window: the row exists → "updated", replaced in place.
    await sync.syncResource(publisher, "2026-01-01", "2026-01-02");
    assert.equal(sync.stats.publisher_added, 1, "added count must not change");
    assert.equal(sync.stats.publisher_updated, 1);

    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_publisher").get().c, 1, "still exactly one row");
    const row = db.prepare("SELECT * FROM cv_publisher WHERE id=5").get();
    assert.equal(row.raw_api_response, JSON.stringify(makeEntity("publisher", 5)));
    db.close();
    sync.close();
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── Resume ──────────────────────────────────────────────────────────────────

test("resume skips already-processed ids and clears state on completion", async () => {
  const { dir, dbPath } = makeEmptyDb();
  try {
    const { fn, calls } = makeMockFetch();
    const sync = new RawApiSync(dbPath, "test-key", { verbose: false, full: false, fetchFn: fn, apiDelayMs: 0 });
    assert.ok(sync.connect());
    sync.ensureTables();

    // Publisher 5 was already processed in a previous (interrupted) run.
    sync.saveResumeState("publisher", { processed_ids: [5] });

    const publisher = RESOURCES.find((r) => r.name === "publisher");
    await sync.syncResource(publisher, "2026-01-01", "2026-01-02");

    // The already-processed publisher must not be re-fetched.
    assert.ok(!calls.some((c) => c.includes("/publisher/4010-5/")), "should not re-fetch a processed publisher");
    // Resume state is cleared once the resource completes.
    assert.equal(sync.getResumeState("publisher"), null);

    sync.close();
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── Transient 401 / status 100 handling ─────────────────────────────────────

test("a persistent 401 on a list endpoint skips that table but the sync continues", async () => {
  const { dir, dbPath } = makeEmptyDb();
  try {
    const fetchFn = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/publishers/") {
        // Always 401 → apiCall exhausts its retries → the table is skipped.
        return { status: 401, ok: false, json: async () => ({ status_code: 100, error: "Invalid API Key" }) };
      }
      return { status: 200, ok: true, json: async () => ({ status_code: 1, results: [], number_of_total_results: 0 }) };
    };
    const sync = new RawApiSync(dbPath, "test-key", {
      verbose: false, full: false, fetchFn, apiDelayMs: 0,
      invalidKeyBackoffMs: 0, http420BackoffMs: 0
    });
    assert.ok(sync.connect());
    await sync.runSync("2026-01-01");
    sync.close();

    const db = new DatabaseSync(dbPath);
    // The publisher table was skipped (no rows stored).
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_publisher").get().c, 0);
    // But the sync continued: every endpoint still got a metadata row.
    const metaCount = db.prepare("SELECT COUNT(*) c FROM cv_sync_metadata").get().c;
    assert.equal(metaCount, RESOURCES.length);
    db.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("a transient status 100 is retried and then succeeds", async () => {
  let attempt = 0;
  const fetchFn = async () => {
    attempt++;
    if (attempt === 1) {
      return { status: 200, ok: true, json: async () => ({ status_code: 100, error: "Invalid API Key" }) };
    }
    return { status: 200, ok: true, json: async () => ({ status_code: 1, results: [], number_of_total_results: 0 }) };
  };
  const { dir, dbPath } = makeEmptyDb();
  try {
    const sync = new RawApiSync(dbPath, "test-key", { verbose: false, full: false, fetchFn, apiDelayMs: 0, invalidKeyBackoffMs: 0 });
    assert.ok(sync.connect());
    sync.ensureTables();
    const publisher = RESOURCES.find((r) => r.name === "publisher");
    await sync.syncResource(publisher, "2026-01-01", "2026-01-02");
    sync.close();
    assert.equal(attempt, 2, "should have retried after the transient 100");
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── Date filtering ──────────────────────────────────────────────────────────

test("incremental sync includes a date filter; full sync omits it", async () => {
  const publisher = RESOURCES.find((r) => r.name === "publisher");

  // Incremental
  let urls = [];
  const incFetch = async (url) => {
    urls.push(url);
    return { status: 200, ok: true, json: async () => ({ status_code: 1, results: [], number_of_total_results: 0 }) };
  };
  let { dir, dbPath } = makeEmptyDb();
  try {
    const sync = new RawApiSync(dbPath, "test-key", { verbose: false, full: false, fetchFn: incFetch, apiDelayMs: 0 });
    assert.ok(sync.connect());
    sync.ensureTables();
    await sync.syncResource(publisher, "2026-01-01", "2026-01-02");
    sync.close();
    assert.equal(new URL(urls[0]).searchParams.get("filter"), "date_last_updated:2026-01-01|2026-01-02");
  } finally {
    cleanupTempDir(dir);
  }

  // Full
  urls = [];
  const fullFetch = async (url) => {
    urls.push(url);
    return { status: 200, ok: true, json: async () => ({ status_code: 1, results: [], number_of_total_results: 0 }) };
  };
  ({ dir, dbPath } = makeEmptyDb());
  try {
    const sync = new RawApiSync(dbPath, "test-key", { verbose: false, full: true, fetchFn: fullFetch, apiDelayMs: 0 });
    assert.ok(sync.connect());
    sync.ensureTables();
    await sync.syncResource(publisher, "2026-01-01", "2026-01-02");
    sync.close();
    assert.equal(new URL(urls[0]).searchParams.get("filter"), null, "full sync should not include a date filter");
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── Metadata start-date seeding ─────────────────────────────────────────────

test("calculateSafeStartDate seeds new endpoints at SNAPSHOT_DATE and overlaps existing by 1 day", () => {
  const { dir, dbPath } = makeEmptyDb();
  try {
    const sync = new RawApiSync(dbPath, "test-key", { verbose: false });
    assert.ok(sync.connect());
    sync.ensureTables();
    // No recorded sync yet → the snapshot date.
    assert.equal(sync.calculateSafeStartDate("publisher"), SNAPSHOT_DATE);
    // After a sync → lastSync minus one day (same-day overlap).
    sync.setEndpointLastSync("publisher", "2026-03-01");
    assert.equal(sync.calculateSafeStartDate("publisher"), "2026-02-28");
    sync.close();
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── Database discovery ──────────────────────────────────────────────────────

test("findLatestRawApiDatabase returns the most recent comicvine_rawapi_*.db", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "comicvine-rawapi-find-"));
  try {
    writeFileSync(path.join(dir, "comicvine_rawapi_20260101.db"), "");
    writeFileSync(path.join(dir, "comicvine_rawapi_20260122.db"), "");
    writeFileSync(path.join(dir, "localcv.db"), ""); // a different family — ignored
    const latest = findLatestRawApiDatabase(dir);
    assert.equal(latest, path.join(dir, "comicvine_rawapi_20260122.db"));
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── confirmFullSync ─────────────────────────────────────────────────────────

test("confirmFullSync returns true when --yes is passed without prompting", async () => {
  assert.equal(await confirmFullSync({ interactive: false, yes: true }), true);
});

test("confirmFullSync refuses a non-interactive full sync without --yes", async () => {
  assert.equal(await confirmFullSync({ interactive: false, yes: false }), false);
});
