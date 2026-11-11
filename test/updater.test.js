"use strict";
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { ComicVineUpdater, confirmFullSync, jsonify } = require("../src/updater.js");

const directory = mkdtempSync(path.join(os.tmpdir(), "comicvine-upd-test-"));
const databasePath = path.join(directory, "test.db");

before(() => {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE cv_publisher (id INTEGER PRIMARY KEY, name TEXT, image_url TEXT, site_detail_url TEXT, aliases TEXT, api_detail_url TEXT, deck TEXT, description TEXT, date_added TEXT, date_last_updated TEXT, location_address TEXT, location_city TEXT, location_state TEXT, characters TEXT, story_arcs TEXT, teams TEXT, volumes TEXT);
    CREATE TABLE cv_person (id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, api_detail_url TEXT, birth TEXT, country TEXT, death TEXT, gender TEXT, hometown TEXT, email TEXT, website TEXT, image_url TEXT, deck TEXT, description TEXT, date_added TEXT, date_last_updated TEXT, created_characters TEXT, issue_credits TEXT, story_arc_credits TEXT, volume_credits TEXT, site_detail_url TEXT, count_of_issue_appearances INTEGER);
    CREATE TABLE cv_volume (id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, start_year TEXT, publisher_id INTEGER, count_of_issues INTEGER, description TEXT, image_url TEXT, site_detail_url TEXT, api_detail_url TEXT, deck TEXT, date_added TEXT, date_last_updated TEXT, character_credits TEXT, concept_credits TEXT, location_credits TEXT, object_credits TEXT, person_credits TEXT, team_credits TEXT, first_issue TEXT, last_issue TEXT);
    CREATE TABLE cv_issue (id INTEGER PRIMARY KEY, volume_id INTEGER, name TEXT, issue_number TEXT, cover_date TEXT, store_date TEXT, description TEXT, image_url TEXT, site_detail_url TEXT, character_credits TEXT, person_credits TEXT, team_credits TEXT, location_credits TEXT, story_arc_credits TEXT, associated_images TEXT, aliases TEXT, api_detail_url TEXT, deck TEXT, date_added TEXT, date_last_updated TEXT, object_credits TEXT, concept_credits TEXT, character_died_in TEXT, team_disbanded_in TEXT, first_appearance_characters TEXT, first_appearance_concepts TEXT, first_appearance_locations TEXT, first_appearance_objects TEXT, first_appearance_storyarcs TEXT, first_appearance_teams TEXT, has_staff_review INTEGER);
    CREATE TABLE cv_team (id INTEGER PRIMARY KEY, name TEXT, publisher TEXT, aliases TEXT, count_of_team_members INTEGER, count_of_issue_appearances INTEGER, deck TEXT, description TEXT, date_added TEXT, date_last_updated TEXT, image_url TEXT, site_detail_url TEXT, first_appeared_in_issue TEXT, character_enemies TEXT, character_friends TEXT, characters TEXT, disbanded_in_issues TEXT, issue_credits TEXT, issues_disbanded_in TEXT, movies TEXT, story_arc_credits TEXT, volume_credits TEXT);
    CREATE TABLE cv_storyarc (id INTEGER PRIMARY KEY, name TEXT, publisher TEXT, aliases TEXT, count_of_issue_appearances INTEGER, deck TEXT, description TEXT, date_added TEXT, date_last_updated TEXT, image_url TEXT, site_detail_url TEXT, first_appeared_in_issue TEXT, issues TEXT, movies TEXT);
    CREATE TABLE cv_concept (id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, api_detail_url TEXT, deck TEXT, description TEXT, date_added TEXT, date_last_updated TEXT, image_url TEXT, site_detail_url TEXT, first_appeared_in_issue TEXT, count_of_issue_appearances INTEGER, start_year TEXT);
    CREATE TABLE cv_sync_metadata (endpoint TEXT PRIMARY KEY, last_sync_date TEXT NOT NULL, last_sync_timestamp TEXT NOT NULL, resume_state TEXT);
  `);
  db.close();
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

// ─── jsonify ─────────────────────────────────────────────────────────────────

test("jsonify serializes objects and arrays to JSON text", () => {
  assert.equal(jsonify({ a: 1 }), '{"a":1}');
  assert.equal(jsonify([{ id: 1 }]), '[{"id":1}]');
});

test("jsonify coerces booleans to 1/0 (node:sqlite rejects booleans)", () => {
  assert.equal(jsonify(true), 1);
  assert.equal(jsonify(false), 0);
});

test("jsonify passes through null, strings, and numbers", () => {
  assert.equal(jsonify(null), null);
  assert.equal(jsonify("text"), "text");
  assert.equal(jsonify(42), 42);
});

// ─── ComicVineUpdater: sync with mock fetch ─────────────────────────────────

function makeMockFetch() {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const ep = u.pathname;
    const offset = parseInt(u.searchParams.get("offset") || "0", 10);
    let results = [];
    if (ep.includes("/publishers/")) {
      if (offset === 0) {
        results = [{
          id: 100, name: "Acme Comics", aliases: "Acme",
          api_detail_url: "https://example.com/p/100",
          image: { original_url: "https://example.com/img.png" },
          site_detail_url: "https://example.com/site/100",
          deck: "A deck", description: "A description",
          date_added: "2020-01-01 00:00:00", date_last_updated: "2026-01-01 00:00:00",
          location_address: "123 Main St", location_city: "NYC", location_state: "NY"
        }];
      }
    } else if (ep.includes("/people/")) {
      if (offset === 0) {
        results = [{
          id: 200, name: "Jane Doe", aliases: "JD",
          api_detail_url: "https://example.com/p/200",
          birth: "1980-05-15", country: "USA", death: null,
          gender: "Female", hometown: "NYC", email: "jane@example.com",
          website: "https://jane.example.com",
          image: { original_url: "https://example.com/jane.png" },
          site_detail_url: "https://example.com/site/200",
          count_of_isssue_appearances: 5,
          deck: "Writer", description: "A writer",
          date_added: "2020-01-01 00:00:00", date_last_updated: "2026-01-01 00:00:00"
        }];
      }
    } else if (ep.includes("/volumes/")) {
      if (offset === 0) {
        results = [{
          id: 300, name: "Test Series", aliases: "TS",
          start_year: "2000", publisher: { id: 100, name: "Acme Comics" },
          count_of_issues: 10, description: "A series",
          image: { original_url: "https://example.com/vol.png" },
          site_detail_url: "https://example.com/site/300",
          api_detail_url: "https://example.com/v/300",
          deck: "A deck", date_added: "2020-01-01 00:00:00",
          date_last_updated: "2026-01-01 00:00:00",
          first_issue: { id: 4001, name: "Test Series #1" },
          last_issue: { id: 4010, name: "Test Series #10" }
        }];
      }
    } else if (ep.includes("/issues/")) {
      if (offset === 0) results = [{ id: 4001 }, { id: 4002 }];
      return { status: 200, ok: true, json: async () => ({ status_code: 1, results, number_of_total_results: results.length }) };
    } else if (ep.match(/\/issue\/4000-\d+\//)) {
      const iid = parseInt(ep.match(/4000-(\d+)/)[1], 10);
      const issue = {
        id: 4000 + iid, volume: { id: 300, name: "Test Series" },
        name: `Test Series #${iid}`, issue_number: String(iid),
        cover_date: "2026-01-01", store_date: "2026-01-05",
        description: "An issue", image: { original_url: "https://example.com/i.png" },
        site_detail_url: "https://example.com/site/issue",
        character_credits: [{ id: 1, name: "Hero", role: "Appearances" }],
        person_credits: [{ id: 200, name: "Jane Doe", role: "Writer" }],
        team_credits: [], location_credits: [], story_arc_credits: [],
        associated_images: [], aliases: null,
        api_detail_url: "https://example.com/i",
        deck: "A deck", date_added: "2020-01-01 00:00:00",
        date_last_updated: "2026-01-01 00:00:00",
        object_credits: [], concept_credits: [], character_died_in: [],
        team_disbanded_in: [], first_appearance_characters: [],
        first_appearance_concepts: [], first_appearance_locations: [],
        first_appearance_objects: [], first_appearance_storyarcs: [],
        first_appearance_teams: [], has_staff_review: false
      };
      return { status: 200, ok: true, json: async () => ({ status_code: 1, results: issue }) };
    } else if (ep.includes("/teams/")) {
      if (offset === 0) {
        results = [{
          id: 500, name: "Test Team", publisher: { id: 100, name: "Acme Comics" },
          aliases: "TT", count_of_team_members: 3, count_of_isssue_appearances: 7,
          deck: "A team", description: "A team desc",
          date_added: "2020-01-01 00:00:00", date_last_updated: "2026-01-01 00:00:00",
          image: { original_url: "https://example.com/team.png" },
          site_detail_url: "https://example.com/site/500",
          first_appeared_in_issue: { id: 4001, name: "Test Series #1" }
        }];
      }
    } else if (ep.includes("/story_arcs/")) {
      if (offset === 0) {
        results = [{
          id: 600, name: "Test Arc", publisher: { id: 100, name: "Acme Comics" },
          aliases: "TA", count_of_isssue_appearances: 4,
          deck: "An arc", description: "An arc desc",
          date_added: "2020-01-01 00:00:00", date_last_updated: "2026-01-01 00:00:00",
          image: { original_url: "https://example.com/arc.png" },
          site_detail_url: "https://example.com/site/600",
          first_appeared_in_issue: { id: 4001, name: "Test Series #1" }
        }];
      }
    } else if (ep.includes("/concepts/")) {
      if (offset === 0) {
        results = [{
          id: 700, name: "Test Concept", aliases: "TC",
          api_detail_url: "https://example.com/c/700",
          count_of_isssue_appearances: 9,
          deck: "A concept", description: "A concept desc",
          date_added: "2020-01-01 00:00:00", date_last_updated: "2026-01-01 00:00:00",
          image: { original_url: "https://example.com/concept.png" },
          site_detail_url: "https://example.com/site/700",
          first_appeared_in_issue: { id: 4001, name: "Test Series #1" },
          start_year: "2005"
        }];
      }
    }
    return { status: 200, ok: true, json: async () => ({ status_code: 1, results, number_of_total_results: results.length }) };
  };
  return { fn, calls };
}

