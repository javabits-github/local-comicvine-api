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
    CREATE TABLE cv_publisher (id INTEGER PRIMARY KEY, name TEXT, api_detail_url TEXT, characters TEXT, story_arcs TEXT, teams TEXT, volumes TEXT);
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
  db.prepare("INSERT INTO cv_publisher (id, name, api_detail_url, characters, story_arcs, teams, volumes) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(100, "Acme", "https://comicvine.gamespot.com/api/publisher/4050-100/",
         JSON.stringify([{ id: 1, name: "A Character", api_detail_url: "https://comicvine.gamespot.com/api/character/4005-1/", site_detail_url: "https://comicvine.gamespot.com/a-character/4005-1/" }]),
         "[]", "[]",
         JSON.stringify([{ id: 2, name: "A Volume", api_detail_url: "https://comicvine.gamespot.com/api/volume/4050-2/", site_detail_url: "https://comicvine.gamespot.com/a-volume/4050-2/" }]));
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
    assert.equal(SCHEMA_VERSION, 13);

    const db = new DatabaseSync(dbPath);
    const tables = tableNames(db);
    // Metadata tables (the stamp table is prefix-less: invisible to /api/status).
    assert.ok(tables.has("cv_sync_metadata"));
    assert.ok(tables.has("sync_errors"));
    assert.ok(tables.has("schema_version"));
    // The eleven resource tables (the four legacy tables included — DB-3).
    for (const t of ["cv_publisher", "cv_volume", "cv_issue", "cv_person", "cv_team", "cv_storyarc", "cv_concept", "cv_character", "cv_location", "cv_power", "cv_object"]) {
      assert.ok(tables.has(t), `expected ${t}`);
    }
    // The join tables.
    for (const t of ["cv_volume_credit", "cv_volume_issue_ref", "cv_concept_credit", "cv_publisher_credit", "cv_team_credit", "cv_person_credit", "cv_storyarc_credit", "cv_object_credit", "cv_issue_credit", "cv_issue_image"]) {
      assert.ok(tables.has(t), `expected ${t}`);
    }
    // FTS indexes for all eleven resource tables.
    for (const t of ["cv_publisher_fts", "cv_volume_fts", "cv_issue_fts", "cv_person_fts", "cv_team_fts", "cv_storyarc_fts", "cv_concept_fts", "cv_character_fts", "cv_location_fts", "cv_power_fts", "cv_object_fts"]) {
      assert.ok(tables.has(t), `expected ${t}`);
    }
    // The four legacy tables are created on the final schema (DB-3): the JSON
    // collection columns and api_detail_url are absent, and the presence
    // bitmasks (volume/issue) are present.
    const publisherCols = columnNames(db, "cv_publisher");
    for (const c of ["characters", "story_arcs", "teams", "volumes", "api_detail_url"]) {
      assert.ok(!publisherCols.includes(c), `cv_publisher.${c} should be absent`);
    }
    const volumeCols = columnNames(db, "cv_volume");
    assert.ok(volumeCols.includes("credits_presence"), "cv_volume.credits_presence should be present");
    for (const c of ["character_credits", "person_credits", "first_issue", "last_issue", "api_detail_url"]) {
      assert.ok(!volumeCols.includes(c), `cv_volume.${c} should be absent`);
    }
    const issueCols = columnNames(db, "cv_issue");
    assert.ok(issueCols.includes("credits_presence"), "cv_issue.credits_presence should be present");
    for (const c of ["character_credits", "associated_images", "first_appearance_characters", "api_detail_url"]) {
      assert.ok(!issueCols.includes(c), `cv_issue.${c} should be absent`);
    }
    const personCols = columnNames(db, "cv_person");
    for (const c of ["created_characters", "issue_credits", "story_arc_credits", "volume_credits", "api_detail_url"]) {
      assert.ok(!personCols.includes(c), `cv_person.${c} should be absent`);
    }
    // cv_concept is created on the final schema (no legacy columns).
    const conceptCols = columnNames(db, "cv_concept");
    assert.ok(conceptCols.includes("first_appeared_in_issue_id"));
    assert.ok(!conceptCols.includes("api_detail_url"));
    assert.ok(!conceptCols.includes("first_appeared_in_issue"));
    // SRV-6e: cv_team is created on the final schema — the inline scalar-ref
    // columns are present and the eleven JSON columns are absent.
    const teamCols = columnNames(db, "cv_team");
    for (const c of ["publisher_id", "publisher_name", "publisher_key_order", "first_appeared_in_issue_id", "first_appeared_in_issue_name", "first_appeared_in_issue_issue_number", "first_appeared_in_issue_key_order"]) {
      assert.ok(teamCols.includes(c), `expected ${c}`);
    }
    for (const c of ["publisher", "first_appeared_in_issue", "character_enemies", "character_friends", "characters", "disbanded_in_issues", "issues_disbanded_in", "issue_credits", "movies", "story_arc_credits", "volume_credits"]) {
      assert.ok(!teamCols.includes(c), `${c} should be absent`);
    }
    // SRV-6b: cv_storyarc is created on the final schema — the inline scalar-ref
    // columns are present and the four JSON columns are absent.
    const storyarcCols = columnNames(db, "cv_storyarc");
    for (const c of ["publisher_id", "publisher_name", "publisher_site_detail_url", "publisher_key_order", "first_appeared_in_issue_id", "first_appeared_in_issue_name", "first_appeared_in_issue_issue_number", "first_appeared_in_issue_key_order", "episodes", "first_appeared_in_episode"]) {
      assert.ok(storyarcCols.includes(c), `expected ${c}`);
    }
    for (const c of ["publisher", "first_appeared_in_issue", "issues", "movies"]) {
      assert.ok(!storyarcCols.includes(c), `${c} should be absent`);
    }
    // SRV-6h: cv_object is created on the final schema — first_appeared_in_issue_id
    // is present and the four JSON collection columns are absent.
    const objectCols = columnNames(db, "cv_object");
    assert.ok(objectCols.includes("first_appeared_in_issue_id"));
    for (const c of ["issue_credits", "volume_credits", "story_arc_credits", "movies"]) {
      assert.ok(!objectCols.includes(c), `${c} should be absent`);
    }
    // The seven newer endpoints are seeded at the raw-dump snapshot date.
    const endpoints = db.prepare("SELECT endpoint FROM cv_sync_metadata ORDER BY endpoint").all().map((r) => r.endpoint);
    assert.deepEqual(endpoints, ["characters", "concepts", "locations", "objects", "powers", "storyarcs", "teams"]);
    assert.equal(readSchemaVersion(db), 13);
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
    assert.equal(version, 13);

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
    // v7: the publisher collection JSON is normalized into cv_publisher_credit
    // and the JSON columns are dropped (no presence bitmask — the live API is
    // never null for these, so [] and null both yield no join rows).
    const publisherCols = columnNames(db, "cv_publisher");
    for (const c of ["characters", "story_arcs", "teams", "volumes"]) {
      assert.ok(!publisherCols.includes(c), `${c} should be dropped`);
    }
    const pubCredit = db.prepare("SELECT * FROM cv_publisher_credit WHERE publisher_id = 100 ORDER BY credit_type").all();
    assert.equal(pubCredit.length, 2, "one character + one volume (story_arcs/teams were [])");
    assert.deepEqual(
      pubCredit.map((r) => [r.credit_type, r.credit_id, r.name]),
      [["character", 1, "A Character"], ["volume", 2, "A Volume"]]
    );
    assert.equal(readSchemaVersion(db), 13);
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
    migrate(conn, makeLog()); // first run: applies everything, stamps 7
    const log = makeLog();
    const version = migrate(conn, log); // second run: nothing to do
    conn.close();
    assert.equal(version, 13);
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
    assert.equal(version, 13);
    const applied = log.lines.filter((l) => l.includes("Applying migration")).map((l) => l.match(/v(\d+)/)[1]);
    assert.deepEqual(applied, ["3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13"]);
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
    assert.ok(result.stdout.includes("Schema version: 13"), result.stdout);
    const db = new DatabaseSync(dbPath);
    assert.equal(readSchemaVersion(db), 13);
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
  assert.equal(MIGRATIONS.length, 13);
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  for (const m of MIGRATIONS) {
    assert.equal(typeof m.up, "function");
    assert.equal(typeof m.name, "string");
  }
});

