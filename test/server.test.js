const assert = require("node:assert/strict");
const fs = require("node:fs");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createApiServer } = require("../src/server");

const directory = mkdtempSync(path.join(os.tmpdir(), "comicvine-api-test-"));
const databasePath = path.join(directory, "test.db");
const database = new DatabaseSync(databasePath);
const J = (value) => JSON.stringify(value);
database.exec("CREATE TABLE cv_publisher (id INTEGER PRIMARY KEY, name TEXT, image_url TEXT, site_detail_url TEXT, aliases TEXT, date_added TEXT, location_address TEXT, location_city TEXT, location_state TEXT, characters TEXT, story_arcs TEXT, teams TEXT, volumes TEXT)");
database.exec("CREATE TABLE cv_volume (id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, start_year TEXT, publisher_id INTEGER, count_of_issues INTEGER, description TEXT, image_url TEXT, site_detail_url TEXT, character_credits TEXT, team_credits TEXT, date_added TEXT, date_last_updated TEXT, deck TEXT)");
database.exec("CREATE TABLE cv_issue (id INTEGER PRIMARY KEY, volume_id INTEGER, name TEXT, issue_number TEXT, cover_date TEXT, store_date TEXT, description TEXT, image_url TEXT, site_detail_url TEXT, character_credits TEXT, person_credits TEXT, team_credits TEXT, location_credits TEXT, story_arc_credits TEXT, associated_images TEXT)");
database.exec("CREATE TABLE cv_team (id INTEGER PRIMARY KEY, name TEXT, count_of_team_members INTEGER, date_added TEXT, date_last_updated TEXT, first_appeared_in_issue TEXT, publisher TEXT, site_detail_url TEXT, character_enemies TEXT, character_friends TEXT, characters TEXT, disbanded_in_issues TEXT, issue_credits TEXT, issues_disbanded_in TEXT, movies TEXT, story_arc_credits TEXT, volume_credits TEXT)");
database.exec("CREATE TABLE cv_storyarc (id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, count_of_issue_appearances INTEGER, date_added TEXT, first_appeared_in_issue TEXT, publisher TEXT, site_detail_url TEXT, issues TEXT, movies TEXT)");
database.exec("CREATE TABLE cv_person (id INTEGER PRIMARY KEY, name TEXT, aliases TEXT, birth TEXT, count_of_issue_appearances INTEGER, country TEXT, date_added TEXT, death TEXT, gender TEXT, hometown TEXT, email TEXT, website TEXT, created_characters TEXT, issue_credits TEXT, story_arc_credits TEXT, volume_credits TEXT, site_detail_url TEXT)");
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
database.prepare("INSERT INTO cv_team (id, name, count_of_team_members, date_added, first_appeared_in_issue, publisher, site_detail_url, character_enemies, character_friends, characters, disbanded_in_issues, issue_credits, issues_disbanded_in, movies, story_arc_credits, volume_credits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .    run(1800, "The Hand", 93, "2020-04-15 10:00:00", J({ id: 20965, name: "Elektra", issue_number: "168" }), J({ id: 31, name: "Marvel" }), "https://example.test/the-hand/", J([]), J([]), J([]), J([]), J([]), J([]), J([]), J([]), J([]));
database.prepare("INSERT INTO cv_team (id, name, date_added) VALUES (?, ?, ?)")
    .run(1801, "Avengers", "1899-01-01 00:00:00");
database.prepare("INSERT INTO cv_storyarc (id, name, aliases, count_of_issue_appearances, date_added, first_appeared_in_issue, publisher, site_detail_url, issues, movies) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(3000, "Secret Wars", "Secret Wars (1984)", 12, "2020-04-15 10:00:00", J({ id: 12345, name: "Marvel Super Heroes Secret Wars", issue_number: "1" }), J({ id: 31, name: "Marvel" }), "https://example.test/secret-wars/", J([{ id: 12345, name: "Marvel Super Heroes Secret Wars", issue_number: "1" }]), J([]));
database.prepare("INSERT INTO cv_storyarc (id, name, date_added) VALUES (?, ?, ?)")
    .run(3001, "Civil War", "1899-01-01 00:00:00");
database.prepare("INSERT INTO cv_person (id, name, aliases, birth, count_of_issue_appearances, country, date_added, death, gender, hometown, email, website, created_characters, issue_credits, story_arc_credits, volume_credits, site_detail_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(1251, "Barry Kitson", "Barry Kitson (artist)", null, 180, "United Kingdom", "2020-04-15 10:00:00", null, "Male", "Leicester", "barry@example.test", "https://example.test/barry", J([{ id: 9081, name: "The Amazing Bug" }]), J([]), J([]), J([{ id: 120, name: "Sample Volume" }]), "https://example.test/barry-kitson/");
database.prepare("INSERT INTO cv_person (id, name, date_added) VALUES (?, ?, ?)")
    .run(1252, "Alex Ross", "1899-01-01 00:00:00");
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
  assert.equal(Object.hasOwn(listBody.results[0], "image"), false);

  const filtered = await fetch(`${baseUrl}/api/issues/?filter=name:Test`);
  const filteredBody = await filtered.json();
  assert.equal(filteredBody.number_of_total_results, 1);
  assert.equal(filteredBody.results[0].id, 42);

  const detail = await fetch(`${baseUrl}/api/issue/4000-42/`);
  const detailBody = await detail.json();
  assert.equal(detail.status, 200);
  assert.equal(detailBody.results.name, "The Test Issue");
  assert.equal(detailBody.results.description, "");
  assert.equal(Object.hasOwn(detailBody.results, "image"), false);

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
  assert.equal(Object.hasOwn(searchBody.results[0], "image"), false);

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
  const response = await fetch(`${baseUrl}/api/teams?format=json&sort=name:desc&limit=1&field_list=id,name,count_of_team_members,publisher,first_appeared_in_issue`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.number_of_total_results, 2);
  assert.deepEqual(body.results, [{
    id: 1800,
    name: "The Hand",
    count_of_team_members: 93,
    publisher: { id: 31, name: "Marvel" },
    first_appeared_in_issue: { id: 20965, name: "Elektra", issue_number: "168" }
  }]);

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
  const fields = "id,name,character_enemies,character_friends,characters,disbanded_in_issues,first_appeared_in_issue,issue_credits,issues_disbanded_in,movies,story_arc_credits,volume_credits";
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
    issues_disbanded_in: [],
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
    gender: "Male",
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
  const fields = "id,name,created_characters,issue_credits,story_arc_credits,volume_credits";
  const response = await fetch(`${baseUrl}/api/person/4040-1251/?format=json&field_list=${fields}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results, {
    id: 1251,
    name: "Barry Kitson",
    created_characters: [{ id: 9081, name: "The Amazing Bug" }],
    issue_credits: [],
    story_arc_credits: [],
    volume_credits: [{ id: 120, name: "Sample Volume" }]
  });

  const xml = await fetch(`${baseUrl}/api/person/4040-1251/?format=xml&field_list=id,name,issue_credits`);
  assert.match(xml.headers.get("content-type"), /application\/xml/);
  assert.match(await xml.text(), /<issue_credits><\/issue_credits>/);
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