test("sync publishes, persons, volumes, issues, teams, and storyarcs via mock fetch", async () => {
  const { fn, calls } = makeMockFetch();
  const updater = new ComicVineUpdater(databasePath, "test-key", { verbose: false, full: false, fetchFn: fn, apiDelayMs: 0 });
  assert.ok(updater.connect());
  await updater.runSync("2026-01-01");
  updater.close();

  const db = new DatabaseSync(databasePath);

  // Publisher
  const pub = db.prepare("SELECT * FROM cv_publisher WHERE id=100").get();
  assert.equal(pub.name, "Acme Comics");
  assert.equal(pub.aliases, "Acme");
  assert.equal(pub.characters, "[]");
  assert.equal(pub.volumes, "[]");
  assert.equal(pub.location_city, "NYC");

  // Person
  const person = db.prepare("SELECT * FROM cv_person WHERE id=200").get();
  assert.equal(person.name, "Jane Doe");
  assert.equal(person.count_of_issue_appearances, 5);
  assert.equal(person.gender, "Female");

  // Volume
  const vol = db.prepare("SELECT * FROM cv_volume WHERE id=300").get();
  assert.equal(vol.publisher_id, 100);
  assert.equal(vol.name, "Test Series");
  // SRV-6c: first/last issue live in the join table, not the (dropped) JSON
  // columns. The ref row stores only the issue id + key order (display fields
  // are resolved from cv_issue on read), so it has no name/issue_number columns.
  const firstRef = db.prepare("SELECT * FROM cv_volume_issue_ref WHERE volume_id=300 AND ref_type='first'").get();
  assert.equal(firstRef.issue_id, 4001);
  const lastRef = db.prepare("SELECT * FROM cv_volume_issue_ref WHERE volume_id=300 AND ref_type='last'").get();
  assert.equal(lastRef.issue_id, 4010);

  // Issues (2 fetched via detail endpoint)
  const issues = db.prepare("SELECT * FROM cv_issue ORDER BY id").all();
  assert.equal(issues.length, 2);
  assert.equal(issues[0].volume_id, 300);
  assert.equal(issues[0].has_staff_review, 0);
  const credits = JSON.parse(issues[0].character_credits);
  assert.equal(credits[0].name, "Hero");

  // Team
  const team = db.prepare("SELECT * FROM cv_team WHERE id=500").get();
  assert.equal(team.name, "Test Team");
  assert.equal(team.count_of_issue_appearances, 7);
  const firstAppeared = JSON.parse(team.first_appeared_in_issue);
  assert.equal(firstAppeared.id, 4001);

  // Story arc
  const arc = db.prepare("SELECT * FROM cv_storyarc WHERE id=600").get();
  assert.equal(arc.name, "Test Arc");

  // Concept
  const concept = db.prepare("SELECT * FROM cv_concept WHERE id=700").get();
  assert.equal(concept.name, "Test Concept");
  assert.equal(concept.aliases, "TC");
  assert.equal(concept.count_of_issue_appearances, 9);
  assert.equal(concept.start_year, "2005");
  assert.equal(concept.image_url, "https://example.com/concept.png");
  const conceptFirstAppeared = JSON.parse(concept.first_appeared_in_issue);
  assert.equal(conceptFirstAppeared.id, 4001);

  // Metadata
  const meta = db.prepare("SELECT * FROM cv_sync_metadata WHERE endpoint='publishers'").get();
  assert.ok(meta);
  assert.ok(meta.last_sync_date);
  const conceptMeta = db.prepare("SELECT * FROM cv_sync_metadata WHERE endpoint='concepts'").get();
  assert.ok(conceptMeta);
  assert.ok(conceptMeta.last_sync_date);

  // SRV-5: runSync creates an FTS5 trigram index for each resource table and
  // rebuilds it after the sync, so the indexes are populated with the new rows.
  const ftsTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts' ORDER BY name").all().map((r) => r.name);
  assert.ok(ftsTables.includes("cv_volume_fts"), `expected cv_volume_fts, got ${ftsTables.join(", ")}`);
  assert.ok(ftsTables.includes("cv_issue_fts"));
  assert.ok(ftsTables.includes("cv_concept_fts"), `expected cv_concept_fts, got ${ftsTables.join(", ")}`);
  const ftsRows = db.prepare("SELECT COUNT(*) AS c FROM cv_volume_fts").get().c;
  assert.ok(ftsRows >= 1, `expected cv_volume_fts to be populated, got ${ftsRows}`);
  const conceptFtsRows = db.prepare("SELECT COUNT(*) AS c FROM cv_concept_fts").get().c;
  assert.ok(conceptFtsRows >= 1, `expected cv_concept_fts to be populated, got ${conceptFtsRows}`);

  db.close();
  assert.ok(calls.length > 0, "API calls were made");
});