// ─── v6 (UPD-8) in isolation ──────────────────────────────────────────────────

test("v6 (UPD-8) converts '[]' first_appearance_* to NULL, leaving NULL/populated intact", () => {
  const { dir, dbPath } = tempDb("upd8.db");
  try {
    const cols = ["first_appearance_characters", "first_appearance_concepts", "first_appearance_locations", "first_appearance_objects", "first_appearance_storyarcs", "first_appearance_teams"];
    const conn = new DatabaseSync(dbPath);
    conn.exec(
      `CREATE TABLE cv_issue (id INTEGER PRIMARY KEY, name TEXT, ` +
      cols.map((c) => `${c} TEXT`).join(", ") + `);`
    );
    const insert = conn.prepare(
      `INSERT INTO cv_issue (id, name, ${cols.join(", ")}) VALUES (?, ?, ${cols.map(() => "?").join(", ")})`
    );
    // Row 1: all six "[]" (the pre-UPD-8 storage of a null collection) → all NULL.
    insert.run(1, "Issue 1", ...cols.map(() => "[]"));
    // Row 2: all six already NULL (the UPD-7 window) → stay NULL.
    insert.run(2, "Issue 2", ...cols.map(() => null));
    // Row 3: one populated, the rest "[]" → the populated stays, the "[]" become NULL.
    insert.run(3, "Issue 3", JSON.stringify([{ id: 4, name: "A Character" }]), ...cols.slice(1).map(() => "[]"));
    conn.close();

    const db = new DatabaseSync(dbPath);
    const v6 = MIGRATIONS.find((m) => m.version === 6);
    v6.up(db, makeLog());

    const r1 = db.prepare("SELECT * FROM cv_issue WHERE id = 1").get();
    for (const c of cols) assert.equal(r1[c], null, `row 1 ${c} should be NULL`);
    const r2 = db.prepare("SELECT * FROM cv_issue WHERE id = 2").get();
    for (const c of cols) assert.equal(r2[c], null, `row 2 ${c} should be NULL`);
    const r3 = db.prepare("SELECT * FROM cv_issue WHERE id = 3").get();
    assert.deepEqual(JSON.parse(r3.first_appearance_characters), [{ id: 4, name: "A Character" }]);
    for (const c of cols.slice(1)) assert.equal(r3[c], null, `row 3 ${c} should be NULL`);

    // Idempotent: a re-run is a no-op (the rows are already NULL).
    v6.up(db, makeLog());
    assert.equal(db.prepare("SELECT first_appearance_characters FROM cv_issue WHERE id = 1").get().first_appearance_characters, null);
    assert.deepEqual(JSON.parse(db.prepare("SELECT first_appearance_characters FROM cv_issue WHERE id = 3").get().first_appearance_characters), [{ id: 4, name: "A Character" }]);
    db.close();
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── v7 (SRV-6a) in isolation ─────────────────────────────────────────────────

test("v7 (SRV-6a) normalizes publisher collections into cv_publisher_credit and drops the JSON columns", () => {
  const { dir, dbPath } = tempDb("srv6a.db");
  try {
    const conn = new DatabaseSync(dbPath);
    conn.exec(`
      CREATE TABLE cv_publisher (id INTEGER PRIMARY KEY, name TEXT, characters TEXT, story_arcs TEXT, teams TEXT, volumes TEXT);
      CREATE TABLE cv_publisher_credit (publisher_id INTEGER NOT NULL, credit_type TEXT NOT NULL, position INTEGER NOT NULL, credit_id INTEGER, name TEXT, api_detail_url TEXT, site_detail_url TEXT, PRIMARY KEY (publisher_id, credit_type, position));
    `);
    const insert = conn.prepare("INSERT INTO cv_publisher (id, name, characters, story_arcs, teams, volumes) VALUES (?, ?, ?, ?, ?, ?)");
    // Row 1: one character + one volume; story_arcs/teams are [].
    insert.run(1, "Pub 1",
      JSON.stringify([{ id: 10, name: "Char A", api_detail_url: "https://comicvine.gamespot.com/api/character/4005-10/", site_detail_url: "https://comicvine.gamespot.com/char-a/4005-10/" }]),
      "[]", "[]",
      JSON.stringify([{ id: 20, name: "Vol A", api_detail_url: "https://comicvine.gamespot.com/api/volume/4050-20/", site_detail_url: "https://comicvine.gamespot.com/vol-a/4050-20/" }]));
    // Row 2: all four NULL (a pre-SRV-6a artifact) → no join rows.
    insert.run(2, "Pub 2", null, null, null, null);
    // Row 3: all four [] → no join rows.
    insert.run(3, "Pub 3", "[]", "[]", "[]", "[]");
    conn.close();

    const db = new DatabaseSync(dbPath);
    const v7 = MIGRATIONS.find((m) => m.version === 7);
    v7.up(db, makeLog());

    // The JSON columns are dropped.
    const cols = columnNames(db, "cv_publisher");
    for (const c of ["characters", "story_arcs", "teams", "volumes"]) {
      assert.ok(!cols.includes(c), `${c} should be dropped`);
    }
    // Row 1: one character + one volume join row (story_arcs/teams were []).
    const rows1 = db.prepare("SELECT credit_type, credit_id, name, api_detail_url, site_detail_url FROM cv_publisher_credit WHERE publisher_id = 1 ORDER BY credit_type").all();
    assert.equal(rows1.length, 2);
    assert.equal(rows1[0].credit_type, "character");
    assert.equal(rows1[0].credit_id, 10);
    assert.equal(rows1[0].name, "Char A");
    assert.equal(rows1[0].api_detail_url, "https://comicvine.gamespot.com/api/character/4005-10/");
    assert.equal(rows1[0].site_detail_url, "https://comicvine.gamespot.com/char-a/4005-10/");
    assert.equal(rows1[1].credit_type, "volume");
    assert.equal(rows1[1].credit_id, 20);
    assert.equal(rows1[1].name, "Vol A");
    assert.equal(rows1[1].api_detail_url, "https://comicvine.gamespot.com/api/volume/4050-20/");
    assert.equal(rows1[1].site_detail_url, "https://comicvine.gamespot.com/vol-a/4050-20/");
    // Rows 2 and 3: no join rows (NULL and [] both yield none).
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_publisher_credit WHERE publisher_id = 2").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_publisher_credit WHERE publisher_id = 3").get().c, 0);

    // Idempotent: a re-run is a no-op (the columns are already dropped).
    v7.up(db, makeLog());
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_publisher_credit WHERE publisher_id = 1").get().c, 2);
    db.close();
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── v8 (SRV-6e) in isolation ─────────────────────────────────────────────────

test("v8 (SRV-6e) normalizes team collections into cv_team_credit and the scalar refs into inline columns", () => {
  const { dir, dbPath } = tempDb("srv6e.db");
  try {
    const conn = new DatabaseSync(dbPath);
    conn.exec(`
      CREATE TABLE cv_team (id INTEGER PRIMARY KEY, name TEXT, publisher TEXT, first_appeared_in_issue TEXT, character_enemies TEXT, character_friends TEXT, characters TEXT, disbanded_in_issues TEXT, issues_disbanded_in TEXT, issue_credits TEXT, movies TEXT, story_arc_credits TEXT, volume_credits TEXT);
      CREATE TABLE cv_team_credit (team_id INTEGER NOT NULL, credit_type TEXT NOT NULL, position INTEGER NOT NULL, credit_id INTEGER, name TEXT, api_detail_url TEXT, site_detail_url TEXT, PRIMARY KEY (team_id, credit_type, position));
    `);
    const insert = conn.prepare("INSERT INTO cv_team (id, name, publisher, first_appeared_in_issue, character_enemies, character_friends, characters, disbanded_in_issues, issues_disbanded_in, issue_credits, movies, story_arc_credits, volume_credits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    // Row 1: a populated team (id-first key order, the January dump form). One
    // character_enemy + one issue_credit + one disbanded_in_issue; the rest [].
    insert.run(1, "Team 1",
      JSON.stringify({ id: 31, name: "Marvel", api_detail_url: "https://comicvine.gamespot.com/api/publisher/4010-31/" }),
      JSON.stringify({ id: 20965, name: "Elektra", issue_number: "168", api_detail_url: "https://comicvine.gamespot.com/api/first_appeared_in_issue/4000-20965/" }),
      JSON.stringify([{ id: 10, name: "Enemy A", api_detail_url: "https://comicvine.gamespot.com/api/character/4005-10/", site_detail_url: "https://comicvine.gamespot.com/enemy-a/" }]),
      "[]", "[]",
      JSON.stringify([{ id: 20, name: "Disband Issue", api_detail_url: "https://comicvine.gamespot.com/api/issue/4000-20/", site_detail_url: "https://comicvine.gamespot.com/disband/" }]),
      JSON.stringify([{ id: 20, name: "Disband Issue", api_detail_url: "https://comicvine.gamespot.com/api/issue/4000-20/", site_detail_url: "https://comicvine.gamespot.com/disband/" }]),
      JSON.stringify([{ id: 30, name: "Credit Issue", api_detail_url: "https://comicvine.gamespot.com/api/issue/4000-30/", site_detail_url: "https://comicvine.gamespot.com/credit/" }]),
      "[]", "[]", "[]");
    // Row 2: all collections NULL (a pre-SRV-6e artifact) + null scalar refs.
    insert.run(2, "Team 2", null, null, null, null, null, null, null, null, null, null, null);
    conn.close();

    const db = new DatabaseSync(dbPath);
    const v8 = MIGRATIONS.find((m) => m.version === 8);
    v8.up(db, makeLog());

    // The eleven JSON columns are dropped.
    const cols = columnNames(db, "cv_team");
    for (const c of ["publisher", "first_appeared_in_issue", "character_enemies", "character_friends", "characters", "disbanded_in_issues", "issues_disbanded_in", "issue_credits", "movies", "story_arc_credits", "volume_credits"]) {
      assert.ok(!cols.includes(c), `${c} should be dropped`);
    }
    // The seven inline scalar-ref columns are added.
    for (const c of ["publisher_id", "publisher_name", "publisher_key_order", "first_appeared_in_issue_id", "first_appeared_in_issue_name", "first_appeared_in_issue_issue_number", "first_appeared_in_issue_key_order"]) {
      assert.ok(cols.includes(c), `${c} should be added`);
    }
    // Row 1: the scalar refs are backfilled (id + name + key_order).
    const team1 = db.prepare("SELECT * FROM cv_team WHERE id = 1").get();
    assert.equal(team1.publisher_id, 31);
    assert.equal(team1.publisher_name, "Marvel");
    assert.deepEqual(JSON.parse(team1.publisher_key_order), ["id", "name", "api_detail_url"]);
    assert.equal(team1.first_appeared_in_issue_id, 20965);
    assert.equal(team1.first_appeared_in_issue_name, "Elektra");
    assert.equal(team1.first_appeared_in_issue_issue_number, "168");
    assert.deepEqual(JSON.parse(team1.first_appeared_in_issue_key_order), ["id", "name", "issue_number", "api_detail_url"]);
    // Row 1: one character_enemy + one disbanded_in_issue + one issue_credit
    // (character_friends/characters/movies/story_arc/volume were []).
    const rows1 = db.prepare("SELECT credit_type, credit_id, name FROM cv_team_credit WHERE team_id = 1 ORDER BY credit_type, position").all();
    assert.equal(rows1.length, 3);
    assert.deepEqual(rows1.map((r) => [r.credit_type, r.credit_id, r.name]),
      [["character_enemy", 10, "Enemy A"], ["disbanded_in_issue", 20, "Disband Issue"], ["issue_credit", 30, "Credit Issue"]]);
    // Row 2: no join rows (NULL collections) + null scalar refs.
    const team2 = db.prepare("SELECT * FROM cv_team WHERE id = 2").get();
    assert.equal(team2.publisher_id, null);
    assert.equal(team2.publisher_name, null);
    assert.equal(team2.first_appeared_in_issue_id, null);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_team_credit WHERE team_id = 2").get().c, 0);

    // Idempotent: a re-run is a no-op (the columns are already dropped).
    v8.up(db, makeLog());
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_team_credit WHERE team_id = 1").get().c, 3);
    db.close();
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── v9 (SRV-6d) in isolation ─────────────────────────────────────────────────

test("v9 (SRV-6d) normalizes person collections into cv_person_credit and drops the JSON columns", () => {
  const { dir, dbPath } = tempDb("srv6d.db");
  try {
    const conn = new DatabaseSync(dbPath);
    conn.exec(`
      CREATE TABLE cv_person (id INTEGER PRIMARY KEY, name TEXT, created_characters TEXT, issue_credits TEXT, story_arc_credits TEXT, volume_credits TEXT);
      CREATE TABLE cv_person_credit (person_id INTEGER NOT NULL, credit_type TEXT NOT NULL, position INTEGER NOT NULL, credit_id INTEGER, name TEXT, api_detail_url TEXT, site_detail_url TEXT, PRIMARY KEY (person_id, credit_type, position));
    `);
    const insert = conn.prepare("INSERT INTO cv_person (id, name, created_characters, issue_credits, story_arc_credits, volume_credits) VALUES (?, ?, ?, ?, ?, ?)");
    // Row 1: one created_character + one volume_credit; issue_credits/story_arc_credits are [].
    insert.run(1, "Person 1",
      JSON.stringify([{ id: 10, name: "Char A", api_detail_url: "https://comicvine.gamespot.com/api/character/4005-10/", site_detail_url: "https://comicvine.gamespot.com/char-a/4005-10/" }]),
      "[]",
      "[]",
      JSON.stringify([{ id: 20, name: "Vol A", api_detail_url: "https://comicvine.gamespot.com/api/volume/4050-20/", site_detail_url: "https://comicvine.gamespot.com/vol-a/4050-20/" }]));
    // Row 2: all four NULL (a Node-updater artifact) → no join rows.
    insert.run(2, "Person 2", null, null, null, null);
    // Row 3: all four [] → no join rows.
    insert.run(3, "Person 3", "[]", "[]", "[]", "[]");
    conn.close();

    const db = new DatabaseSync(dbPath);
    const v9 = MIGRATIONS.find((m) => m.version === 9);
    v9.up(db, makeLog());

    // The four JSON columns are dropped.
    const cols = columnNames(db, "cv_person");
    for (const c of ["created_characters", "issue_credits", "story_arc_credits", "volume_credits"]) {
      assert.ok(!cols.includes(c), `${c} should be dropped`);
    }
    // Row 1: one created_character + one volume_credit (issue_credits/story_arc_credits were []).
    const rows1 = db.prepare("SELECT credit_type, credit_id, name, api_detail_url, site_detail_url FROM cv_person_credit WHERE person_id = 1 ORDER BY credit_type, position").all();
    assert.equal(rows1.length, 2);
    assert.deepEqual(rows1.map((r) => [r.credit_type, r.credit_id, r.name]),
      [["created_character", 10, "Char A"], ["volume_credit", 20, "Vol A"]]);
    assert.equal(rows1[0].api_detail_url, "https://comicvine.gamespot.com/api/character/4005-10/");
    assert.equal(rows1[0].site_detail_url, "https://comicvine.gamespot.com/char-a/4005-10/");
    assert.equal(rows1[1].api_detail_url, "https://comicvine.gamespot.com/api/volume/4050-20/");
    assert.equal(rows1[1].site_detail_url, "https://comicvine.gamespot.com/vol-a/4050-20/");
    // Rows 2 and 3: no join rows (NULL and [] both yield none).
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_person_credit WHERE person_id = 2").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_person_credit WHERE person_id = 3").get().c, 0);

    // Idempotent: a re-run is a no-op (the columns are already dropped).
    v9.up(db, makeLog());
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_person_credit WHERE person_id = 1").get().c, 2);
    db.close();
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── v10 (SRV-6b) in isolation ───────────────────────────────────────────────

test("v10 (SRV-6b) normalizes story arc collections into cv_storyarc_credit and the scalar refs into inline columns", () => {
  const { dir, dbPath } = tempDb("srv6b.db");
  try {
    const conn = new DatabaseSync(dbPath);
    conn.exec(`
      CREATE TABLE cv_storyarc (id INTEGER PRIMARY KEY, name TEXT, publisher TEXT, first_appeared_in_issue TEXT, issues TEXT, movies TEXT);
      CREATE TABLE cv_storyarc_credit (storyarc_id INTEGER NOT NULL, credit_type TEXT NOT NULL, position INTEGER NOT NULL, credit_id INTEGER, name TEXT, api_detail_url TEXT, site_detail_url TEXT, PRIMARY KEY (storyarc_id, credit_type, position));
    `);
    const insert = conn.prepare("INSERT INTO cv_storyarc (id, name, publisher, first_appeared_in_issue, issues, movies) VALUES (?, ?, ?, ?, ?, ?)");
    // Row 1: a populated story arc (api_detail_url-first key order, the
    // localcv.db majority form). One issue; movies is []. The publisher ref
    // carries a site_detail_url the team's lacks.
    insert.run(1, "Arc 1",
      JSON.stringify({ api_detail_url: "https://comicvine.gamespot.com/api/publisher/4010-31/", id: 31, name: "Marvel", site_detail_url: "https://comicvine.gamespot.com/marvel/" }),
      JSON.stringify({ api_detail_url: "https://comicvine.gamespot.com/api/first_appeared_in_issue/4000-20965/", id: 20965, name: "Elektra", issue_number: "168" }),
      JSON.stringify([{ id: 10, name: "Issue A", api_detail_url: "https://comicvine.gamespot.com/api/issue/4000-10/", site_detail_url: "https://comicvine.gamespot.com/issue-a/" }]),
      "[]");
    // Row 2: all four NULL (a Node-updater artifact) → no join rows + null refs.
    insert.run(2, "Arc 2", null, null, null, null);
    conn.close();

    const db = new DatabaseSync(dbPath);
    const v10 = MIGRATIONS.find((m) => m.version === 10);
    v10.up(db, makeLog());

    // The four JSON columns are dropped.
    const cols = columnNames(db, "cv_storyarc");
    for (const c of ["publisher", "first_appeared_in_issue", "issues", "movies"]) {
      assert.ok(!cols.includes(c), `${c} should be dropped`);
    }
    // The eight inline scalar-ref columns are added.
    for (const c of ["publisher_id", "publisher_name", "publisher_site_detail_url", "publisher_key_order", "first_appeared_in_issue_id", "first_appeared_in_issue_name", "first_appeared_in_issue_issue_number", "first_appeared_in_issue_key_order"]) {
      assert.ok(cols.includes(c), `${c} should be added`);
    }
    // Row 1: the scalar refs are backfilled (id + display fields + key_order).
    const arc1 = db.prepare("SELECT * FROM cv_storyarc WHERE id = 1").get();
    assert.equal(arc1.publisher_id, 31);
    assert.equal(arc1.publisher_name, "Marvel");
    assert.equal(arc1.publisher_site_detail_url, "https://comicvine.gamespot.com/marvel/");
    assert.deepEqual(JSON.parse(arc1.publisher_key_order), ["api_detail_url", "id", "name", "site_detail_url"]);
    assert.equal(arc1.first_appeared_in_issue_id, 20965);
    assert.equal(arc1.first_appeared_in_issue_name, "Elektra");
    assert.equal(arc1.first_appeared_in_issue_issue_number, "168");
    assert.deepEqual(JSON.parse(arc1.first_appeared_in_issue_key_order), ["api_detail_url", "id", "name", "issue_number"]);
    // Row 1: one issue join row (movies was []).
    const rows1 = db.prepare("SELECT credit_type, credit_id, name, api_detail_url, site_detail_url FROM cv_storyarc_credit WHERE storyarc_id = 1 ORDER BY credit_type, position").all();
    assert.equal(rows1.length, 1);
    assert.deepEqual(rows1.map((r) => [r.credit_type, r.credit_id, r.name]), [["issue", 10, "Issue A"]]);
    assert.equal(rows1[0].api_detail_url, "https://comicvine.gamespot.com/api/issue/4000-10/");
    assert.equal(rows1[0].site_detail_url, "https://comicvine.gamespot.com/issue-a/");
    // Row 2: no join rows (NULL collections) + null scalar refs.
    const arc2 = db.prepare("SELECT * FROM cv_storyarc WHERE id = 2").get();
    assert.equal(arc2.publisher_id, null);
    assert.equal(arc2.publisher_name, null);
    assert.equal(arc2.first_appeared_in_issue_id, null);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_storyarc_credit WHERE storyarc_id = 2").get().c, 0);

    // Idempotent: a re-run is a no-op (the columns are already dropped).
    v10.up(db, makeLog());
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_storyarc_credit WHERE storyarc_id = 1").get().c, 1);
    db.close();
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── v11 (SRV-6h) in isolation ───────────────────────────────────────────────

test("v11 (SRV-6h) normalizes object collections into cv_object_credit and drops the JSON columns", () => {
  const { dir, dbPath } = tempDb("srv6h.db");
  try {
    const conn = new DatabaseSync(dbPath);
    conn.exec(`
      CREATE TABLE cv_object (id INTEGER PRIMARY KEY, name TEXT, first_appeared_in_issue_id INTEGER, issue_credits TEXT, volume_credits TEXT, story_arc_credits TEXT, movies TEXT);
      CREATE TABLE cv_object_credit (object_id INTEGER NOT NULL, credit_type TEXT NOT NULL, position INTEGER NOT NULL, credit_id INTEGER, name TEXT, api_detail_url TEXT, site_detail_url TEXT, PRIMARY KEY (object_id, credit_type, position));
    `);
    const insert = conn.prepare("INSERT INTO cv_object (id, name, first_appeared_in_issue_id, issue_credits, volume_credits, story_arc_credits, movies) VALUES (?, ?, ?, ?, ?, ?, ?)");
    // Row 1: a populated object. One issue credit + one movie; volume/story_arc are [].
    insert.run(1, "Object 1", 4001,
      JSON.stringify([{ id: 10, name: "Issue A", api_detail_url: "https://comicvine.gamespot.com/api/issue/4000-10/", site_detail_url: "https://comicvine.gamespot.com/issue-a/" }]),
      "[]",
      "[]",
      JSON.stringify([{ id: 20, name: "Movie A", api_detail_url: "https://comicvine.gamespot.com/api/movie/4070-20/", site_detail_url: "https://comicvine.gamespot.com/movie-a/" }]));
    // Row 2: all four NULL (a Node-updater artifact) → no join rows.
    insert.run(2, "Object 2", null, null, null, null, null);
    // Row 3: all four [] → no join rows.
    insert.run(3, "Object 3", 4002, "[]", "[]", "[]", "[]");
    conn.close();

    const db = new DatabaseSync(dbPath);
    const v11 = MIGRATIONS.find((m) => m.version === 11);
    v11.up(db, makeLog());

    // The four JSON columns are dropped; first_appeared_in_issue_id is kept.
    const cols = columnNames(db, "cv_object");
    for (const c of ["issue_credits", "volume_credits", "story_arc_credits", "movies"]) {
      assert.ok(!cols.includes(c), `${c} should be dropped`);
    }
    assert.ok(cols.includes("first_appeared_in_issue_id"), "first_appeared_in_issue_id should be kept");

    // Row 1: one issue_credit + one movie join row (volume/story_arc were []).
    const rows1 = db.prepare("SELECT credit_type, credit_id, name, api_detail_url, site_detail_url FROM cv_object_credit WHERE object_id = 1 ORDER BY credit_type, position").all();
    assert.equal(rows1.length, 2);
    assert.deepEqual(rows1.map((r) => [r.credit_type, r.credit_id, r.name]), [["issue_credit", 10, "Issue A"], ["movie", 20, "Movie A"]]);
    assert.equal(rows1[0].api_detail_url, "https://comicvine.gamespot.com/api/issue/4000-10/");
    assert.equal(rows1[0].site_detail_url, "https://comicvine.gamespot.com/issue-a/");
    assert.equal(rows1[1].api_detail_url, "https://comicvine.gamespot.com/api/movie/4070-20/");
    assert.equal(rows1[1].site_detail_url, "https://comicvine.gamespot.com/movie-a/");
    // Row 2: no join rows (NULL collections).
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_object_credit WHERE object_id = 2").get().c, 0);
    // Row 3: no join rows ([] collections).
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_object_credit WHERE object_id = 3").get().c, 0);

    // Idempotent: a re-run is a no-op (the columns are already dropped).
    v11.up(db, makeLog());
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_object_credit WHERE object_id = 1").get().c, 2);
    db.close();
  } finally {
    cleanupTempDir(dir);
  }
});

// ─── v12 (SRV-6f) in isolation ───────────────────────────────────────────────

test("v12 (SRV-6f) normalizes issue collections into cv_issue_credit/cv_issue_image and drops the JSON columns", () => {
  const { dir, dbPath } = tempDb("srv6f.db");
  try {
    const conn = new DatabaseSync(dbPath);
    conn.exec(`
      CREATE TABLE cv_issue (id INTEGER PRIMARY KEY, name TEXT,
        character_credits TEXT, person_credits TEXT, team_credits TEXT, location_credits TEXT,
        story_arc_credits TEXT, associated_images TEXT, object_credits TEXT, concept_credits TEXT,
        character_died_in TEXT, team_disbanded_in TEXT,
        first_appearance_characters TEXT, first_appearance_concepts TEXT, first_appearance_locations TEXT,
        first_appearance_objects TEXT, first_appearance_storyarcs TEXT, first_appearance_teams TEXT);
      CREATE TABLE cv_issue_credit (issue_id INTEGER NOT NULL, credit_type TEXT NOT NULL, position INTEGER NOT NULL, credit_id INTEGER, name TEXT, role TEXT, api_detail_url TEXT, site_detail_url TEXT, PRIMARY KEY (issue_id, credit_type, position));
      CREATE TABLE cv_issue_image (issue_id INTEGER NOT NULL, position INTEGER NOT NULL, image_id INTEGER, caption TEXT, image_tags TEXT, original_url TEXT, PRIMARY KEY (issue_id, position));
    `);
    const cols = ["character_credits", "person_credits", "team_credits", "location_credits", "story_arc_credits", "associated_images", "object_credits", "concept_credits", "character_died_in", "team_disbanded_in", "first_appearance_characters", "first_appearance_concepts", "first_appearance_locations", "first_appearance_objects", "first_appearance_storyarcs", "first_appearance_teams"];
    const insert = conn.prepare(`INSERT INTO cv_issue (id, name, ${cols.join(", ")}) VALUES (?, ?, ${cols.map(() => "?").join(", ")})`);
    // Row 1: character + person credits populated (person carries a role),
    // associated_images populated; the four nullable collections are [] (bits
    // set); the six first_appearance_* are null (bits cleared). Mask = 15.
    insert.run(1, "Issue 1",
      JSON.stringify([{ id: 1, name: "Hero", api_detail_url: "https://comicvine.gamespot.com/api/character/4001-1/", site_detail_url: "https://comicvine.gamespot.com/hero/" }]),
      JSON.stringify([{ id: 2, name: "Jane", role: "Writer", api_detail_url: "https://comicvine.gamespot.com/api/person/4002-2/", site_detail_url: "https://comicvine.gamespot.com/jane/" }]),
      "[]", "[]", "[]",
      JSON.stringify([{ id: 3, caption: "A pic", image_tags: "tag", original_url: "https://comicvine.gamespot.com/img.png" }]),
      "[]", "[]", "[]", "[]",
      null, null, null, null, null, null);
    // Row 2: all sixteen null (the UPD-7 window) → mask 0, no join rows.
    insert.run(2, "Issue 2", ...cols.map(() => null));
    // Row 3: all sixteen [] → mask 1023 (all ten bits set), no join rows.
    insert.run(3, "Issue 3", ...cols.map(() => "[]"));
    conn.close();

    const db = new DatabaseSync(dbPath);
    const v12 = MIGRATIONS.find((m) => m.version === 12);
    v12.up(db, makeLog());

    // The sixteen JSON columns are dropped; credits_presence is added.
    const issueCols = columnNames(db, "cv_issue");
    for (const c of cols) {
      assert.ok(!issueCols.includes(c), `${c} should be dropped`);
    }
    assert.ok(issueCols.includes("credits_presence"), "credits_presence should be added");

    // Row 1: one character + one person credit (person carries the role) + one image.
    const credits1 = db.prepare("SELECT credit_type, credit_id, name, role FROM cv_issue_credit WHERE issue_id = 1 ORDER BY credit_type, position").all();
    assert.deepEqual(credits1.map((r) => [r.credit_type, r.credit_id, r.name, r.role]),
      [["character", 1, "Hero", null], ["person", 2, "Jane", "Writer"]]);
    const image1 = db.prepare("SELECT image_id, caption, image_tags, original_url FROM cv_issue_image WHERE issue_id = 1").get();
    assert.deepEqual([image1.image_id, image1.caption, image1.image_tags, image1.original_url], [3, "A pic", "tag", "https://comicvine.gamespot.com/img.png"]);
    // The four [] nullable collections set bits 0-3; the six null first_appearance_*
    // clear bits 4-9. So the mask is 15.
    assert.equal(db.prepare("SELECT credits_presence FROM cv_issue WHERE id = 1").get().credits_presence, 15);
    // Row 2: all null → mask 0, no join rows.
    assert.equal(db.prepare("SELECT credits_presence FROM cv_issue WHERE id = 2").get().credits_presence, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_issue_credit WHERE issue_id = 2").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_issue_image WHERE issue_id = 2").get().c, 0);
    // Row 3: all [] → mask 1023 (all ten bits set), no join rows.
    assert.equal(db.prepare("SELECT credits_presence FROM cv_issue WHERE id = 3").get().credits_presence, 1023);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_issue_credit WHERE issue_id = 3").get().c, 0);

    // Idempotent: a re-run is a no-op (the columns are already dropped).
    v12.up(db, makeLog());
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cv_issue_credit WHERE issue_id = 1").get().c, 2);
    db.close();
  } finally {
    cleanupTempDir(dir);
  }
});
