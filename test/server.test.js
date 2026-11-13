const assert = require("node:assert/strict");
const fs = require("node:fs");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createApiServer, parseBoolFlag } = require("../src/server");
const { buildLiveUrl, DOMAIN_PREFIXES } = require("../src/validate");
const { buildApiDetailUrl } = require("../src/fieldConfig");

const directory = mkdtempSync(path.join(os.tmpdir(), "comicvine-api-test-"));
const databasePath = path.join(directory, "test.db");
const database = new DatabaseSync(databasePath);
const J = (value) => JSON.stringify(value);
database.exec("CREATE TABLE cv_publisher (id INTEGER PRIMARY KEY, name TEXT, image_url TEXT, site_detail_url TEXT, aliases TEXT, date_added TEXT, location_address TEXT, location_city TEXT, location_state TEXT, characters TEXT, story_arcs TEXT, teams TEXT, volumes TEXT)");
database.exec("CREATE TABLE cv_volume (id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, start_year TEXT, publisher_id INTEGER, count_of_issues INTEGER, description TEXT, image_url TEXT, site_detail_url TEXT, character_credits TEXT, team_credits TEXT, date_added TEXT, date_last_updated TEXT, deck TEXT)");
database.exec("CREATE TABLE cv_issue (id INTEGER PRIMARY KEY, volume_id INTEGER, name TEXT, issue_number TEXT, cover_date TEXT, store_date TEXT, description TEXT, image_url TEXT, site_detail_url TEXT, character_credits TEXT, person_credits TEXT, team_credits TEXT, location_credits TEXT, story_arc_credits TEXT, associated_images TEXT)");
database.exec("CREATE TABLE cv_team (id INTEGER PRIMARY KEY, name TEXT, publisher TEXT, aliases TEXT, count_of_team_members INTEGER, count_of_issue_appearances INTEGER, deck TEXT, description TEXT, date_added TEXT, date_last_updated TEXT, image_url TEXT, site_detail_url TEXT, first_appeared_in_issue TEXT, character_enemies TEXT, character_friends TEXT, characters TEXT, disbanded_in_issues TEXT, issue_credits TEXT, issues_disbanded_in TEXT, movies TEXT, story_arc_credits TEXT, volume_credits TEXT)");
database.exec("CREATE TABLE cv_storyarc (id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, count_of_issue_appearances INTEGER, date_added TEXT, first_appeared_in_issue TEXT, publisher TEXT, site_detail_url TEXT, issues TEXT, movies TEXT)");
database.exec("CREATE TABLE cv_person (id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, api_detail_url TEXT, birth TEXT, count_of_issue_appearances INTEGER, country TEXT, date_added TEXT, date_last_updated TEXT, death TEXT, gender TEXT, hometown TEXT, email TEXT, website TEXT, image_url TEXT, created_characters TEXT, issue_credits TEXT, story_arc_credits TEXT, volume_credits TEXT, site_detail_url TEXT)");
// UPD-13: no api_detail_url column — the server derives it from the id (like team).
database.exec("CREATE TABLE cv_concept (id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, deck TEXT, description TEXT, date_added TEXT, date_last_updated TEXT, image_url TEXT, site_detail_url TEXT, first_appeared_in_issue TEXT, count_of_issue_appearances INTEGER, start_year TEXT)");
database.prepare("INSERT INTO cv_publisher (id, name, site_detail_url, aliases, date_added, location_address, location_city, location_state, characters, story_arcs, teams, volumes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(4, "Dell", "https://example.test/dell/", "Dell Comics", "2020-04-15 10:00:00", "750 Third Avenue", "New York", "NY", J([{ id: 17, name: "Daredevil" }]), J([]), J([]), J([]));
database.prepare("INSERT INTO cv_publisher (id, name, site_detail_url, aliases, date_added) VALUES (?, ?, ?, ?, ?)")
    .run(5, "DC Comics", "https://example.test/dc/", null, "1899-01-01 00:00:00");
database.prepare("INSERT INTO cv_volume (id, name, aliases, start_year, publisher_id, count_of_issues, description, image_url, site_detail_url, character_credits, team_credits, date_added, date_last_updated, deck) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(7300, "Witchblade", "Witchblade (1995)", "1995", null, 185, null, null, "https://example.test/witchblade/", J([{ id: 1, name: "Sara Pezzini" }]), J([{ id: 2, name: "Witchblade Team" }]), "2020-04-15 10:00:00", null, "A supernatural series.");
database.prepare("INSERT INTO cv_volume (id, name, date_added) VALUES (?, ?, ?)")
    .run(7301, "Dune", "1899-01-01 00:00:00");
database.prepare("INSERT INTO cv_issue (id, volume_id, name, issue_number, description, image_url) VALUES (?, ?, ?, ?, ?, ?)")
    .run(42, null, "The Test Issue", "1", "", "https://example.test/issue.jpg");
database.prepare("INSERT INTO cv_issue (id, name) VALUES (?, ?)")
    .run(43, "Another Issue");
database.prepare("INSERT INTO cv_team (id, name, publisher, aliases, count_of_team_members, count_of_issue_appearances, deck, description, date_added, date_last_updated, image_url, site_detail_url, first_appeared_in_issue, character_enemies, character_friends, characters, disbanded_in_issues, issue_credits, issues_disbanded_in, movies, story_arc_credits, volume_credits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .    run(1800, "The Hand", J({ id: 31, name: "Marvel" }), "The Hand (Marvel)", 93, 180, "A secret organization of assassins", "The Hand is a secret organization of assassins that operates in the shadows.", "2020-04-15 10:00:00", "2021-05-01 08:30:00", "https://example.test/the-hand.jpg", "https://example.test/the-hand/", J({ id: 20965, name: "Elektra", issue_number: "168" }), J([]), J([]), J([]), J([]), J([]), J([]), J([]), J([]), J([]));
database.prepare("INSERT INTO cv_team (id, name, date_added) VALUES (?, ?, ?)")
    .run(1801, "Avengers", "1899-01-01 00:00:00");
database.prepare("INSERT INTO cv_storyarc (id, name, aliases, count_of_issue_appearances, date_added, first_appeared_in_issue, publisher, site_detail_url, issues, movies) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(3000, "Secret Wars", "Secret Wars (1984)", 12, "2020-04-15 10:00:00", J({ id: 12345, name: "Marvel Super Heroes Secret Wars", issue_number: "1" }), J({ id: 31, name: "Marvel" }), "https://example.test/secret-wars/", J([{ id: 12345, name: "Marvel Super Heroes Secret Wars", issue_number: "1" }]), J([]));
database.prepare("INSERT INTO cv_storyarc (id, name, date_added) VALUES (?, ?, ?)")
    .run(3001, "Civil War", "1899-01-01 00:00:00");
database.prepare("INSERT INTO cv_person (id, name, aliases, api_detail_url, birth, count_of_issue_appearances, country, date_added, date_last_updated, death, gender, hometown, email, website, image_url, created_characters, issue_credits, story_arc_credits, volume_credits, site_detail_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(1251, "Barry Kitson", "Barry Kitson (artist)", "https://comicvine.gamespot.com/api/person/4040-1251/", null, 180, "United Kingdom", "2020-04-15 10:00:00", "2021-05-01 08:30:00", null, "1", "Leicester", "barry@example.test", "https://example.test/barry", "https://example.test/barry.jpg", J([{ id: 9081, name: "The Amazing Bug" }]), J([]), J([]), J([{ id: 120, name: "Sample Volume" }]), "https://example.test/barry-kitson/");
database.prepare("INSERT INTO cv_person (id, name, date_added) VALUES (?, ?, ?)")
    .run(1252, "Alex Ross", "1899-01-01 00:00:00");
database.prepare("INSERT INTO cv_concept (id, name, aliases, deck, description, date_added, date_last_updated, image_url, site_detail_url, first_appeared_in_issue, count_of_issue_appearances, start_year) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(58852, "Digital Comic", "DC", "A digital comic", "A digital comic description", "2020-01-01 00:00:00", "2026-01-01 00:00:00", "https://example.test/digital-comic.jpg", "https://example.test/digital-comic/", J({ id: 4001, name: "Test Series #1" }), 9, "2005");
// SRV-26: a second concept with a NULL first_appeared_in_issue (the live API
// emits null, not an absent key) to exercise the null coalesce in buildResult.
database.prepare("INSERT INTO cv_concept (id, name, first_appeared_in_issue, count_of_issue_appearances) VALUES (?, ?, ?, ?)")
    .run(58853, "Test Concept Null", null, 3);
database.close();

const requestLogs = [];
const server = createApiServer(databasePath, (entry) => requestLogs.push(entry));
let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});

test("serves ComicVine-shaped list, filtered, and detail responses", async () => {
  const list = await fetch(`${baseUrl}/api/issues/?limit=1&offset=1`);
  const listBody = await list.json();
  assert.equal(list.status, 200);
  assert.equal(listBody.number_of_total_results, 2);
  assert.equal(listBody.results[0].id, 43);
  assert.equal(listBody.results[0].description, null);
  assert.equal(listBody.results[0].image, null);

  const filtered = await fetch(`${baseUrl}/api/issues/?filter=name:Test`);
  const filteredBody = await filtered.json();
  assert.equal(filteredBody.number_of_total_results, 1);
  assert.equal(filteredBody.results[0].id, 42);

  const detail = await fetch(`${baseUrl}/api/issue/4000-42/`);
  const detailBody = await detail.json();
  assert.equal(detail.status, 200);
  assert.equal(detailBody.results.name, "The Test Issue");
  assert.equal(detailBody.results.description, "");
  assert.equal(detailBody.results.image.original_url, "https://example.test/issue.jpg");
  assert.equal(detailBody.results.image.image_tags, "All Images");

  const projectedDetail = await fetch(`${baseUrl}/api/issue/4000-42/?field_list=id,name,issue_number`);
  const projectedDetailBody = await projectedDetail.json();
  assert.deepEqual(Object.keys(projectedDetailBody.results).sort(), ["id", "issue_number", "name"]);

  const projectedList = await fetch(`${baseUrl}/api/issues/?field_list=id,name`);
  const projectedListBody = await projectedList.json();
  for (const item of projectedListBody.results) {
    assert.deepEqual(Object.keys(item).sort(), ["id", "name"]);
  }

  const search = await fetch(`${baseUrl}/api/search/?query=Test%20Issue&resources=issue&field_list=id,description,image`);
  const searchBody = await search.json();
  assert.equal(searchBody.results[0].description, "");
  assert.equal(searchBody.results[0].image.original_url, "https://example.test/issue.jpg");

  const nonNameSearch = await fetch(`${baseUrl}/api/search/?query=Moonbeam%20Marker&resources=issue`);
  const nonNameBody = await nonNameSearch.json();
  assert.equal(nonNameBody.number_of_total_results, 0);
});

test("searches a requested resource and projects field_list results", async () => {
  const params = new URLSearchParams({
    format: "json",
    api_key: "mock-key",
    query: "witchblade",
    resources: "volume",
    limit: "50",
    field_list: "aliases,count_of_issues,deck,description,id,image,name,publisher,site_detail_url"
  });
  const response = await fetch(`${baseUrl}/api/search/?${params}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.error, "OK");
  assert.equal(body.number_of_total_results, 1);
  assert.equal(body.results[0].id, 7300);
  assert.equal(body.results[0].resource_type, "volume");
  assert.equal(body.results[0].name, "Witchblade");
  assert.equal(body.results[0].description, null);
  assert.equal(body.results[0].image, null);
  assert.equal(body.results[0].issue_number, undefined);
});

test("search supports the documented formats, default limit, and all resource options", async () => {
  const defaultResponse = await fetch(`${baseUrl}/api/search/?api_key=ignored&subscriber_only=false&query=witchblade&resources=volume`);
  const defaultBody = await defaultResponse.json();
  assert.equal(defaultBody.limit, 10);
  assert.equal(defaultBody.results[0].resource_type, "volume");

  const xml = await fetch(`${baseUrl}/api/search/?query=witchblade&resources=volume&format=xml&field_list=id,name,resource_type`);
  assert.match(xml.headers.get("content-type"), /application\/xml/);
  const xmlBody = await xml.text();
  assert.match(xmlBody, /<resource_type>volume<\/resource_type>/);

  const jsonp = await fetch(`${baseUrl}/api/search/?query=anything&resources=origin,video&format=jsonp&callback=ComicVine.search`);
  const jsonpBody = await jsonp.text();
  assert.match(jsonpBody, /^ComicVine\.search\(/);
  const jsonpResult = JSON.parse(jsonpBody.slice("ComicVine.search(".length, -2));
  assert.equal(jsonpResult.number_of_total_results, 0);
});

test("searches and filters text fields against the FTS trigram index", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "comicvine-fts-test-"));
  const ftsDatabasePath = path.join(directory, "fts.db");
  const ftsDatabase = new DatabaseSync(ftsDatabasePath);
  ftsDatabase.exec("CREATE TABLE cv_publisher (id INTEGER PRIMARY KEY, name TEXT, image_url TEXT, site_detail_url TEXT, aliases TEXT, deck TEXT, description TEXT)");
  ftsDatabase.exec("CREATE TABLE cv_volume (id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, deck TEXT, description TEXT, start_year TEXT, publisher_id INTEGER, count_of_issues INTEGER, image_url TEXT, site_detail_url TEXT, api_detail_url TEXT, date_added TEXT, date_last_updated TEXT)");
  ftsDatabase.exec("CREATE TABLE cv_issue (id INTEGER PRIMARY KEY, volume_id INTEGER, name TEXT, issue_number TEXT, cover_date TEXT, store_date TEXT, description TEXT, image_url TEXT, site_detail_url TEXT)");
  ftsDatabase.prepare("INSERT INTO cv_volume (id, name, aliases, deck, description, start_year, count_of_issues) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(1, "Witchblade", "Witchblade (1995)", "A supernatural series", "long description", "1995", 185);
  ftsDatabase.prepare("INSERT INTO cv_volume (id, name, deck, description) VALUES (?, ?, ?, ?)")
      .run(2, "Dune", "deck with batman", "desc");
  ftsDatabase.prepare("INSERT INTO cv_issue (id, volume_id, name, issue_number, description) VALUES (?, ?, ?, ?, ?)")
      .run(10, 1, "The Test Issue", "1", "");
  // SRV-5: the trigram FTS indexes the server detects and uses for search/filter.
  ftsDatabase.exec("CREATE VIRTUAL TABLE cv_volume_fts USING fts5(name, aliases, deck, description, content='cv_volume', content_rowid='id', tokenize='trigram case_sensitive 0')");
  ftsDatabase.exec("CREATE VIRTUAL TABLE cv_issue_fts USING fts5(name, description, content='cv_issue', content_rowid='id', tokenize='trigram case_sensitive 0')");
  ftsDatabase.exec("INSERT INTO cv_volume_fts(cv_volume_fts) VALUES('rebuild')");
  ftsDatabase.exec("INSERT INTO cv_issue_fts(cv_issue_fts) VALUES('rebuild')");
  ftsDatabase.close();

  const ftsServer = createApiServer(ftsDatabasePath, () => {});
  await new Promise((resolve) => ftsServer.listen(0, "127.0.0.1", resolve));
  const ftsUrl = `http://127.0.0.1:${ftsServer.address().port}`;

  try {
    // Search is case-insensitive and matches the name column only (a substring).
    const search = await (await fetch(`${ftsUrl}/api/search/?query=witchblade&resources=volume`)).json();
    assert.equal(search.number_of_total_results, 1);
    assert.equal(search.results[0].id, 1);

    // A query that only appears in a non-name field must not match (search is name-only).
    const deckOnlySearch = await (await fetch(`${ftsUrl}/api/search/?query=batman&resources=volume`)).json();
    assert.equal(deckOnlySearch.number_of_total_results, 0);

    // A single-value text filter uses the FTS index (deck substring, both case-insensitive).
    const filtered = await (await fetch(`${ftsUrl}/api/volumes?filter=deck:batman&field_list=id`)).json();
    assert.deepEqual(filtered.results.map((result) => result.id), [2]);

    // A value shorter than the trigram minimum falls back to LIKE and still matches.
    const short = await (await fetch(`${ftsUrl}/api/volumes?filter=name:Du&field_list=id`)).json();
    assert.deepEqual(short.results.map((result) => result.id), [2]);

    // Issue search via its own FTS index.
    const issueSearch = await (await fetch(`${ftsUrl}/api/search/?query=Test%20Issue&resources=issue`)).json();
    assert.equal(issueSearch.number_of_total_results, 1);
    assert.equal(issueSearch.results[0].id, 10);
  } finally {
    await new Promise((resolve) => ftsServer.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("builds volume first/last issue refs from the cv_issue join (SRV-6c)", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "comicvine-join-test-"));
  const joinDatabasePath = path.join(directory, "join.db");
  const joinDatabase = new DatabaseSync(joinDatabasePath);
  joinDatabase.exec("CREATE TABLE cv_publisher (id INTEGER PRIMARY KEY, name TEXT)");
  joinDatabase.exec("CREATE TABLE cv_volume (id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, start_year TEXT, publisher_id INTEGER, count_of_issues INTEGER, description TEXT, image_url TEXT, site_detail_url TEXT, api_detail_url TEXT, deck TEXT, date_added TEXT, date_last_updated TEXT, credits_presence INTEGER)");
  joinDatabase.exec("CREATE TABLE cv_issue (id INTEGER PRIMARY KEY, volume_id INTEGER, name TEXT, issue_number TEXT, api_detail_url TEXT)");
  joinDatabase.exec("CREATE TABLE cv_volume_credit (volume_id INTEGER NOT NULL, credit_type TEXT NOT NULL, position INTEGER NOT NULL, credit_id INTEGER, name TEXT, count TEXT, api_detail_url TEXT, site_detail_url TEXT, PRIMARY KEY (volume_id, credit_type, position))");
  joinDatabase.exec("CREATE TABLE cv_volume_issue_ref (volume_id INTEGER NOT NULL, ref_type TEXT NOT NULL, issue_id INTEGER, key_order TEXT, PRIMARY KEY (volume_id, ref_type))");
  joinDatabase.prepare("INSERT INTO cv_volume (id, name, start_year, count_of_issues, credits_presence) VALUES (?, ?, ?, ?, ?)")
      .run(1, "Witchblade", "1995", 2, 0);
  // Issue 10 exists locally (resolves); issue 99 does not (dangling ref).
  joinDatabase.prepare("INSERT INTO cv_issue (id, volume_id, name, issue_number, api_detail_url) VALUES (?, ?, ?, ?, ?)")
      .run(10, 1, "Witchblade #1", "1", "https://example.test/issue/4000-10/");
  // first_issue → 10 (resolves, id-first key order); last_issue → 99 (dangling).
  joinDatabase.prepare("INSERT INTO cv_volume_issue_ref (volume_id, ref_type, issue_id, key_order) VALUES (?, ?, ?, ?)")
      .run(1, "first", 10, JSON.stringify(["id", "name", "issue_number", "api_detail_url"]));
  joinDatabase.prepare("INSERT INTO cv_volume_issue_ref (volume_id, ref_type, issue_id, key_order) VALUES (?, ?, ?, ?)")
      .run(1, "last", 99, JSON.stringify(["id", "name", "issue_number", "api_detail_url"]));
  joinDatabase.close();

  const joinServer = createApiServer(joinDatabasePath, () => {});
  await new Promise((resolve) => joinServer.listen(0, "127.0.0.1", resolve));
  const joinUrl = `http://127.0.0.1:${joinServer.address().port}`;

  try {
    const detail = await (await fetch(`${joinUrl}/api/volume/4050-1/`)).json();
    const result = detail.results;

    // Resolving ref: display fields come from the joined cv_issue row.
    assert.deepEqual(result.first_issue, {
      id: 10, name: "Witchblade #1", issue_number: "1", api_detail_url: "https://example.test/issue/4000-10/"
    });
    // Dangling ref: the id is still emitted, joined fields are null.
    assert.deepEqual(result.last_issue, { id: 99, name: null, issue_number: null, api_detail_url: null });
  } finally {
    await new Promise((resolve) => joinServer.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("supports volume field selection, sorting, and date range filters", async () => {
  const sorted = await fetch(`${baseUrl}/api/volumes?sort=name:desc&limit=1&field_list=id,name`);
  const sortedBody = await sorted.json();
  assert.equal(sorted.status, 200);
  assert.deepEqual(sortedBody.results, [{ id: 7300, name: "Witchblade" }]);

  const filtered = await fetch(`${baseUrl}/api/volumes?filter=date_added:2020-01-01%7C2021-01-01&field_list=id`);
  const filteredBody = await filtered.json();
  assert.equal(filteredBody.number_of_total_results, 1);
  assert.deepEqual(filteredBody.results, [{ id: 7300 }]);
});

test("supports volume multi-id filters (pipe-separated) and keeps single-id exact match", async () => {
  // Two real ids match both rows.
  const both = await (await fetch(`${baseUrl}/api/volumes?filter=id:7300%7C7301&field_list=id`)).json();
  assert.equal(both.number_of_total_results, 2);
  assert.deepEqual(new Set(both.results.map((v) => v.id)), new Set([7300, 7301]));

  // A list containing one real id and one absent id matches only the real one.
  const some = await (await fetch(`${baseUrl}/api/volumes?filter=id:7300%7C99999&field_list=id`)).json();
  assert.equal(some.number_of_total_results, 1);
  assert.deepEqual(some.results, [{ id: 7300 }]);

  // A single id stays an exact match (not a range, not a LIKE).
  const single = await (await fetch(`${baseUrl}/api/volumes?filter=id:7300&field_list=id`)).json();
  assert.equal(single.number_of_total_results, 1);
  assert.deepEqual(single.results, [{ id: 7300 }]);

  // Non-numeric tokens in the list are not treated as ids; the value falls back
  // to a single exact match (which matches nothing for a non-numeric string).
  const nonNumeric = await (await fetch(`${baseUrl}/api/volumes?filter=id:7300%7Cabc&field_list=id`)).json();
  assert.equal(nonNumeric.number_of_total_results, 0);
});

test("supports volume JSON, XML, and JSONP formats", async () => {
  const xml = await fetch(`${baseUrl}/api/volumes?limit=1&format=xml`);
  assert.match(xml.headers.get("content-type"), /application\/xml/);
  assert.match(await xml.text(), /<volume><id>7300<\/id>/);

  const jsonp = await fetch(`${baseUrl}/api/volumes?limit=1&format=jsonp&json_callback=ComicVine.done`);
  const jsonpBody = await jsonp.text();
  assert.match(jsonpBody, /^ComicVine\.done\(/);
  assert.equal(JSON.parse(jsonpBody.slice("ComicVine.done(".length, -2)).results[0].id, 7300);
});

test("serves singular volume details with field_list and requested credit fields", async () => {
  const fields = "id,name,character_credits,concept_credits,team_credits";
  const response = await fetch(`${baseUrl}/api/volume/4050-7300/?format=json&field_list=${fields}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results, {
    id: 7300,
    name: "Witchblade",
    character_credits: [{ id: 1, name: "Sara Pezzini" }],
    concept_credits: [],
    team_credits: [{ id: 2, name: "Witchblade Team" }]
  });

  const apiAlias = await fetch(`${baseUrl}/api/volume/4050-7300/?field_list=id,name`);
  const apiAliasBody = await apiAlias.json();
  assert.deepEqual(apiAliasBody.results, { id: 7300, name: "Witchblade" });
});

test("supports team fields, sort, pagination, and filters", async () => {
  const response = await fetch(`${baseUrl}/api/teams?format=json&sort=name:desc&limit=1&field_list=id,name,count_of_team_members,count_of_isssue_appearances,publisher,first_appeared_in_issue`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.number_of_total_results, 2);
  assert.deepEqual(body.results, [{
    id: 1800,
    name: "The Hand",
    count_of_team_members: 93,
    count_of_isssue_appearances: 180,
    publisher: { id: 31, name: "Marvel" },
    first_appeared_in_issue: { id: 20965, name: "Elektra", issue_number: "168" }
  }]);

  // SRV-22: the live API's typo count name sorts on the corrected-spelling column.
  const sorted = await fetch(`${baseUrl}/api/teams?format=json&sort=count_of_isssue_appearances:desc&limit=1&field_list=id,name`);
  const sortedBody = await sorted.json();
  assert.deepEqual(sortedBody.results, [{ id: 1800, name: "The Hand" }]);

  const filtered = await fetch(`${baseUrl}/api/teams?filter=date_added:2020-01-01%7C2021-01-01&field_list=id,name`);
  const filteredBody = await filtered.json();
  assert.equal(filteredBody.number_of_total_results, 1);
  assert.deepEqual(filteredBody.results, [{ id: 1800, name: "The Hand" }]);
});

test("supports team XML and JSONP formats", async () => {
  const xml = await fetch(`${baseUrl}/api/teams?limit=1&format=xml`);
  assert.match(xml.headers.get("content-type"), /application\/xml/);
  assert.match(await xml.text(), /<team><id>1800<\/id>/);

  const jsonp = await fetch(`${baseUrl}/api/teams?limit=1&format=jsonp&json_callback=ComicVine.teams`);
  const jsonpBody = await jsonp.text();
  assert.match(jsonpBody, /^ComicVine\.teams\(/);
  assert.equal(JSON.parse(jsonpBody.slice("ComicVine.teams(".length, -2)).results[0].id, 1800);
});

test("serves singular team details with requested relationship fields", async () => {
  const fields = "id,name,character_enemies,character_friends,characters,disbanded_in_issues,first_appeared_in_issue,issue_credits,isssues_disbanded_in,movies,story_arc_credits,volume_credits";
  const response = await fetch(`${baseUrl}/api/team/4060-1800/?format=json&field_list=${fields}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results, {
    id: 1800,
    name: "The Hand",
    character_enemies: [],
    character_friends: [],
    characters: [],
    disbanded_in_issues: [],
    first_appeared_in_issue: { id: 20965, name: "Elektra", issue_number: "168" },
    issue_credits: [],
    isssues_disbanded_in: [],
    movies: [],
    story_arc_credits: [],
    volume_credits: []
  });

  const apiAlias = await fetch(`${baseUrl}/api/team/4060-1800/?format=jsonp&json_callback=ComicVine.team&field_list=id,name`);
  const apiAliasBody = await apiAlias.text();
  assert.match(apiAliasBody, /^ComicVine\.team\(/);
  assert.deepEqual(JSON.parse(apiAliasBody.slice("ComicVine.team(".length, -2)).results, {
    id: 1800,
    name: "The Hand"
  });
});

test("emits the full team shape with live names and types (SRV-22)", async () => {
  const response = await fetch(`${baseUrl}/api/team/4060-1800/?format=json`);
  const body = await response.json();
  const team = body.results;

  assert.equal(response.status, 200);
  // The api_detail_url is derived from the id; the table has no such column.
  assert.equal(team.api_detail_url, "https://comicvine.gamespot.com/api/team/4060-1800/");
  // The internal image_url column no longer leaks; image is built from it.
  assert.equal(Object.hasOwn(team, "image_url"), false);
  assert.equal(team.image.original_url, "https://example.test/the-hand.jpg");
  // The count and disbanded collection use the live API's typo names; the
  // corrected spellings are not emitted.
  assert.equal(team.count_of_isssue_appearances, 180);
  assert.equal(Object.hasOwn(team, "count_of_issue_appearances"), false);
  assert.deepEqual(team.isssues_disbanded_in, []);
  assert.equal(Object.hasOwn(team, "issues_disbanded_in"), false);
  // The remaining stored fields are emitted with their live names.
  assert.equal(team.aliases, "The Hand (Marvel)");
  assert.equal(team.deck, "A secret organization of assassins");
  assert.equal(team.description, "The Hand is a secret organization of assassins that operates in the shadows.");
  assert.equal(team.date_added, "2020-04-15 10:00:00");
  assert.equal(team.date_last_updated, "2021-05-01 08:30:00");
  assert.equal(team.site_detail_url, "https://example.test/the-hand/");
  assert.deepEqual(team.publisher, { id: 31, name: "Marvel" });
  assert.deepEqual(team.first_appeared_in_issue, { id: 20965, name: "Elektra", issue_number: "168" });
  assert.deepEqual(team.character_enemies, []);
  assert.deepEqual(team.character_friends, []);
  assert.deepEqual(team.characters, []);
  assert.deepEqual(team.disbanded_in_issues, []);
  assert.deepEqual(team.issue_credits, []);
  assert.deepEqual(team.movies, []);
  assert.deepEqual(team.story_arc_credits, []);
  assert.deepEqual(team.volume_credits, []);
});

test("supports story arc fields, sorting, pagination, and filters", async () => {
  const response = await fetch(`${baseUrl}/api/story_arcs?format=json&sort=name:desc&limit=1&field_list=id,name,count_of_issue_appearances,publisher,first_appeared_in_issue`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.number_of_total_results, 2);
  assert.deepEqual(body.results, [{
    id: 3000,
    name: "Secret Wars",
    count_of_issue_appearances: 12,
    publisher: { id: 31, name: "Marvel" },
    first_appeared_in_issue: { id: 12345, name: "Marvel Super Heroes Secret Wars", issue_number: "1" }
  }]);

  const filtered = await fetch(`${baseUrl}/api/story_arcs?filter=date_added:2020-01-01%7C2021-01-01&field_list=id,name`);
  const filteredBody = await filtered.json();
  assert.equal(filteredBody.number_of_total_results, 1);
  assert.deepEqual(filteredBody.results, [{ id: 3000, name: "Secret Wars" }]);
});

test("supports story arc XML and JSONP formats", async () => {
  const xml = await fetch(`${baseUrl}/api/story_arcs?limit=1&format=xml`);
  assert.match(xml.headers.get("content-type"), /application\/xml/);
  assert.match(await xml.text(), /<story_arc><id>3000<\/id>/);

  const jsonp = await fetch(`${baseUrl}/api/story_arcs?limit=1&format=jsonp&json_callback=ComicVine.storyArcs`);
  const jsonpBody = await jsonp.text();
  assert.match(jsonpBody, /^ComicVine\.storyArcs\(/);
  assert.equal(JSON.parse(jsonpBody.slice("ComicVine.storyArcs(".length, -2)).results[0].id, 3000);
});

test("serves singular story arc details with issues and movies fields", async () => {
  const response = await fetch(`${baseUrl}/api/story_arc/4040-3000/?format=json&field_list=id,name,issues,movies`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results, {
    id: 3000,
    name: "Secret Wars",
    issues: [{ id: 12345, name: "Marvel Super Heroes Secret Wars", issue_number: "1" }],
    movies: []
  });

  const apiAlias = await fetch(`${baseUrl}/api/story_arc/4040-3000/?format=xml&field_list=id,name,movies`);
  assert.match(apiAlias.headers.get("content-type"), /application\/xml/);
  assert.match(await apiAlias.text(), /<movies><\/movies>/);
});

test("supports publisher fields, sorting, pagination, and filters", async () => {
  const response = await fetch(`${baseUrl}/api/publishers?format=json&sort=name:desc&limit=1&field_list=id,name,location_address,location_city,location_state`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.number_of_total_results, 2);
  assert.deepEqual(body.results, [{
    id: 4,
    name: "Dell",
    location_address: "750 Third Avenue",
    location_city: "New York",
    location_state: "NY"
  }]);

  const filtered = await fetch(`${baseUrl}/api/publishers?filter=date_added:2020-01-01%7C2021-01-01&field_list=id,name,location_city`);
  const filteredBody = await filtered.json();
  assert.equal(filteredBody.number_of_total_results, 1);
  assert.deepEqual(filteredBody.results, [{ id: 4, name: "Dell", location_city: "New York" }]);
});

test("supports publisher XML and JSONP formats", async () => {
  const xml = await fetch(`${baseUrl}/api/publishers?limit=1&format=xml`);
  assert.match(xml.headers.get("content-type"), /application\/xml/);
  assert.match(await xml.text(), /<publisher><id>4<\/id>/);

  const jsonp = await fetch(`${baseUrl}/api/publishers?limit=1&format=jsonp&json_callback=ComicVine.publishers`);
  const jsonpBody = await jsonp.text();
  assert.match(jsonpBody, /^ComicVine\.publishers\(/);
  assert.equal(JSON.parse(jsonpBody.slice("ComicVine.publishers(".length, -2)).results[0].id, 4);
});

test("serves publisher details with relationship fields and format selection", async () => {
  const response = await fetch(`${baseUrl}/api/publisher/4010-4/?format=json&field_list=id,name,characters,story_arcs,teams,volumes`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results, {
    id: 4,
    name: "Dell",
    characters: [{ id: 17, name: "Daredevil" }],
    story_arcs: [],
    teams: [],
    volumes: []
  });

  const xml = await fetch(`${baseUrl}/api/publisher/4010-4/?format=xml&field_list=id,name`);
  assert.match(xml.headers.get("content-type"), /application\/xml/);
  assert.match(await xml.text(), /<name>Dell<\/name>/);

  const jsonp = await fetch(`${baseUrl}/api/publisher/4010-4/?format=jsonp&json_callback=ComicVine.publisher&field_list=id,name`);
  const jsonpBody = await jsonp.text();
  assert.match(jsonpBody, /^ComicVine\.publisher\(/);
  assert.deepEqual(JSON.parse(jsonpBody.slice("ComicVine.publisher(".length, -2)).results, {
    id: 4,
    name: "Dell"
  });
});

test("derives publisher api_detail_url from the id (SRV-21)", async () => {
  const response = await fetch(`${baseUrl}/api/publisher/4010-4/?format=json`);
  const body = await response.json();
  assert.equal(response.status, 200);
  // The live API always emits api_detail_url; the mock derives it from the id
  // (canonical base URL + domain prefix + id) instead of reading a stored column.
  assert.equal(body.results.api_detail_url, "https://comicvine.gamespot.com/api/publisher/4010-4/");
  // id stays the first key so the XML shape matches the live API.
  assert.equal(Object.keys(body.results)[0], "id");

  const projected = await fetch(`${baseUrl}/api/publisher/4010-4/?format=json&field_list=id,name,api_detail_url`);
  const projectedBody = await projected.json();
  assert.deepEqual(projectedBody.results, {
    id: 4,
    name: "Dell",
    api_detail_url: "https://comicvine.gamespot.com/api/publisher/4010-4/"
  });
});

test("derives concept api_detail_url from the id (UPD-13)", async () => {
  const response = await fetch(`${baseUrl}/api/concept/4015-58852/?format=json`);
  const body = await response.json();
  assert.equal(response.status, 200);
  // The live API always emits api_detail_url; the server derives it from the id
  // (canonical base URL + domain prefix 4015 + id) — the table has no such column.
  assert.equal(body.results.api_detail_url, "https://comicvine.gamespot.com/api/concept/4015-58852/");
  assert.equal(body.results.name, "Digital Comic");

  const projected = await fetch(`${baseUrl}/api/concept/4015-58852/?format=json&field_list=id,name,api_detail_url`);
  const projectedBody = await projected.json();
  assert.deepEqual(projectedBody.results, {
    id: 58852,
    name: "Digital Comic",
    api_detail_url: "https://comicvine.gamespot.com/api/concept/4015-58852/"
  });
});

test("emits the full concept shape with live names and types (SRV-26)", async () => {
  const response = await fetch(`${baseUrl}/api/concept/4015-58852/?format=json`);
  const body = await response.json();
  const concept = body.results;

  assert.equal(response.status, 200);
  // The api_detail_url is derived from the id; the table has no such column.
  assert.equal(concept.api_detail_url, "https://comicvine.gamespot.com/api/concept/4015-58852/");
  // The internal image_url column no longer leaks; image is built from it (and
  // expanded into the live API's full multi-URL object by normalizeResult).
  assert.equal(Object.hasOwn(concept, "image_url"), false);
  assert.equal(concept.image.original_url, "https://example.test/digital-comic.jpg");
  assert.equal(concept.image.image_tags, "All Images");
  // SRV-26: the count uses the live API's typo name; the corrected spelling is not emitted.
  assert.equal(concept.count_of_isssue_appearances, 9);
  assert.equal(Object.hasOwn(concept, "count_of_issue_appearances"), false);
  // The non-null first_appeared_in_issue is emitted as an object.
  assert.deepEqual(concept.first_appeared_in_issue, { id: 4001, name: "Test Series #1" });
  // The three collections are always arrays (the live API never returns null).
  assert.deepEqual(concept.issue_credits, []);
  assert.deepEqual(concept.movies, []);
  assert.deepEqual(concept.volume_credits, []);
  // The remaining stored fields are emitted with their live names.
  assert.equal(concept.aliases, "DC");
  assert.equal(concept.deck, "A digital comic");
  assert.equal(concept.description, "A digital comic description");
  assert.equal(concept.date_added, "2020-01-01 00:00:00");
  assert.equal(concept.date_last_updated, "2026-01-01 00:00:00");
  assert.equal(concept.site_detail_url, "https://example.test/digital-comic/");
  assert.equal(concept.start_year, "2005");
});

test("emits null (not an absent key) for a null first_appeared_in_issue (SRV-26)", async () => {
  const response = await fetch(`${baseUrl}/api/concept/4015-58853/?format=json`);
  const body = await response.json();
  const concept = body.results;

  assert.equal(response.status, 200);
  // SRV-26: the live API emits null (not an absent key) when the stored value is NULL.
  assert.equal(Object.hasOwn(concept, "first_appeared_in_issue"), true);
  assert.equal(concept.first_appeared_in_issue, null);
  // The count is emitted under the typo name.
  assert.equal(concept.count_of_isssue_appearances, 3);
  // The three collections are always arrays (the live API never returns null).
  assert.deepEqual(concept.issue_credits, []);
  assert.deepEqual(concept.movies, []);
  assert.deepEqual(concept.volume_credits, []);
});

test("supports concept sort on the typo count and field selection (SRV-26)", async () => {
  // SRV-26: the live API's typo count name sorts on the corrected-spelling column.
  const sorted = await fetch(`${baseUrl}/api/concepts?format=json&sort=count_of_isssue_appearances:desc&limit=1&field_list=id,name`);
  const sortedBody = await sorted.json();
  assert.equal(sorted.status, 200);
  // 58852 has count 9, 58853 has count 3 → 58852 sorts first.
  assert.deepEqual(sortedBody.results, [{ id: 58852, name: "Digital Comic" }]);

  const fields = "id,name,count_of_isssue_appearances,first_appeared_in_issue,issue_credits,movies,volume_credits";
  const projected = await fetch(`${baseUrl}/api/concept/4015-58852/?format=json&field_list=${fields}`);
  const projectedBody = await projected.json();
  assert.deepEqual(projectedBody.results, {
    id: 58852,
    name: "Digital Comic",
    count_of_isssue_appearances: 9,
    first_appeared_in_issue: { id: 4001, name: "Test Series #1" },
    issue_credits: [],
    movies: [],
    volume_credits: []
  });
});

test("builds concept collections from the cv_concept_credit join (SRV-26)", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "comicvine-concept-join-test-"));
  const joinDatabasePath = path.join(directory, "concept-join.db");
  const joinDatabase = new DatabaseSync(joinDatabasePath);
  joinDatabase.exec("CREATE TABLE cv_concept (id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, deck TEXT, description TEXT, date_added TEXT, date_last_updated TEXT, image_url TEXT, site_detail_url TEXT, first_appeared_in_issue TEXT, count_of_issue_appearances INTEGER, start_year TEXT)");
  joinDatabase.exec("CREATE TABLE cv_concept_credit (concept_id INTEGER NOT NULL, credit_type TEXT NOT NULL, position INTEGER NOT NULL, credit_id INTEGER, name TEXT, api_detail_url TEXT, site_detail_url TEXT, PRIMARY KEY (concept_id, credit_type, position))");
  joinDatabase.prepare("INSERT INTO cv_concept (id, name, count_of_issue_appearances, first_appeared_in_issue) VALUES (?, ?, ?, ?)")
      .run(1, "Alternate Reality", 3643, null);
  // issue_credits x2, movies x1, volume_credits x1.
  joinDatabase.prepare("INSERT INTO cv_concept_credit (concept_id, credit_type, position, credit_id, name, api_detail_url, site_detail_url) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(1, "issue", 0, 918825, "Some Issue #1", "https://example.test/issue/4000-918825/", "https://example.test/site/issue1");
  joinDatabase.prepare("INSERT INTO cv_concept_credit (concept_id, credit_type, position, credit_id, name, api_detail_url, site_detail_url) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(1, "issue", 1, 918826, "Some Issue #2", "https://example.test/issue/4000-918826/", "https://example.test/site/issue2");
  joinDatabase.prepare("INSERT INTO cv_concept_credit (concept_id, credit_type, position, credit_id, name, api_detail_url, site_detail_url) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(1, "movie", 0, 3204, "The Fantastic Four: First Steps", "https://example.test/movie/4025-3204/", "https://example.test/site/movie");
  joinDatabase.prepare("INSERT INTO cv_concept_credit (concept_id, credit_type, position, credit_id, name, api_detail_url, site_detail_url) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(1, "volume", 0, 7300, "Witchblade", "https://example.test/volume/4050-7300/", "https://example.test/site/volume");
  joinDatabase.close();

  const joinServer = createApiServer(joinDatabasePath, () => {});
  await new Promise((resolve) => joinServer.listen(0, "127.0.0.1", resolve));
  const joinUrl = `http://127.0.0.1:${joinServer.address().port}`;

  try {
    const detail = await (await fetch(`${joinUrl}/api/concept/4015-1/`)).json();
    const result = detail.results;

    // SRV-26: the collections are generated from the join table, api_detail_url-first.
    assert.deepEqual(result.issue_credits, [
      { api_detail_url: "https://example.test/issue/4000-918825/", id: 918825, name: "Some Issue #1", site_detail_url: "https://example.test/site/issue1" },
      { api_detail_url: "https://example.test/issue/4000-918826/", id: 918826, name: "Some Issue #2", site_detail_url: "https://example.test/site/issue2" }
    ]);
    assert.deepEqual(result.movies, [
      { api_detail_url: "https://example.test/movie/4025-3204/", id: 3204, name: "The Fantastic Four: First Steps", site_detail_url: "https://example.test/site/movie" }
    ]);
    assert.deepEqual(result.volume_credits, [
      { api_detail_url: "https://example.test/volume/4050-7300/", id: 7300, name: "Witchblade", site_detail_url: "https://example.test/site/volume" }
    ]);
    // The count is emitted under the typo name; the null first_appeared_in_issue is null.
    assert.equal(result.count_of_isssue_appearances, 3643);
    assert.equal(result.first_appeared_in_issue, null);
  } finally {
    await new Promise((resolve) => joinServer.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("supports people fields, sorting, pagination, and filters", async () => {
  const response = await fetch(`${baseUrl}/api/people?format=json&sort=name:desc&limit=1&field_list=id,name,birth,death,country,gender,hometown,email,website`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.number_of_total_results, 2);
  assert.deepEqual(body.results, [{
    id: 1251,
    name: "Barry Kitson",
    birth: null,
    death: null,
    country: "United Kingdom",
    gender: 1,
    hometown: "Leicester",
    email: "barry@example.test",
    website: "https://example.test/barry"
  }]);

  const filtered = await fetch(`${baseUrl}/api/people?filter=date_added:2020-01-01%7C2021-01-01&field_list=id,name`);
  const filteredBody = await filtered.json();
  assert.equal(filteredBody.number_of_total_results, 1);
  assert.deepEqual(filteredBody.results, [{ id: 1251, name: "Barry Kitson" }]);
});

test("supports people XML and JSONP formats", async () => {
  const xml = await fetch(`${baseUrl}/api/people?limit=1&format=xml`);
  assert.match(xml.headers.get("content-type"), /application\/xml/);
  assert.match(await xml.text(), /<person><id>1251<\/id>/);

  const jsonp = await fetch(`${baseUrl}/api/people?limit=1&format=jsonp&json_callback=ComicVine.people`);
  const jsonpBody = await jsonp.text();
  assert.match(jsonpBody, /^ComicVine\.people\(/);
  assert.equal(JSON.parse(jsonpBody.slice("ComicVine.people(".length, -2)).results[0].id, 1251);
});

test("supports ?sort= on the issues list endpoint (SRV-1)", async () => {
  // name asc: "Another Issue" (43) before "The Test Issue" (42) alphabetically.
  const byName = await fetch(`${baseUrl}/api/issues?sort=name:asc&field_list=id,name`);
  assert.equal(byName.status, 200);
  assert.deepEqual((await byName.json()).results.map((r) => r.id), [43, 42]);

  // name desc reverses it.
  const byNameDesc = await fetch(`${baseUrl}/api/issues?sort=name:desc&field_list=id,name`);
  assert.equal(byNameDesc.status, 200);
  assert.deepEqual((await byNameDesc.json()).results.map((r) => r.id), [42, 43]);

  // A numeric/date field (issue_number) is a valid sort column and returns 200.
  const byNumber = await fetch(`${baseUrl}/api/issues?sort=issue_number:asc&field_list=id,issue_number`);
  assert.equal(byNumber.status, 200);
  assert.equal((await byNumber.json()).results.length, 2);

  // An unsupported field is rejected with 400.
  const bad = await fetch(`${baseUrl}/api/issues?sort=not_a_field:asc`);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Sort/);
});

test("a no-sort list keeps the default id ordering (SRV-1)", async () => {
  const people = await fetch(`${baseUrl}/api/people?limit=10&field_list=id,name`);
  const peopleBody = await people.json();
  assert.equal(people.status, 200);
  assert.deepEqual(peopleBody.results.map((r) => r.id), [1251, 1252]);
});

test("honors the defaultSort option for unsorted list endpoints (SRV-1)", async () => {
  const srv = createApiServer(databasePath, () => {}, { defaultSort: { people: "name" } });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    // name asc: "Alex Ross" (1252) before "Barry Kitson" (1251).
    const asc = await fetch(`${url}/api/people?limit=10&field_list=id,name`);
    assert.equal(asc.status, 200);
    assert.deepEqual((await asc.json()).results.map((r) => r.id), [1252, 1251]);

    // An explicit ?sort= still wins over the default.
    const desc = await fetch(`${url}/api/people?sort=name:desc&limit=10&field_list=id,name`);
    assert.deepEqual((await desc.json()).results.map((r) => r.id), [1251, 1252]);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("serves singular person details with relationship fields", async () => {
  // SRV-20: the live API names the person's issue credits `issues` (not issue_credits).
  const fields = "id,name,created_characters,issues,story_arc_credits,volume_credits";
  const response = await fetch(`${baseUrl}/api/person/4040-1251/?format=json&field_list=${fields}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results, {
    id: 1251,
    name: "Barry Kitson",
    created_characters: [{ id: 9081, name: "The Amazing Bug" }],
    issues: [],
    story_arc_credits: [],
    volume_credits: [{ id: 120, name: "Sample Volume" }]
  });

  const xml = await fetch(`${baseUrl}/api/person/4040-1251/?format=xml&field_list=id,name,issues`);
  assert.match(xml.headers.get("content-type"), /application\/xml/);
  assert.match(await xml.text(), /<issues><\/issues>/);
});

test("emits the full person shape with live names and types (SRV-20)", async () => {
  const response = await fetch(`${baseUrl}/api/person/4040-1251/?format=json`);
  const body = await response.json();
  const person = body.results;

  assert.equal(response.status, 200);
  // The four previously-dropped stored fields are now emitted.
  assert.equal(person.api_detail_url, "https://comicvine.gamespot.com/api/person/4040-1251/");
  assert.equal(person.date_added, "2020-04-15 10:00:00");
  assert.equal(person.date_last_updated, "2021-05-01 08:30:00");
  assert.equal(person.death, null);
  // The internal image_url column no longer leaks; image is built from it.
  assert.equal(Object.hasOwn(person, "image_url"), false);
  assert.equal(person.image.original_url, "https://example.test/barry.jpg");
  // The count uses the live API's typo name; the corrected spelling is not emitted.
  assert.equal(person.count_of_isssue_appearances, 180);
  assert.equal(Object.hasOwn(person, "count_of_issue_appearances"), false);
  // The issue credits use the live name `issues`; `issue_credits` is not emitted.
  assert.deepEqual(person.issues, []);
  assert.equal(Object.hasOwn(person, "issue_credits"), false);
  // gender is a number (the stored TEXT "1" is coerced), matching the live API.
  assert.equal(person.gender, 1);
  assert.equal(typeof person.gender, "number");
});

test("rejects unprefixed resource routes", async () => {
  const response = await fetch(`${baseUrl}/publishers`);
  assert.equal(response.status, 404);

  const root = await fetch(baseUrl);
  assert.equal(root.status, 404);

  const apiRoot = await fetch(`${baseUrl}/api/`);
  const apiRootBody = await apiRoot.json();
  assert.equal(apiRoot.status, 200);
  assert(apiRootBody.endpoints.every((endpoint) => endpoint.startsWith("/api/")));
});

test("logs query parameters while redacting credentials", async () => {
  const response = await fetch(`${baseUrl}/api/people?api_key=private-value&query=private-search`);
  assert.equal(response.status, 200);

  const logEntry = requestLogs.at(-1);
  assert.equal(logEntry.method, "GET");
  assert.equal(logEntry.path, "/api/people");
  assert.match(logEntry.query, /query=private-search/);
  assert.equal(logEntry.status, 200);
  assert.equal(typeof logEntry.duration_ms, "number");
  assert(!JSON.stringify(logEntry).includes("private-value"));
});

test("stamps log entries with a level and ISO-8601 timestamp", async () => {
  const entries = [];
  const levelServer = createApiServer(databasePath, (entry) => entries.push(entry));
  await new Promise((resolve) => levelServer.listen(0, "127.0.0.1", resolve));
  const levelUrl = `http://127.0.0.1:${levelServer.address().port}`;

  try {
    await fetch(`${levelUrl}/api/people`);
    const entry = entries.at(-1);
    assert.equal(entry.level, "info");
    assert.ok(typeof entry.timestamp, "string");
    assert.equal(new Date(entry.timestamp).toISOString(), entry.timestamp);
  } finally {
    await new Promise((resolve) => levelServer.close(resolve));
  }
});

test("drops log entries below the configured level threshold", async () => {
  // At a "warn" threshold, the routine info request log is suppressed, but a
  // validation mismatch (logged at warn) is emitted.
  const entries = [];
  const previousKey = process.env.COMICVINE_API_KEY;
  process.env.COMICVINE_API_KEY = "test-key";
  const quietServer = createApiServer(databasePath, (entry) => entries.push(entry), {
    logLevel: "warn",
    validate: true,
    fetchFn: async (singular, id) => ({ id, name: "LIVE " + id })
  });
  await new Promise((resolve) => quietServer.listen(0, "127.0.0.1", resolve));
  const quietUrl = `http://127.0.0.1:${quietServer.address().port}`;

  try {
    // A plain request logs at info and is dropped by the warn threshold.
    await fetch(`${quietUrl}/api/volumes`);
    assert.equal(entries.length, 0);

    // A detail request triggers validation; the mismatch is a warn and is kept.
    await fetch(`${quietUrl}/api/volume/7300/`);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].level, "warn");
    assert.equal(entries[0].type, "validation");
  } finally {
    await new Promise((resolve) => quietServer.close(resolve));
    if (previousKey === undefined) delete process.env.COMICVINE_API_KEY;
    else process.env.COMICVINE_API_KEY = previousKey;
  }
});

test("writes log entries to a rotating file and keeps stdout logging", async () => {
  const fileDirectory = mkdtempSync(path.join(os.tmpdir(), "comicvine-log-test-"));
  const logFile = path.join(fileDirectory, "server.log");
  const stdoutEntries = [];
  const fileServer = createApiServer(databasePath, (entry) => stdoutEntries.push(entry), {
    logFile
  });
  await new Promise((resolve) => fileServer.listen(0, "127.0.0.1", resolve));
  const fileUrl = `http://127.0.0.1:${fileServer.address().port}`;

  try {
    await fetch(`${fileUrl}/api/people?api_key=mock`);

    // The entry is still delivered to the (stdout) logger...
    assert.equal(stdoutEntries.at(-1).path, "/api/people");
    // ...and is also appended to the configured file as a formatted line.
    const fileContents = await fs.promises.readFile(logFile, "utf-8");
    assert.match(fileContents, /\[INFO\] /);
    assert.match(fileContents, /"path":"\/api\/people"/);
    // Credentials are redacted in the file too.
    assert.ok(!fileContents.includes("mock"));
  } finally {
    await new Promise((resolve) => fileServer.close(resolve));
    rmSync(fileDirectory, { recursive: true, force: true });
  }
});

test("rotates the log file when it exceeds the size limit", async () => {
  const fileDirectory = mkdtempSync(path.join(os.tmpdir(), "comicvine-log-rotate-test-"));
  const logFile = path.join(fileDirectory, "server.log");
  const fileServer = createApiServer(databasePath, () => {}, {
    logFile,
    logMaxSize: 1, // force rotation on the very first write
    logMaxFiles: 3
  });
  await new Promise((resolve) => fileServer.listen(0, "127.0.0.1", resolve));
  const fileUrl = `http://127.0.0.1:${fileServer.address().port}`;

  try {
    // Each request writes a line that exceeds the 1-byte cap, so the file
    // rotates before the new line is appended.
    await fetch(`${fileUrl}/api/people`);
    await fetch(`${fileUrl}/api/people`);

    // The current file holds the most recent line; an older generation exists.
    const current = await fs.promises.readFile(logFile, "utf-8");
    assert.match(current, /"path":"\/api\/people"/);
    assert.ok(fs.existsSync(`${logFile}.1`), "expected a rotated generation");
  } finally {
    await new Promise((resolve) => fileServer.close(resolve));
    rmSync(fileDirectory, { recursive: true, force: true });
  }
});

test("logs the serialized response body when response-body logging is enabled (SRV-16)", async () => {
  const entries = [];
  const bodyServer = createApiServer(databasePath, (entry) => entries.push(entry), {
    logResponses: true
  });
  await new Promise((resolve) => bodyServer.listen(0, "127.0.0.1", resolve));
  const bodyUrl = `http://127.0.0.1:${bodyServer.address().port}`;

  try {
    await fetch(`${bodyUrl}/api/volume/4050-7300?field_list=id`);
    const entry = entries.at(-1);
    assert.equal(entry.path, "/api/volume/4050-7300");
    // The emitted body is captured and embedded in the log line.
    assert.ok(entry.response_body, "expected a captured response body");
    assert.match(entry.response_body, /"id":7300/);
  } finally {
    await new Promise((resolve) => bodyServer.close(resolve));
  }

  // Off by default: with the flag unset the per-request line has no body field.
  const quietEntries = [];
  const quietServer = createApiServer(databasePath, (entry) => quietEntries.push(entry), {
    logResponses: false,
    logSql: false
  });
  await new Promise((resolve) => quietServer.listen(0, "127.0.0.1", resolve));
  const quietUrl = `http://127.0.0.1:${quietServer.address().port}`;
  try {
    await fetch(`${quietUrl}/api/volume/4050-7300?field_list=id`);
    assert.equal(Object.hasOwn(quietEntries.at(-1), "response_body"), false);
  } finally {
    await new Promise((resolve) => quietServer.close(resolve));
  }
});

test("truncates an over-long logged response body to the configured cap (SRV-16)", async () => {
  const entries = [];
  const bodyServer = createApiServer(databasePath, (entry) => entries.push(entry), {
    logResponses: true,
    logResponseMaxLength: 10
  });
  await new Promise((resolve) => bodyServer.listen(0, "127.0.0.1", resolve));
  const bodyUrl = `http://127.0.0.1:${bodyServer.address().port}`;

  try {
    await fetch(`${bodyUrl}/api/volume/4050-7300?field_list=id`);
    const entry = entries.at(-1);
    // The body is capped at the configured byte length, with a truncation note.
    assert.ok(entry.response_body.length <= 10 + 64, `body not truncated: ${entry.response_body}`);
    assert.match(entry.response_body, /truncated/);
  } finally {
    await new Promise((resolve) => bodyServer.close(resolve));
  }
});

test("logs the executed SQL when SQL logging is enabled (SRV-17)", async () => {
  const entries = [];
  const sqlServer = createApiServer(databasePath, (entry) => entries.push(entry), {
    logSql: true
  });
  await new Promise((resolve) => sqlServer.listen(0, "127.0.0.1", resolve));
  const sqlUrl = `http://127.0.0.1:${sqlServer.address().port}`;

  try {
    await fetch(`${sqlUrl}/api/volumes?filter=id:7300`);
    const entry = entries.at(-1);
    assert.equal(entry.path, "/api/volumes");
    // The recorded SQL is a JSON array of { sql, params } entries.
    const recorded = JSON.parse(entry.sql);
    assert.ok(Array.isArray(recorded) && recorded.length > 0, "expected recorded SQL");
    assert.ok(recorded.some((q) => q.sql.includes("cv_volume")), "expected a cv_volume query");
    // Bound values are captured alongside the SQL.
    const idQuery = recorded.find((q) => q.sql.includes("IN (") || q.sql.includes("id"));
    assert.ok(idQuery, "expected the id-filter query");
    assert.ok(idQuery.params.some((p) => String(p) === "7300"), "expected the bound id value");
  } finally {
    await new Promise((resolve) => sqlServer.close(resolve));
  }

  // Off by default: with the flag unset the per-request line has no sql field.
  // Pass `false` explicitly so the assertion is independent of any ambient
  // COMICVINE_LOG_RESPONSES / COMICVINE_LOG_SQL in the test process environment.
  const quietEntries = [];
  const quietServer = createApiServer(databasePath, (entry) => quietEntries.push(entry), {
    logResponses: false,
    logSql: false
  });
  await new Promise((resolve) => quietServer.listen(0, "127.0.0.1", resolve));
  const quietUrl = `http://127.0.0.1:${quietServer.address().port}`;
  try {
    await fetch(`${quietUrl}/api/volumes?filter=id:7300`);
    assert.equal(Object.hasOwn(quietEntries.at(-1), "sql"), false);
  } finally {
    await new Promise((resolve) => quietServer.close(resolve));
  }
});

test("truncates an over-long logged SQL to the configured cap (SRV-17)", async () => {
  const entries = [];
  const sqlServer = createApiServer(databasePath, (entry) => entries.push(entry), {
    logSql: true,
    logSqlMaxLength: 10
  });
  await new Promise((resolve) => sqlServer.listen(0, "127.0.0.1", resolve));
  const sqlUrl = `http://127.0.0.1:${sqlServer.address().port}`;

  try {
    await fetch(`${sqlUrl}/api/volumes?filter=id:7300`);
    const entry = entries.at(-1);
    assert.match(entry.sql, /truncated/);
    assert.ok(entry.sql.length < 10 + 64, `sql not truncated: ${entry.sql.length}`);
  } finally {
    await new Promise((resolve) => sqlServer.close(resolve));
  }
});

test("serves normalized localcv tables and reports missing resources cleanly", async () => {
  const localDirectory = mkdtempSync(path.join(os.tmpdir(), "comicvine-localcv-test-"));
  const localDatabasePath = path.join(localDirectory, "localcv.db");
  const originalImageUrl = "https://comicvine.gamespot.com/a/uploads/original/6/67663/3067569-01.jpg";
  const expectedImage = {
    icon_url: originalImageUrl.replace("/original/", "/square_avatar/"),
    medium_url: originalImageUrl.replace("/original/", "/scale_medium/"),
    screen_url: originalImageUrl.replace("/original/", "/screen_medium/"),
    screen_large_url: originalImageUrl.replace("/original/", "/screen_kubrick/"),
    small_url: originalImageUrl.replace("/original/", "/scale_small/"),
    super_url: originalImageUrl.replace("/original/", "/scale_large/"),
    thumb_url: originalImageUrl.replace("/original/", "/scale_avatar/"),
    tiny_url: originalImageUrl.replace("/original/", "/square_mini/"),
    original_url: originalImageUrl,
    image_tags: "All Images"
  };
  const localDatabase = new DatabaseSync(localDatabasePath);
  localDatabase.exec(`
    CREATE TABLE cv_volume (
      id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, start_year TEXT,
      publisher_id INTEGER, count_of_issues INTEGER, description TEXT,
      image_url TEXT, site_detail_url TEXT
    );
    CREATE TABLE cv_issue (
      id INTEGER PRIMARY KEY, volume_id INTEGER, name TEXT, issue_number TEXT,
      cover_date TEXT, store_date TEXT, description TEXT, image_url TEXT,
      site_detail_url TEXT, character_credits TEXT, person_credits TEXT,
      team_credits TEXT, location_credits TEXT, story_arc_credits TEXT,
      associated_images TEXT
    );
    CREATE TABLE cv_publisher (
      id INTEGER PRIMARY KEY, name TEXT, image_url TEXT, site_detail_url TEXT
    );
    CREATE TABLE cv_person (id INTEGER PRIMARY KEY, name TEXT);
  `);
  localDatabase.prepare("INSERT INTO cv_publisher VALUES (?, ?, ?, ?)")
    .run(31, "Top Cow", "https://example.test/top-cow.jpg", "https://example.test/top-cow");
  localDatabase.prepare("INSERT INTO cv_volume VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(7300, "Witchblade", null, "1995", 31, 5, null, originalImageUrl, "https://example.test/witchblade");
  localDatabase.prepare("INSERT INTO cv_volume VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(73001, "Adjacent Title", null, "1996", 31, 1, null, null, "https://example.test/adjacent-title");
  localDatabase.prepare("INSERT INTO cv_issue VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(42, 7300, "Witchblade #1", "1", "1995-11-01", null, "", "https://example.test/issue.jpg", "https://example.test/issue/42", JSON.stringify([{ id: 8, name: "Sara Pezzini" }]), "[]", "[]", "[]", "[]", "[]");
  localDatabase.prepare("INSERT INTO cv_issue VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(43, 73001, "Adjacent Title #1", "1", "1996-11-01", null, "", null, "https://example.test/issue/43", "[]", "[]", "[]", "[]", "[]", "[]");
  localDatabase.prepare("INSERT INTO cv_person VALUES (?, ?)").run(1251, "Barry Kitson");
  localDatabase.close();

  const localServer = createApiServer(localDatabasePath, () => {});
  await new Promise((resolve) => localServer.listen(0, "127.0.0.1", resolve));
  const localUrl = `http://127.0.0.1:${localServer.address().port}`;

  try {
    const discovery = await fetch(`${localUrl}/api/`);
    const discoveryBody = await discovery.json();
    assert(discoveryBody.available_resources.includes("volumes"), JSON.stringify(discoveryBody.available_resources));

    const volumes = await fetch(`${localUrl}/api/volumes?field_list=id,name,publisher,image&limit=1`);
    const volumeBody = await volumes.json();
    assert.equal(volumes.status, 200, JSON.stringify(volumeBody));
    assert.deepEqual(volumeBody.results[0], {
      id: 7300,
      name: "Witchblade",
      publisher: { id: 31, name: "Top Cow" },
      image: expectedImage
    });

    const volumeDetail = await fetch(`${localUrl}/api/volume/4050-7300?field_list=id,image`);
    const volumeDetailBody = await volumeDetail.json();
    assert.deepEqual(volumeDetailBody.results.image, expectedImage);

    const issues = await fetch(`${localUrl}/api/issues?field_list=id,name,description,character_credits&limit=1`);
    const issueBody = await issues.json();
    assert.equal(issueBody.results[0].id, 42);
    assert.equal(issueBody.results[0].name, "Witchblade #1");
    assert.equal(issueBody.results[0].description, "");
    assert.equal(Object.hasOwn(issueBody.results[0], "image"), false);
    assert.deepEqual(issueBody.results[0].character_credits, [{ id: 8, name: "Sara Pezzini" }]);
    for (const omitted of ["person_credits", "team_credits", "location_credits", "story_arc_credits", "associated_images", "issue_number"]) {
      assert.equal(Object.hasOwn(issueBody.results[0], omitted), false, `${omitted} should be omitted`);
    }

    const issueVolume = await fetch(`${localUrl}/api/issues?field_list=volume&limit=1`);
    const issueVolumeBody = await issueVolume.json();
    assert.deepEqual(issueVolumeBody.results[0].volume, {
      id: 7300,
      name: "Witchblade",
      api_detail_url: "https://comicvine.gamespot.com/api/volume/4050-7300/",
      site_detail_url: "https://example.test/witchblade"
    });

    const exactVolumeFilter = await fetch(`${localUrl}/api/issues?filter=volume:7300&field_list=id`);
    const exactVolumeBody = await exactVolumeFilter.json();
    assert.deepEqual(exactVolumeBody.results.map(({ id }) => id), [42]);

    const compositeVolumeFilter = await fetch(`${localUrl}/api/issues?filter=volume_id:4050-73001&field_list=id`);
    const compositeVolumeBody = await compositeVolumeFilter.json();
    assert.deepEqual(compositeVolumeBody.results.map(({ id }) => id), [43]);

    // SRV-27: a pipe-separated list of volume ids matches any of them (live ORs the tokens).
    const pipeVolumeFilter = await fetch(`${localUrl}/api/issues?filter=volume:7300|73001&field_list=id`);
    const pipeVolumeBody = await pipeVolumeFilter.json();
    assert.equal(pipeVolumeFilter.status, 200, JSON.stringify(pipeVolumeBody));
    assert.deepEqual(pipeVolumeBody.results.map(({ id }) => id), [42, 43]);

    const pipeVolumeIdFilter = await fetch(`${localUrl}/api/issues?filter=volume_id:7300|73001&field_list=id`);
    const pipeVolumeIdBody = await pipeVolumeIdFilter.json();
    assert.deepEqual(pipeVolumeIdBody.results.map(({ id }) => id), [42, 43]);

    // A domain-prefixed token and a plain token in the same list.
    const mixedPipeFilter = await fetch(`${localUrl}/api/issues?filter=volume:4050-7300|73001&field_list=id`);
    const mixedPipeBody = await mixedPipeFilter.json();
    assert.deepEqual(mixedPipeBody.results.map(({ id }) => id), [42, 43]);

    // A list containing a non-numeric token matches nothing (as on live).
    const invalidPipeFilter = await fetch(`${localUrl}/api/issues?filter=volume:7300|abc&field_list=id`);
    const invalidPipeBody = await invalidPipeFilter.json();
    assert.equal(invalidPipeFilter.status, 200, JSON.stringify(invalidPipeBody));
    assert.deepEqual(invalidPipeBody.results, []);

    // A single non-numeric value still throws (unchanged behavior).
    const invalidSingleFilter = await fetch(`${localUrl}/api/issues?filter=volume:abc&field_list=id`);
    assert.equal(invalidSingleFilter.status, 400);

    const search = await fetch(`${localUrl}/api/search?query=Witchblade&resources=volume,issue&field_list=id,name,image,resource_type`);
    const searchBody = await search.json();
    assert.deepEqual(searchBody.results.map(({ resource_type }) => resource_type).sort(), ["issue", "volume"]);
    const volumeSearch = searchBody.results.find((result) => result.resource_type === "volume");
    assert.deepEqual(volumeSearch.image, expectedImage);

    const unavailable = await fetch(`${localUrl}/api/teams`);
    assert.equal(unavailable.status, 404);
    assert.match((await unavailable.json()).error, /not available/i);
  } finally {
    await new Promise((resolve) => localServer.close(resolve));
    rmSync(localDirectory, { recursive: true, force: true });
  }
});

test("overrides the default and maximum limit via options", async () => {
  const overrideDirectory = mkdtempSync(path.join(os.tmpdir(), "comicvine-limit-test-"));
  const overrideDatabasePath = path.join(overrideDirectory, "limit.db");
  const overrideDatabase = new DatabaseSync(overrideDatabasePath);
  overrideDatabase.exec("CREATE TABLE cv_volume (id INTEGER PRIMARY KEY, name TEXT, site_detail_url TEXT)");
  for (const id of [1, 2, 3, 4, 5, 6]) {
   overrideDatabase.prepare("INSERT INTO cv_volume (id, name) VALUES (?, ?)").run(id, `Volume ${id}`);
  }
  overrideDatabase.close();

  const overrideServer = createApiServer(overrideDatabasePath, () => {}, {
   maxLimit: 6,
   defaultLimit: 3,
   searchDefaultLimit: 2
  });
  await new Promise((resolve) => overrideServer.listen(0, "127.0.0.1", resolve));
  const overrideUrl = `http://127.0.0.1:${overrideServer.address().port}`;

  try {
    // No limit requested uses the overridden default of 3 (not ComicVine's 100).
   const defaults = await fetch(`${overrideUrl}/api/volumes`);
   const defaultsBody = await defaults.json();
   assert.equal(defaultsBody.limit, 3);
   assert.equal(defaultsBody.results.length, 3);
   assert.equal(defaultsBody.number_of_total_results, 6);

    // A requested limit above the cap is clamped to maxLimit (6).
   const capped = await fetch(`${overrideUrl}/api/volumes?limit=10`);
   const cappedBody = await capped.json();
   assert.equal(cappedBody.limit, 6);
   assert.equal(cappedBody.results.length, 6);

    // A requested limit below the cap is honored.
   const exact = await fetch(`${overrideUrl}/api/volumes?limit=4`);
   const exactBody = await exact.json();
   assert.equal(exactBody.limit, 4);
   assert.equal(exactBody.results.length, 4);

    // The search default is independently overridable.
  const searchDefaults = await fetch(`${overrideUrl}/api/search?query=Volume&resources=volume`);
  const searchDefaultsBody = await searchDefaults.json();
  assert.equal(searchDefaultsBody.limit, 2);
  assert.equal(searchDefaultsBody.results.length, 2);
  } finally {
  await new Promise((resolve) => overrideServer.close(resolve));
  rmSync(overrideDirectory, { recursive: true, force: true });
  }
});

test("forces a limit that overrides a client-requested limit", async () => {
  const forcedServer = createApiServer(databasePath, () => {}, { searchForcedLimit: 2 });
  await new Promise((resolve) => forcedServer.listen(0, "127.0.0.1", resolve));
  const forcedUrl = `http://127.0.0.1:${forcedServer.address().port}`;

  try {
    // The forced value applies to search and overrides the client's limit.
  const search = await fetch(`${forcedUrl}/api/search?query=witchblade&resources=volume&limit=10`);
  const searchBody = await search.json();
  assert.equal(searchBody.limit, 2);

    // It does NOT affect list endpoints: the client-requested limit is honored.
  const list = await fetch(`${forcedUrl}/api/issues?limit=1`);
  const listBody = await list.json();
  assert.equal(listBody.limit, 1);
  assert.equal(listBody.results.length, 1);
  } finally {
  await new Promise((resolve) => forcedServer.close(resolve));
  }
});

test("serves a status endpoint with table counts, sync metadata, and request stats", async () => {
  const statusServer = createApiServer(databasePath, () => {});
  await new Promise((resolve) => statusServer.listen(0, "127.0.0.1", resolve));
  const statusUrl = `http://127.0.0.1:${statusServer.address().port}`;

  try {
    // Generate some traffic across list, detail, search, and a 404.
    await fetch(`${statusUrl}/api/volumes/?limit=1`);
    await fetch(`${statusUrl}/api/volume/7300/`);
    await fetch(`${statusUrl}/api/volume/9999/`);
    await fetch(`${statusUrl}/api/search/?query=witchblade`);
    await fetch(`${statusUrl}/api/nope/`);

    const response = await fetch(`${statusUrl}/api/status/`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.tables.cv_volume, 2);
    assert.equal(body.tables.cv_issue, 2);
    assert.equal(body.tables.cv_publisher, 2);

    // The test database has no cv_sync_metadata table, so it reports empty.
    assert.deepEqual(body.sync_metadata, []);

    assert.equal(body.total_requests, 5);
    const byEndpoint = Object.fromEntries(body.endpoints.map((entry) => [entry.endpoint, entry]));
    assert.equal(byEndpoint["/api/volumes/"].requests, 1);
    // Detail requests aggregate under one key, including the 404.
    // Both detail requests are HTTP 200: a missing id returns the 101 envelope
    // with a 200 status (matching the live API), so only /api/nope/ is a 404.
    assert.equal(byEndpoint["/api/volume/{id}/"].requests, 2);
    assert.equal(byEndpoint["/api/volume/{id}/"].status_codes["200"], 2);
    assert.equal(byEndpoint["/api/search/"].requests, 1);
    assert.equal(byEndpoint["/api/nope/"].status_codes["404"], 1);
    assert.ok(byEndpoint["/api/volumes/"].avg_duration_ms >= 0);
  } finally {
    await new Promise((resolve) => statusServer.close(resolve));
  }
});

test("diffs detail responses against the live API in validation mode", async () => {
  // The live fetch is injected so the test never touches the network. The fake
  // returns a live entity that matches the local volume 7300 except that its
  // name differs, so the validator should report a value diff on `name`.
  const liveVolume = {
    id: 7300,
    name: "Witchblade (2000)",
    aliases: "Witchblade (1995)",
    start_year: "1995",
    count_of_issues: 185,
    deck: "A supernatural series.",
    site_detail_url: "https://example.test/witchblade/",
    date_added: "1995-01-01 00:00:00",
    date_last_updated: "2020-04-15 10:00:00",
    character_credits: [{ id: 1, name: "Sara Pezzini" }],
    team_credits: [{ id: 2, name: "Witchblade Team" }]
  };
  const validateServer = createApiServer(databasePath, () => {}, {
    validate: true,
    fetchFn: async (singular, id) => liveVolume
  });
  await new Promise((resolve) => validateServer.listen(0, "127.0.0.1", resolve));
  const validateUrl = `http://127.0.0.1:${validateServer.address().port}`;

  try {
    const response = await fetch(`${validateUrl}/api/volume/7300/`);
    assert.equal(response.status, 200);
    const body = await response.json();

    // The envelope is unchanged; validation is an additional field.
    assert.equal(body.status_code, 1);
    assert.equal(body.results.name, "Witchblade");
    assert.equal(body.validation.status, "mismatch");
    assert.equal(body.validation.id, 7300);
    const diffFields = body.validation.diffs.map((diff) => diff.field);
    // `name` differs; date_added/date_last_updated and credits are ignored.
    assert.ok(diffFields.includes("name"));
    assert.ok(!diffFields.includes("date_added"));
    assert.ok(!diffFields.includes("character_credits"));
  } finally {
    await new Promise((resolve) => validateServer.close(resolve));
  }
});

test("reports a match when the live entity matches the local one", async () => {
  const matchingLive = {
    id: 7300,
    name: "Witchblade",
    aliases: "Witchblade (1995)",
    start_year: "1995",
    count_of_issues: 185,
    deck: "A supernatural series."
  };
  const validateServer = createApiServer(databasePath, () => {}, {
    validate: true,
    fetchFn: async (singular, id) => matchingLive
  });
  await new Promise((resolve) => validateServer.listen(0, "127.0.0.1", resolve));
  const validateUrl = `http://127.0.0.1:${validateServer.address().port}`;

  try {
    const body = await (await fetch(`${validateUrl}/api/volume/7300/`)).json();
    assert.equal(body.validation.status, "match");
    assert.deepEqual(body.validation.diffs, []);
  } finally {
    await new Promise((resolve) => validateServer.close(resolve));
  }
});

test("buildLiveUrl applies the ComicVine domain prefix (SRV-25)", () => {
  // The live API requires the domain-prefixed id form; a bare numeric id answers
  // 102 "Error in URL Format". The existing validation tests inject a fake
  // fetchFn and so never exercise this URL construction, which is why the bug
  // shipped. Assert the prefix directly for the known resource types.
  assert.equal(buildLiveUrl("issue", 2797), "https://comicvine.gamespot.com/api/issue/4000-2797/");
  assert.equal(buildLiveUrl("volume", 7300), "https://comicvine.gamespot.com/api/volume/4050-7300/");
  assert.equal(buildLiveUrl("publisher", 4), "https://comicvine.gamespot.com/api/publisher/4010-4/");
  assert.equal(buildLiveUrl("person", 1251), "https://comicvine.gamespot.com/api/person/4040-1251/");
  // Every resource in the prefix map yields a domain-prefixed path.
  for (const [singular, prefix] of Object.entries(DOMAIN_PREFIXES)) {
    assert.equal(buildLiveUrl(singular, 1), `https://comicvine.gamespot.com/api/${singular}/${prefix}-1/`);
  }
});

test("buildApiDetailUrl derives the canonical api_detail_url (SRV-21)", () => {
  // The live API's api_detail_url is exactly the URL the validator fetches:
  // base URL + resource type + domain-prefixed id.
  assert.equal(buildApiDetailUrl("publisher", 4), "https://comicvine.gamespot.com/api/publisher/4010-4/");
  assert.equal(buildApiDetailUrl("issue", 2797), "https://comicvine.gamespot.com/api/issue/4000-2797/");
  assert.equal(buildApiDetailUrl("volume", 7300), "https://comicvine.gamespot.com/api/volume/4050-7300/");
  assert.equal(buildApiDetailUrl("person", 1251), "https://comicvine.gamespot.com/api/person/4040-1251/");
  // A resource with no verified domain prefix cannot be derived.
  assert.equal(buildApiDetailUrl("character", 17), null);
});

test("parseBoolFlag treats 0/false/no/off as off and 1/true/yes/on as on (SRV-25)", () => {
  // The SRV-25 gotcha: a plain truthiness test treats the string "0" as enabled,
  // so COMICVINE_VALIDATE=0 (the README's "off" spelling) actually turned
  // validation on. Only an explicit on-spelling enables an opt-in flag.
  assert.equal(parseBoolFlag("0"), false);
  assert.equal(parseBoolFlag("false"), false);
  assert.equal(parseBoolFlag("no"), false);
  assert.equal(parseBoolFlag("off"), false);
  assert.equal(parseBoolFlag(""), false);
  assert.equal(parseBoolFlag(undefined), false);
  assert.equal(parseBoolFlag("1"), true);
  assert.equal(parseBoolFlag("true"), true);
  assert.equal(parseBoolFlag("yes"), true);
  assert.equal(parseBoolFlag("on"), true);
  // Case- and whitespace-insensitive.
  assert.equal(parseBoolFlag("TRUE"), true);
  assert.equal(parseBoolFlag(" Off "), false);
});

test("excludes blocked publishers from volume search and list (SRV-12)", async () => {
  const blockDirectory = mkdtempSync(path.join(os.tmpdir(), "comicvine-blocklist-test-"));
  const blockDatabasePath = path.join(blockDirectory, "blocklist.db");
  const blockDatabase = new DatabaseSync(blockDatabasePath);
  blockDatabase.exec(`
    CREATE TABLE cv_publisher (id INTEGER PRIMARY KEY, name TEXT, site_detail_url TEXT);
    CREATE TABLE cv_volume (
      id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, start_year TEXT,
      publisher_id INTEGER, count_of_issues INTEGER, description TEXT,
      image_url TEXT, site_detail_url TEXT
    );
  `);
  blockDatabase.prepare("INSERT INTO cv_publisher VALUES (?, ?, ?)").run(31, "Top Cow", "https://example.test/top-cow");
  blockDatabase.prepare("INSERT INTO cv_publisher VALUES (?, ?, ?)").run(42, "Dark Horse", "https://example.test/dark-horse");
  blockDatabase.prepare("INSERT INTO cv_volume VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(7300, "Top Cow Book", null, "1995", 31, 5, null, null, "https://example.test/top-cow-book");
  blockDatabase.prepare("INSERT INTO cv_volume VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(7301, "Dark Horse Book", null, "1996", 42, 3, null, null, "https://example.test/dark-horse-book");
  blockDatabase.close();

  const blockServer = createApiServer(blockDatabasePath, () => {}, { publisherBlocklist: [42] });
  await new Promise((resolve) => blockServer.listen(0, "127.0.0.1", resolve));
  const blockUrl = `http://127.0.0.1:${blockServer.address().port}`;

  try {
    // Search: the blocked publisher's volume is excluded; the unblocked one remains.
    const search = await (await fetch(`${blockUrl}/api/search/?query=Book&resources=volume&limit=10`)).json();
    const searchIds = search.results.map((result) => result.id);
    assert.deepEqual(searchIds, [7300]);
    assert.equal(search.number_of_total_results, 1);

    // List: same exclusion applies when no explicit publisher filter is present.
    const list = await (await fetch(`${blockUrl}/api/volumes?limit=10&field_list=id`)).json();
    assert.deepEqual(list.results.map((result) => result.id), [7300]);

    // An explicit publisher filter overrides the blocklist (both volumes return).
    const filtered = await (await fetch(`${blockUrl}/api/volumes?filter=publisher_id:42&limit=10&field_list=id`)).json();
    assert.deepEqual(filtered.results.map((result) => result.id), [7301]);
  } finally {
    await new Promise((resolve) => blockServer.close(resolve));
    rmSync(blockDirectory, { recursive: true, force: true });
  }
});

// ─── SRV-13: API-key authentication ──────────────────────────────────────────

function makeAuthTestDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "comicvine-auth-test-"));
  const dbPath = path.join(dir, "auth.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE cv_publisher (id INTEGER PRIMARY KEY, name TEXT, site_detail_url TEXT);
    CREATE TABLE cv_volume (
      id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, start_year TEXT,
      publisher_id INTEGER, count_of_issues INTEGER, description TEXT,
      image_url TEXT, site_detail_url TEXT, character_credits TEXT, team_credits TEXT,
      date_added TEXT, date_last_updated TEXT, deck TEXT
    );
  `);
  db.prepare("INSERT INTO cv_volume (id, name, date_added) VALUES (?, ?, ?)").run(7300, "Witchblade", "2020-04-15 10:00:00");
  db.close();
  return { dir, dbPath };
}

test("serves unauthenticated when no API keys are configured (SRV-13)", async () => {
  const { dir, dbPath } = makeAuthTestDb();
  const srv = createApiServer(dbPath, () => {});
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const res = await fetch(`${url}/api/volumes?limit=10`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status_code, 1);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects resource requests without a valid key when auth is enabled (SRV-13)", async () => {
  const { dir, dbPath } = makeAuthTestDb();
  const srv = createApiServer(dbPath, () => {}, { apiKeys: ["good-key", "another-key"] });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    // No key at all -> 401, invalid key -> 401.
    for (const path of [`${url}/api/volumes?limit=1`, `${url}/api/volumes?limit=1&api_key=wrong`, `${url}/api/search/?query=blade&resources=volume`]) {
      const res = await fetch(path);
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.status_code, 100);
      assert.match(body.error, /API key/i);
    }
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepts a valid key via query param, header, or Authorization (SRV-13)", async () => {
  const { dir, dbPath } = makeAuthTestDb();
  const srv = createApiServer(dbPath, () => {}, { apiKeys: ["good-key", "another-key"] });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    // Query parameter.
    const q = await fetch(`${url}/api/volumes?limit=1&api_key=good-key`);
    assert.equal(q.status, 200);
    assert.equal((await q.json()).status_code, 1);

    // X-Api-Key header.
    const h = await fetch(`${url}/api/volumes?limit=1`, { headers: { "X-Api-Key": "another-key" } });
    assert.equal(h.status, 200);
    assert.equal((await h.json()).status_code, 1);

    // Authorization Bearer header.
    const b = await fetch(`${url}/api/volumes?limit=1`, { headers: { Authorization: "Bearer good-key" } });
    assert.equal(b.status, 200);
    assert.equal((await b.json()).status_code, 1);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leaves the /api index and /api/status open even when auth is enabled (SRV-13)", async () => {
  const { dir, dbPath } = makeAuthTestDb();
  const srv = createApiServer(dbPath, () => {}, { apiKeys: ["good-key"] });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const index = await fetch(`${url}/api`);
    assert.equal(index.status, 200);
    const status = await fetch(`${url}/api/status`);
    assert.equal(status.status, 200);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("is permissive CORS by default when no origins are configured (SRV-14)", async () => {
    const { dir, dbPath } = makeAuthTestDb();
    const srv = createApiServer(dbPath, () => {});
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${srv.address().port}`;
    try {
      // A request carrying an Origin still gets the permissive "*" grant.
      const res = await fetch(`${url}/api/volumes?limit=1`, { headers: { Origin: "http://app.example" } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      assert.equal(res.headers.get("vary"), null);

      // Preflight returns 204 with the permissive grant and the method/header allowlist.
      const pre = await fetch(`${url}/api/volumes?limit=1`, {
        method: "OPTIONS",
        headers: { Origin: "http://app.example" }
      });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers.get("access-control-allow-origin"), "*");
      assert.match(pre.headers.get("access-control-allow-methods"), /GET/);
      assert.match(pre.headers.get("access-control-allow-headers"), /X-Api-Key/);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
});

test("restricts CORS to matching origins from an allowlist (SRV-14)", async () => {
    const { dir, dbPath } = makeAuthTestDb();
    const srv = createApiServer(dbPath, () => {}, { corsOrigins: ["http://app.example", "http://other.example"] });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${srv.address().port}`;
    try {
      // A matching Origin is echoed, with Vary: Origin so caches key by origin.
      const allowed = await fetch(`${url}/api/volumes?limit=1`, { headers: { Origin: "http://app.example" } });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get("access-control-allow-origin"), "http://app.example");
      assert.equal(allowed.headers.get("vary"), "Origin");

      // A non-matching Origin gets no Access-Control-Allow-Origin grant (only Vary),
      // so the browser blocks the read even though the response is 200.
      const denied = await fetch(`${url}/api/volumes?limit=1`, { headers: { Origin: "http://evil.example" } });
      assert.equal(denied.status, 200);
      assert.equal(denied.headers.get("access-control-allow-origin"), null);
      assert.equal(denied.headers.get("vary"), "Origin");

      // No Origin header at all: no Access-Control-Allow-Origin grant, but Vary is
      // still emitted so a cache keys by Origin (a cross-origin request would differ).
      const noOrigin = await fetch(`${url}/api/volumes?limit=1`);
      assert.equal(noOrigin.status, 200);
      assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);
      assert.equal(noOrigin.headers.get("vary"), "Origin");

      // Preflight honors the same allowlist.
      const pre = await fetch(`${url}/api/volumes?limit=1`, {
        method: "OPTIONS",
        headers: { Origin: "http://app.example" }
      });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers.get("access-control-allow-origin"), "http://app.example");
    } finally {
      await new Promise((resolve) => srv.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
});

test("applies the configured CORS grant to XML and JSONP responses (SRV-14)", async () => {
    const { dir, dbPath } = makeAuthTestDb();
    const srv = createApiServer(dbPath, () => {}, { corsOrigins: ["http://app.example"] });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${srv.address().port}`;
    try {
      const xml = await fetch(`${url}/api/volume/7300/?format=xml`, { headers: { Origin: "http://app.example" } });
      assert.equal(xml.status, 200);
      assert.equal(xml.headers.get("access-control-allow-origin"), "http://app.example");

      const denXml = await fetch(`${url}/api/volume/7300/?format=xml`, { headers: { Origin: "http://evil.example" } });
      assert.equal(denXml.status, 200);
      assert.equal(denXml.headers.get("access-control-allow-origin"), null);

      const jsonp = await fetch(`${url}/api/volume/7300/?format=jsonp&json_callback=cb`, { headers: { Origin: "http://app.example" } });
      assert.equal(jsonp.status, 200);
      assert.equal(jsonp.headers.get("access-control-allow-origin"), "http://app.example");
    } finally {
      await new Promise((resolve) => srv.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
});

test("emits every stored issue field (SRV-19)", async () => {
  const srv19Directory = mkdtempSync(path.join(os.tmpdir(), "comicvine-srv19-test-"));
  const srv19DatabasePath = path.join(srv19Directory, "srv19.db");
  const srv19Database = new DatabaseSync(srv19DatabasePath);
  srv19Database.exec(`
    CREATE TABLE cv_volume (
      id INTEGER PRIMARY KEY, name TEXT, api_detail_url TEXT, site_detail_url TEXT
    );
    CREATE TABLE cv_issue (
      id INTEGER PRIMARY KEY, volume_id INTEGER, name TEXT, issue_number TEXT,
      cover_date TEXT, store_date TEXT, description TEXT, image_url TEXT,
      site_detail_url TEXT, character_credits TEXT, person_credits TEXT,
      team_credits TEXT, location_credits TEXT, story_arc_credits TEXT,
      associated_images TEXT, aliases TEXT, api_detail_url TEXT, deck TEXT,
      date_added TEXT, date_last_updated TEXT, object_credits TEXT,
      concept_credits TEXT, character_died_in TEXT, team_disbanded_in TEXT,
      first_appearance_characters TEXT, first_appearance_concepts TEXT,
      first_appearance_locations TEXT, first_appearance_objects TEXT,
      first_appearance_storyarcs TEXT, first_appearance_teams TEXT,
      has_staff_review INTEGER
    );
  `);
  srv19Database.prepare("INSERT INTO cv_volume (id, name, api_detail_url, site_detail_url) VALUES (?, ?, ?, ?)")
    .run(7300, "Strange Adventures", "https://comicvine.gamespot.com/api/volume/4050-7300/", "https://comicvine.gamespot.com/comics/strange-adventures/");
  const deck = "The Man-Ape thinks he will be the cleverest of all if he manages to read three books!";
  const imageUrl = "https://comicvine.gamespot.com/a/uploads/original/0/4/2582-1328-2797-1-strange-adventures.jpg";
  srv19Database.prepare(`
    INSERT INTO cv_issue (
      id, volume_id, name, issue_number, cover_date, store_date, description, image_url,
      site_detail_url, character_credits, person_credits, team_credits, location_credits,
      story_arc_credits, associated_images, aliases, api_detail_url, deck, date_added,
      date_last_updated, object_credits, concept_credits, character_died_in,
      team_disbanded_in, first_appearance_characters, first_appearance_concepts,
      first_appearance_locations, first_appearance_objects, first_appearance_storyarcs,
      first_appearance_teams, has_staff_review)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(2797, 7300, null, "1", "1993-09-01", null, "A full description.", imageUrl,
      "https://comicvine.gamespot.com/comics/1-strange-adventures/4000-2797/",
      J([{ id: 1, name: "Hulk" }]), J([{ id: 2, name: "An Artist" }]), J([]), J([]), J([]),
      J([{ id: 3, original_url: imageUrl, caption: null, image_tags: "All Images" }]),
      null, "https://comicvine.gamespot.com/api/issue/4000-2797/", deck,
      "2008-06-06 11:09:57", "2022-07-12 02:21:13", J([]), J([]), J([]), J([]),
      J([{ id: 4, name: "A Character" }]), J([]), J([]), J([]), J([]), J([]), 0);
  // A live review object is stored as JSON text by the updater's jsonify.
  const review = {
    id: 4457,
    name: "Aquaman #1 Review",
    api_detail_url: "https://comicvine.gamespot.com/api/review/1900-4457/",
    site_detail_url: "https://comicvine.gamespot.com/reviews/aquaman-1/1900-4457/"
  };
  srv19Database.prepare("INSERT INTO cv_issue (id, name, has_staff_review) VALUES (?, ?, ?)")
    .run(537207, "Aquaman #1", J(review));
  // A row synced before the ALTER migration: the added columns are all NULL.
  srv19Database.prepare("INSERT INTO cv_issue (id, name, image_url) VALUES (?, ?, ?)")
    .run(1153517, "A New Issue", null);
  srv19Database.close();

  const srv19Server = createApiServer(srv19DatabasePath, () => {});
  await new Promise((resolve) => srv19Server.listen(0, "127.0.0.1", resolve));
  const srv19Url = `http://127.0.0.1:${srv19Server.address().port}`;

  try {
    // F2 repro: a field_list for a stored field returns the value, not null.
    const deckResponse = await fetch(`${srv19Url}/api/issue/4000-2797/?field_list=deck`);
    const deckBody = await deckResponse.json();
    assert.equal(deckResponse.status, 200);
    assert.equal(deckBody.results.deck, deck);

    const detailBody = await (await fetch(`${srv19Url}/api/issue/4000-2797/`)).json();
    const result = detailBody.results;
    // Exactly the 31 keys the live API returns for an issue.
    assert.deepEqual(Object.keys(result).sort(), [
      "aliases", "api_detail_url", "associated_images", "character_credits",
      "character_died_in", "concept_credits", "cover_date", "date_added",
      "date_last_updated", "deck", "description", "first_appearance_characters",
      "first_appearance_concepts", "first_appearance_locations",
      "first_appearance_objects", "first_appearance_storyarcs",
      "first_appearance_teams", "has_staff_review", "id", "image", "issue_number",
      "location_credits", "name", "object_credits", "person_credits",
      "site_detail_url", "store_date", "story_arc_credits", "team_credits",
      "team_disbanded_in", "volume"
    ]);
    assert.equal(result.name, null);
    assert.equal(result.deck, deck);
    assert.equal(result.has_staff_review, false);
    assert.deepEqual(result.volume, {
      id: 7300,
      name: "Strange Adventures",
      api_detail_url: "https://comicvine.gamespot.com/api/volume/4050-7300/",
      site_detail_url: "https://comicvine.gamespot.com/comics/strange-adventures/"
    });
    assert.deepEqual(result.character_credits, [{ id: 1, name: "Hulk" }]);
    assert.deepEqual(result.first_appearance_characters, [{ id: 4, name: "A Character" }]);
    assert.equal(result.image.original_url, imageUrl);
    assert.equal(result.image.image_tags, "All Images");
    assert.equal(result.image.icon_url, imageUrl.replace("/original/", "/square_avatar/"));
    assert.equal(Object.keys(result.image).length, 10);

    // The JSON-text review ref parses back to the live object shape.
    const reviewBody = await (await fetch(`${srv19Url}/api/issue/4000-537207/`)).json();
    assert.deepEqual(reviewBody.results.has_staff_review, review);
    assert.equal(reviewBody.results.image, null);

    // Pre-ALTER row: the columns exist but are NULL, so the keys are present
    // with null values (matching the live API for these rows).
    const newBody = await (await fetch(`${srv19Url}/api/issue/4000-1153517/`)).json();
    assert.equal(newBody.results.has_staff_review, null);
    assert.equal(newBody.results.deck, null);
    assert.equal(newBody.results.image, null);
    assert.equal(Object.keys(newBody.results).length, 31);

    // The list endpoint emits the same fields per row.
    const listBody = await (await fetch(`${srv19Url}/api/issues/?field_list=id,deck,has_staff_review,image`)).json();
    assert.equal(listBody.number_of_total_results, 3);
    const byId = Object.fromEntries(listBody.results.map((item) => [item.id, item]));
    assert.equal(byId[2797].deck, deck);
    assert.equal(byId[2797].has_staff_review, false);
    assert.equal(byId[2797].image.original_url, imageUrl);
    assert.deepEqual(byId[537207].has_staff_review, review);
    assert.equal(byId[537207].image, null);
    assert.equal(byId[1153517].deck, null);
    assert.equal(byId[1153517].has_staff_review, null);
  } finally {
    await new Promise((resolve) => srv19Server.close(resolve));
    rmSync(srv19Directory, { recursive: true, force: true });
  }
});