test("rate limit 107 triggers retry and eventual success", async () => {
  let attempt = 0;
  const fetchFn = async (url) => {
    attempt++;
    if (attempt === 1) {
      return { status: 200, ok: true, json: async () => ({ status_code: 107, error: "Rate limit exceeded" }) };
    }
    const u = new URL(url);
    if (u.pathname.includes("/publishers/")) {
      return { status: 200, ok: true, json: async () => ({ status_code: 1, results: [], number_of_total_results: 0 }) };
    }
    return { status: 200, ok: true, json: async () => ({ status_code: 1, results: [], number_of_total_results: 0 }) };
  };
  const updater = new ComicVineUpdater(databasePath, "test-key", {
    verbose: false, full: false, fetchFn, apiDelayMs: 0, rateLimitBackoffMs: 0
  });
  assert.ok(updater.connect());
  try {
    await updater.syncPublishers("2026-01-01", "2026-01-02", false);
  } finally {
    updater.close();
  }
  assert.equal(attempt, 2, "should have retried after 107");
});

test("invalid API key (100) aborts immediately without retry", async () => {
  let attempt = 0;
  const fetchFn = async () => {
    attempt++;
    return { status: 200, ok: true, json: async () => ({ status_code: 100, error: "Invalid API key" }) };
  };
  const updater = new ComicVineUpdater(databasePath, "bad-key", { verbose: false, full: false, fetchFn, apiDelayMs: 0 });
  assert.ok(updater.connect());
  try {
    await assert.rejects(
      updater.syncPublishers("2026-01-01", "2026-01-02", false),
      /API call failed/
    );
  } finally {
    updater.close();
  }
  assert.equal(attempt, 1, "should NOT retry on invalid key");
});

