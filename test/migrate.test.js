"use strict";
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { migrate, MIGRATIONS, SCHEMA_VERSION, readSchemaVersion } = require("../src/migrate.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLog() {
  const lines = [];
  const log = (message) => lines.push(message);
  log.lines = lines;
  return log;
}

function tempDb(name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "comicvine-migrate-test-"));
  return { dir, dbPath: path.join(dir, name) };
}

// Remove a per-test temp dir, tolerating EPERM/EBUSY (a just-closed WAL-mode
// SQLite DB can still be locked momentarily on Windows).
function cleanupTempDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    process.once("exit", () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });
  }
}

function tableNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// A pre-UPD-17 database: the legacy schema with every column the one-shot
// migrations act on (resume_state missing, api_detail_url stored, the concept
// first_appeared_in_issue JSON blob, the volume credit JSON columns, the
// issue-ref snapshot columns).
function makeLegacyDb() {
  const { dir, dbPath } = tempDb("legacy.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE cv_sync_metadata (endpoint TEXT PRIMARY KEY, last_sync_date TEXT NOT NULL, last_sync_timestamp TEXT NOT NULL);
    CREATE TABLE cv_publisher (id INTEGER PRIMARY KEY, name TEXT, api_detail_url TEXT);
    CREATE TABLE cv_issue (id INTEGER PRIMARY KEY, name TEXT, api_detail_url TEXT);
    CREATE TABLE cv_volume (id INTEGER PRIMARY KEY, name TEXT, api_detail_url TEXT, character_credits TEXT, person_credits TEXT, first_issue TEXT, last_issue TEXT);
    CREATE TABLE cv_person (id INTEGER PRIMARY KEY, name TEXT, api_detail_url TEXT);
    CREATE TABLE cv_concept (id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, api_detail_url TEXT, deck TEXT, description TEXT, date_added TEXT, date_last_updated TEXT, image_url TEXT, site_detail_url TEXT, first_appeared_in_issue TEXT, count_of_issue_appearances INTEGER, start_year TEXT);
    CREATE TABLE cv_volume_issue_ref (volume_id INTEGER NOT NULL, ref_type TEXT NOT NULL, issue_id INTEGER, key_order TEXT, name TEXT, issue_number TEXT, api_detail_url TEXT, PRIMARY KEY (volume_id, ref_type));
  `);
  db.prepare("INSERT INTO cv_concept (id, name, api_detail_url, first_appeared_in_issue) VALUES (?, ?, ?, ?)")
    .run(700, "Test Concept", "https://comicvine.gamespot.com/api/concept/4015-700/",
         JSON.stringify({ api_detail_url: "https://comicvine.gamespot.com/api/issue/4000-4001/", id: 4001, name: "Test Series #1", issue_number: "1" }));
  db.prepare("INSERT INTO cv_volume (id, name, api_detail_url, character_credits, first_issue) VALUES (?, ?, ?, ?, ?)")
    .run(300, "Test Series", "https://comicvine.gamespot.com/api/volume/4050-300/",
         JSON.stringify([{ id: 1, name: "Hero", api_detail_url: "https://comicvine.gamespot.com/api/character/4005-1/" }]),
         JSON.stringify({ id: 4001, name: "Test Series #1" }));
  db.prepare("INSERT INTO cv_publisher (id, name, api_detail_url) VALUES (?, ?, ?)").run(100, "Acme", "https://comicvine.gamespot.com/api/publisher/4050-100/");
  db.prepare("INSERT INTO cv_issue (id, name, api_detail_url) VALUES (?, ?, ?)").run(4001, "Test Series #1", "https://comicvine.gamespot.com/api/issue/4000-4001/");
  db.prepare("INSERT INTO cv_person (id, name, api_detail_url) VALUES (?, ?, ?)").run(200, "Jane", "https://comicvine.gamespot.com/api/person/4040-200/");
  db.close();
  return { dir, dbPath };
}

// ─── migrate() on a fresh database ───────────────────────────────────────────

test("migrate() builds the final schema on a fresh database and stamps it", () => {
  const { dir, dbPath } = tempDb("fresh.db");
  try {
    const conn = new DatabaseSync(dbPath); // creates the file
    const version = migrate(conn, makeLog());
    conn.close();
    assert.equal(version, SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 5);

    const db = new DatabaseSync(dbPath);
    const tables = tableNames(db);
    // Metadata tables (the stamp table is prefix-less: invisible to /api/status).
    assert.ok(tables.has("cv_sync_metadata"));
    assert.ok(tables.has("sync_errors"));
    assert.ok(tables.has("schema_version"));
    // The six resource tables the Node updater creates.
    for (const t of ["cv_team", "cv_storyarc", "cv_concept", "cv_character", "cv_location", "cv_power"]) {
      assert.ok(tables.has(t), `expected ${t}`);
    }
    // The join tables.
    for (const t of ["cv_volume_credit", "cv_volume_issue_ref", "cv_concept_credit"]) {
      assert.ok(tables.has(t), `expected ${t}`);
    }
    // FTS indexes for the six created resource tables (the four legacy base
    // tables are absent, so they get no FTS table).
    for (const t of ["cv_team_fts", "cv_storyarc_fts", "cv_concept_fts", "cv_character_fts", "cv_location_fts", "cv_power_fts"]) {
      assert.ok(tables.has(t), `expected ${t}`);
    }
    // The four legacy tables are Python-updater heritage: never created here.
    for (const t of ["cv_publisher", "cv_issue", "cv_volume", "cv_person"]) {
      assert.ok(!tables.has(t), `${t} should not be created`);
    }
    // cv_concept is created on the final schema (no legacy columns).
    const conceptCols = columnNames(db, "cv_concept");
    assert.ok(conceptCols.includes("first_appeared_in_issue_id"));
    assert.ok(!conceptCols.includes("api_detail_url"));
    assert.ok(!conceptCols.includes("first_appeared_in_issue"));
    // The six newer endpoints are seeded at the raw-dump snapshot date.
    const endpoints = db.prepare("SELECT endpoint FROM cv_sync_metadata ORDER BY endpoint").all().map((r) => r.endpoint);
    assert.deepEqual(endpoints, ["characters", "concepts", "locations", "powers", "storyarcs", "teams"]);
    assert.equal(readSchemaVersion(db), 5);
    db.close();
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── migrate() on a pre-migration database ───────────────────────────────────

test("migrate() upgrades a legacy database to the final schema", () => {
  const { dir, dbPath } = makeLegacyDb();
  try {
    const conn = new DatabaseSync(dbPath);
    const version = migrate(conn, makeLog());
    conn.close();
    assert.equal(version, 5);

    const db = new DatabaseSync(dbPath);
    // v1: resume_state added.
    assert.ok(columnNames(db, "cv_sync_metadata").includes("resume_state"));
    // v3: the concept api_detail_url is dropped.
    assert.ok(!columnNames(db, "cv_concept").includes("api_detail_url"));
    // v4: the four legacy api_detail_url columns are dropped.
    for (const t of ["cv_publisher", "cv_issue", "cv_volume", "cv_person"]) {
      assert.ok(!columnNames(db, t).includes("api_detail_url"), `${t}.api_detail_url should be dropped`);
    }
    // v5: the JSON blob is backfilled into the id column and dropped.
    const concept = db.prepare("SELECT * FROM cv_concept WHERE id = 700").get();
    assert.equal(concept.first_appeared_in_issue_id, 4001);
    assert.ok(!columnNames(db, "cv_concept").includes("first_appeared_in_issue"));
    // v2: the volume credit JSON is normalized into the join tables and the
    // JSON columns are dropped; the presence bitmask distinguishes [] from null.
    const volume = db.prepare("SELECT * FROM cv_volume WHERE id = 300").get();
    assert.equal(volume.credits_presence, 1, "character_credits was non-null (bit 0)");
    const volumeCols = columnNames(db, "cv_volume");
    for (const c of ["character_credits", "person_credits", "first_issue", "last_issue"]) {
      assert.ok(!volumeCols.includes(c), `${c} should be dropped`);
    }
    const credit = db.prepare("SELECT * FROM cv_volume_credit WHERE volume_id = 300").get();
    assert.equal(credit.credit_type, "character");
    assert.equal(credit.credit_id, 1);
    assert.equal(credit.name, "Hero");
    const ref = db.prepare("SELECT * FROM cv_volume_issue_ref WHERE volume_id = 300").get();
    assert.equal(ref.ref_type, "first");
    assert.equal(ref.issue_id, 4001);
    assert.ok(!columnNames(db, "cv_volume_issue_ref").includes("name"), "snapshot columns should be dropped");
    assert.equal(readSchemaVersion(db), 5);
    db.close();
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── The stamp guards re-runs ────────────────────────────────────────────────

test("migrate() is a no-op on an already-migrated database (stamp at final)", () => {
  const { dir, dbPath } = makeLegacyDb();
  try {
    const conn = new DatabaseSync(dbPath);
    migrate(conn, makeLog()); // first run: applies everything, stamps 5
    const log = makeLog();
    const version = migrate(conn, log); // second run: nothing to do
    conn.close();
    assert.equal(version, 5);
    assert.ok(!log.lines.some((l) => l.includes("Applying migration")),
      `no migrations should run, got: ${log.lines.join(" | ")}`);
  } finally {
    cleanupTempDir(dir);
  }
});

test("a partially-migrated database (stamp 2) runs only the newer migrations", () => {
  const { dir, dbPath } = makeLegacyDb();
  try {
    const conn = new DatabaseSync(dbPath);
    // Simulate a database that completed v1+v2 but was stamped before v3 ran.
    conn.exec("CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)");
    conn.prepare(
      "INSERT INTO schema_version (id, version) VALUES (1, ?) " +
      "ON CONFLICT(id) DO UPDATE SET version = excluded.version"
    ).run(2);
    const log = makeLog();
    const version = migrate(conn, log);
    conn.close();
    assert.equal(version, 5);
    const applied = log.lines.filter((l) => l.includes("Applying migration")).map((l) => l.match(/v(\d+)/)[1]);
    assert.deepEqual(applied, ["3", "4", "5"]);
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── CLI ──────────────────────────────────────────────────────────────────────

test("the CLI migrates a database with --db and reports the version", () => {
  const { dir, dbPath } = makeLegacyDb();
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "migrate.js"), "--db", dbPath], { encoding: "utf8" });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes("Schema version: 5"), result.stdout);
    const db = new DatabaseSync(dbPath);
    assert.equal(readSchemaVersion(db), 5);
    db.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("the CLI rejects a missing database", () => {
  const { dir, dbPath } = tempDb("absent.db");
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "migrate.js"), "--db", dbPath], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("Database not found"), result.stderr);
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── Module shape ─────────────────────────────────────────────────────────────

test("MIGRATIONS is an ordered, versioned list", () => {
  assert.equal(MIGRATIONS.length, 5);
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, [1, 2, 3, 4, 5]);
  for (const m of MIGRATIONS) {
    assert.equal(typeof m.up, "function");
    assert.equal(typeof m.name, "string");
  }
});
