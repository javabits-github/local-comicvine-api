const assert = require("node:assert/strict");
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