test("full sync omits date filter", async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    const u = new URL(url);
    if (u.pathname.includes("/publishers/")) {
      return { status: 200, ok: true, json: async () => ({ status_code: 1, results: [], number_of_total_results: 0 }) };
    }
    return { status: 200, ok: true, json: async () => ({ status_code: 1, results: [], number_of_total_results: 0 }) };
  };
  const updater = new ComicVineUpdater(databasePath, "test-key", { verbose: false, full: true, fetchFn, apiDelayMs: 0 });
  assert.ok(updater.connect());
  await updater.syncPublishers("2026-01-01", "2026-01-02", true);
  updater.close();
  const u = new URL(urls[0]);
  assert.equal(u.searchParams.get("filter"), null, "full sync should not include a date filter");
});

test("incremental sync includes date filter", async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    const u = new URL(url);
    if (u.pathname.includes("/publishers/")) {
      return { status: 200, ok: true, json: async () => ({ status_code: 1, results: [], number_of_total_results: 0 }) };
    }
    return { status: 200, ok: true, json: async () => ({ status_code: 1, results: [], number_of_total_results: 0 }) };
  };
  const updater = new ComicVineUpdater(databasePath, "test-key", { verbose: false, full: false, fetchFn, apiDelayMs: 0 });
  assert.ok(updater.connect());
  await updater.syncPublishers("2026-01-01", "2026-01-02", false);
  updater.close();
  const u = new URL(urls[0]);
  assert.equal(u.searchParams.get("filter"), "date_last_updated:2026-01-01|2026-01-02");
});

// ─── confirmFullSync (UPD-2) ────────────────────────────────────────────────

test("confirmFullSync returns true when --yes is passed without prompting", async () => {
  assert.equal(await confirmFullSync({ interactive: false, yes: true }), true);
});

test("confirmFullSync refuses a non-interactive full sync without --yes", async () => {
  assert.equal(await confirmFullSync({ interactive: false, yes: false }), false);
});

// ─── FK auto-recovery (UPD-4) ───────────────────────────────────────────────
// A dedicated DB with the production cv_issue→cv_volume FK and
// PRAGMA foreign_keys=ON (set by connect()) so a missing volume actually
// triggers FOREIGN KEY constraint failed. The shared test DB above has no
// FKs, so it cannot exercise the recovery path.

function makeFkDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "comicvine-upd-fk-test-"));
  const dbPath = path.join(dir, "fk.db");
  const db = new DatabaseSync(dbPath);
  // Full cv_volume / cv_issue column sets (so the 13/32-column upserts work),
  // plus the production cv_issue→cv_volume FK and the SRV-6c join table.
  db.exec(`
    CREATE TABLE cv_volume (id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, start_year TEXT, publisher_id INTEGER, count_of_issues INTEGER, description TEXT, image_url TEXT, site_detail_url TEXT, api_detail_url TEXT, deck TEXT, date_added TEXT, date_last_updated TEXT);
    CREATE TABLE cv_issue (id INTEGER PRIMARY KEY, volume_id INTEGER REFERENCES cv_volume(id), name TEXT, issue_number TEXT, cover_date TEXT, store_date TEXT, description TEXT, image_url TEXT, site_detail_url TEXT, character_credits TEXT, person_credits TEXT, team_credits TEXT, location_credits TEXT, story_arc_credits TEXT, associated_images TEXT, aliases TEXT, api_detail_url TEXT, deck TEXT, date_added TEXT, date_last_updated TEXT, object_credits TEXT, concept_credits TEXT, character_died_in TEXT, team_disbanded_in TEXT, first_appearance_characters TEXT, first_appearance_concepts TEXT, first_appearance_locations TEXT, first_appearance_objects TEXT, first_appearance_storyarcs TEXT, first_appearance_teams TEXT, has_staff_review INTEGER);
    CREATE TABLE cv_volume_issue_ref (volume_id INTEGER NOT NULL, ref_type TEXT NOT NULL, issue_id INTEGER, key_order TEXT, PRIMARY KEY (volume_id, ref_type));
    CREATE TABLE cv_sync_metadata (endpoint TEXT PRIMARY KEY, last_sync_date TEXT NOT NULL, last_sync_timestamp TEXT NOT NULL, resume_state TEXT);
    CREATE TABLE sync_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, action TEXT, error TEXT, row_data TEXT, created_at TEXT);
  `);
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

test("issue FK failure triggers volume backfill, then retry succeeds", async () => {
  const { dir, dbPath } = makeFkDb();
  try {
    // Volume 5000 is intentionally NOT in the DB. The issue references it.
    const fetchFn = async (url) => {
      const u = new URL(url);
      if (u.pathname.match(/\/volume\/4050-5000\//)) {
        return { status: 200, ok: true, json: async () => ({ status_code: 1, results: { id: 5000, name: "Late Series", publisher: { id: 1 } } }) };
      }
      return { status: 200, ok: true, json: async () => ({ status_code: 1, results: [] }) };
    };
    const updater = new ComicVineUpdater(dbPath, "test-key", { verbose: false, full: false, fetchFn, apiDelayMs: 0 });
    assert.ok(updater.connect());

    const issue = { id: 5001, volume: { id: 5000, name: "Late Series" }, name: "Late Series #1", issue_number: "1" };

    // 1) First upsert fails on the FK (volume 5000 missing).
    assert.equal(updater.upsertIssue(5001, issue, 5000), false);
    assert.equal(updater.conn.prepare("SELECT id FROM cv_issue WHERE id=5001").get(), undefined);

    // 2) syncIssues recovery: the volume is missing locally, so fetch it.
    const volData = await updater.fetchVolumeDetails(5000);
    assert.ok(volData);
    assert.equal(updater.upsertVolume(volData), true);
    assert.ok(updater.conn.prepare("SELECT id FROM cv_volume WHERE id=5000").get());

    // 3) Retry the issue upsert — now the volume exists, so it succeeds.
    assert.equal(updater.upsertIssue(5001, issue, 5000), true);
    assert.ok(updater.conn.prepare("SELECT id FROM cv_issue WHERE id=5001").get());

    updater.close();
  } finally {
    cleanupTempDir(dir);
  }
});

test("issue FK failure with unfetchable volume is skipped, not fatal", async () => {
  const { dir, dbPath } = makeFkDb();
  try {
    // fetchVolumeDetails returns null (API rate-limited) → recovery gives up,
    // upsertIssue stays false. 107 with 0 backoff → fast null (no 5s sleeps).
    const fetchFn = async () => ({ status: 200, ok: true, json: async () => ({ status_code: 107, results: null }) });
    const updater = new ComicVineUpdater(dbPath, "test-key", { verbose: false, full: false, fetchFn, apiDelayMs: 0, rateLimitBackoffMs: 0, http420BackoffMs: 0 });
    assert.ok(updater.connect());

    const issue = { id: 5002, volume: { id: 5000 }, name: "Orphan #1", issue_number: "1" };
    assert.equal(updater.upsertIssue(5002, issue, 5000), false);

    const volData = await updater.fetchVolumeDetails(5000);
    assert.equal(volData, null);
    // Volume never added, issue never added — syncIssues would `continue` (skip).
    assert.equal(updater.conn.prepare("SELECT id FROM cv_volume WHERE id=5000").get(), undefined);
    assert.equal(updater.conn.prepare("SELECT id FROM cv_issue WHERE id=5002").get(), undefined);

    updater.close();
  } finally {
    cleanupTempDir(dir);
  }
});
