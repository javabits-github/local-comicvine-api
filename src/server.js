const { createServer } = require("node:http");
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");
const { resourceConfig, buildApiDetailUrl } = require("./fieldConfig.js");
const { validateEntity } = require("./validate.js");

// Map API resource names to their database table and collection path.
const resources = {
  character: { table: "cv_character", plural: "characters" },
  concept: { table: "cv_concept", plural: "concepts" },
  issue: { table: "cv_issue", plural: "issues" },
  location: { table: "cv_location", plural: "locations" },
  object: { table: "cv_object", plural: "objects" },
  person: { table: "cv_person", plural: "people" },
  power: { table: "cv_power", plural: "powers" },
  publisher: { table: "cv_publisher", plural: "publishers" },
  story_arc: { table: "cv_storyarc", plural: "story_arcs" },
  team: { table: "cv_team", plural: "teams" },
  volume: { table: "cv_volume", plural: "volumes" }
};
const sortableTeamFields = new Set([
  "aliases", "count_of_issue_appearances", "count_of_isssue_appearances", "count_of_team_members", "date_added",
  "date_last_updated", "deck", "description", "id", "name", "site_detail_url"
]);
const sortableStoryArcFields = new Set([
  "aliases", "count_of_issue_appearances", "date_added", "date_last_updated",
  "deck", "description", "id", "name", "site_detail_url"
]);
const sortableConceptFields = new Set([
  "aliases", "count_of_issue_appearances", "date_added", "date_last_updated",
  "deck", "description", "id", "name", "site_detail_url", "start_year"
]);
const sortablePublisherFields = new Set([
  "aliases", "date_added", "date_last_updated", "deck", "description", "id", "name",
  "site_detail_url"
]);
const sortablePersonFields = new Set([
  "aliases", "birth", "count_of_issue_appearances", "count_of_isssue_appearances", "country",
  "date_added", "date_last_updated", "death", "deck", "description", "gender", "hometown", "id", "name"
]);
const sortableVolumeFields = new Set([
  "aliases", "count_of_issues", "date_added", "date_last_updated", "deck",
  "description", "id", "name", "site_detail_url", "start_year"
]);
const sortableIssueFields = new Set([
  "aliases", "cover_date", "date_added", "date_last_updated", "deck",
  "description", "id", "issue_number", "name", "store_date"
]);

// SRV-1: the allowlist of sortable fields per resource for the list endpoint.
// Volumes and issues have their own Sets above (issues also sort on issue_number
// and the date columns); the remaining resources map to their allowlists here.
const sortableFieldsByResource = {
  issue: sortableIssueFields,
  person: sortablePersonFields,
  publisher: sortablePublisherFields,
  story_arc: sortableStoryArcFields,
  team: sortableTeamFields,
  volume: sortableVolumeFields,
  concept: sortableConceptFields
};

// SRV-1: the default sort column each list endpoint uses when the client does not
// pass ?sort=. All default to "id" to match the live ComicVine API (and existing
// behavior/tests); the `defaultSort` option on createApiServer (a field name or a
// per-resource map) can override it, e.g. { volume: "name" } or { issue: "issue_number" }.
const defaultSortByResource = {
  issue: "id",
  person: "id",
  publisher: "id",
  story_arc: "id",
  team: "id",
  volume: "id",
  concept: "id"
};

// Per-resource field allowlist and relationship sets live in fieldConfig.js, shared
// with the live-API validator (src/validate.js).

// Project a built result to a field_list. Requested fields that are present pass
// through; absent relationships default to [] and absent scalars to null.
function projectResult(singular, result, fieldList) {
  if (!fieldList) return result;
  const config = resourceConfig[singular];
  const fields = fieldList.split(",").map((field) => field.trim()).filter((field) => config.fields.has(field));
  return Object.fromEntries(fields.map((field) => [
  field,
  Object.hasOwn(result, field) ? result[field] : config.relationships.has(field) ? [] : null
  ]));
}

// These search options are valid API resources but have no local database tables.
const searchOnlyResources = new Map([
  ["origin", { singular: "origin", table: null }],
  ["video", { singular: "video", table: null }]
]);

// Cached list of column names for a table; lets response builders skip missing columns.
function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

// Credit and relationship arrays are stored as JSON-text columns and parsed in JS;
// no JSON is synthesized, parsed, or matched in SQL.
function parseCredits(value) {
  if (value === null || value === undefined) return null;
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : null;
}

// A JSON-text column holds either a parsed value or SQL NULL; undefined means the
// column does not exist at all, so callers can omit the key and let projectors default.
function parseJsonColumn(value) {
  if (value === null || value === undefined) return undefined;
  return JSON.parse(value);
}

// SRV-19: has_staff_review is one column holding three shapes — 0 (the live
// boolean false, coerced by the updater's jsonify), SQL NULL (rows synced before
// the column existed), and a JSON-text review object. The live API returns
// boolean false or a review object, so normalize on output.
function parseStaffReview(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed === 0 || parsed === false ? false : parsed;
    } catch {
      return value;
    }
  }
  return value === 0 ? false : Boolean(value);
}

// SRV-20: cv_person.gender is TEXT and preserves float spellings ("0.0", "1.0");
// the live API emits a number, so coerce on output. NULL becomes null and a
// non-numeric value passes through so a stray value never breaks a response.
function parseGender(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

// SRV-6c: the six volume credit collections, in a fixed order shared with the
// updater. Bit i of cv_volume.credits_presence marks whether that collection was a
// non-null array before the JSON columns were replaced by the cv_volume_credit join
// table, so the server can distinguish an empty [] from a null collection.
const VOLUME_CREDIT_TYPES = ["character", "concept", "location", "object", "person", "team"];

// Rebuild a credit entry with the exact key order the live API emitted
// (id, name, count, api_detail_url, site_detail_url) so serialized output is unchanged.
function creditRowToObject(row) {
  return {
    id: row.credit_id,
    name: row.name,
    count: row.count,
    api_detail_url: row.api_detail_url,
    site_detail_url: row.site_detail_url
  };
}

// Rebuild a first/last issue reference honoring the stored key order, so the two
// historical key-order variants (id-first vs api_detail_url-first) serialize byte-for-byte.
// The display fields (name/issue_number/api_detail_url) come from the joined cv_issue
// row; the id is the ref's own issue_id (so a ref whose issue isn't synced locally still
// emits its id, with the joined fields null).
function issueRefRowToObject(row) {
  const values = {
    id: row.issue_id,
    name: row.name,
    issue_number: row.issue_number,
    api_detail_url: row.api_detail_url
  };
  let keys = Object.keys(values);
  if (row.key_order) {
    try { keys = JSON.parse(row.key_order); } catch { /* keep the default order */ }
  }
  const result = {};
  for (const key of keys) result[key] = values[key];
  return result;
}

// Build a volume result, generating the credit collections and first/last issue
// references from the SRV-6c join tables. Used only when those tables exist; the
// JSON-column path in buildResult remains the fallback (e.g. test fixtures).
function buildVolumeResult(row, database) {
  const result = buildResult(row, "volume");

  const creditRows = database
    .prepare("SELECT * FROM cv_volume_credit WHERE volume_id = ? ORDER BY credit_type, position")
    .all(row.id);
  const creditsByType = {};
  for (const credit of creditRows) {
    (creditsByType[credit.credit_type] ??= []).push(credit);
  }
  const mask = row.credits_presence ?? 0;
  VOLUME_CREDIT_TYPES.forEach((type, i) => {
    const field = `${type}_credits`;
    result[field] = mask & (1 << i)
      ? (creditsByType[type] ?? []).map(creditRowToObject)
      : null;
  });

  // The ref row holds only the issue id + key order; the display fields are
  // resolved from cv_issue. A LEFT JOIN keeps a ref whose issue isn't synced
  // locally (the DB is a subset) rather than dropping it — the joined fields
  // come back null in that case.
  const refRows = database
    .prepare(
      `SELECT r.ref_type, r.issue_id, r.key_order,
              i.name, i.issue_number, i.api_detail_url
         FROM cv_volume_issue_ref r
         LEFT JOIN cv_issue i ON i.id = r.issue_id
        WHERE r.volume_id = ?`
    )
    .all(row.id);
  for (const field of ["first_issue", "last_issue"]) {
    const kind = field === "first_issue" ? "first" : "last";
    const found = refRows.find((r) => r.ref_type === kind);
    // Match parseJsonColumn: an absent reference is undefined (omitted from JSON),
    // not null, so the output matches the legacy JSON-column path.
    result[field] = found ? issueRefRowToObject(found) : undefined;
  }

  return result;
}

function buildResult(row, singular) {
  const has = (name) => Object.hasOwn(row, name);
  if (singular === "volume") {
  const publisher = has("publisher_id") && row.publisher_id !== null
     ? { id: row.publisher_id, name: row.publisher_name ?? null }
     : null;
  const result = {
    id: row.id,
    name: row.name,
    aliases: has("aliases") ? row.aliases : null,
    start_year: has("start_year") ? row.start_year : null,
    count_of_issues: has("count_of_issues") ? row.count_of_issues : null,
    description: has("description") ? row.description : null,
    image: row.image_url ? { original_url: row.image_url } : null,
    site_detail_url: has("site_detail_url") ? row.site_detail_url : null,
    publisher
    };
  // Additional stored volume fields, copied when the column is present so a
  // field_list request returns the value instead of the null default.
  for (const field of ["deck", "date_added", "date_last_updated", "api_detail_url"]) {
   if (has(field)) result[field] = row[field];
   }
  for (const credit of ["character_credits", "concept_credits", "location_credits", "object_credits", "person_credits", "team_credits"]) {
  if (has(credit)) result[credit] = parseCredits(row[credit]);
  }
  // first_issue/last_issue are stored as JSON objects, like first_appeared_in_issue.
  for (const field of ["first_issue", "last_issue"]) {
   if (has(field)) result[field] = parseJsonColumn(row[field]);
   }
  return result;
  }
  if (singular === "issue") {
  const volume = row.volume_id === null || row.volume_id === undefined
     ? null
      : {
      id: row.volume_id,
      name: row.volume_name ?? null,
      api_detail_url: row.volume_api_detail_url ?? buildApiDetailUrl("volume", row.volume_id),
      site_detail_url: row.volume_site_detail_url ?? null
      };
  const result = {
    id: row.id,
    name: row.name,
    issue_number: row.issue_number,
    cover_date: row.cover_date,
    store_date: row.store_date,
    description: row.description,
    site_detail_url: row.site_detail_url,
    volume,
    character_credits: parseCredits(row.character_credits),
    person_credits: parseCredits(row.person_credits),
    team_credits: parseCredits(row.team_credits),
    location_credits: parseCredits(row.location_credits),
    story_arc_credits: parseCredits(row.story_arc_credits),
    associated_images: parseCredits(row.associated_images)
    };
  // SRV-19: the live API returns image for issues, so emit it from the stored
  // image_url (normalizeResult enriches it with the derived variant URLs).
  if (has("image_url")) result.image = row.image_url ? { original_url: row.image_url } : null;
  // The additional stored issue fields, copied when the column is present so a
  // field_list request returns the value instead of the null default.
  for (const field of ["aliases", "api_detail_url", "deck", "date_added", "date_last_updated"]) {
    if (has(field)) result[field] = row[field];
  }
  if (has("has_staff_review")) result.has_staff_review = parseStaffReview(row.has_staff_review);
  for (const field of ["object_credits", "concept_credits", "character_died_in", "team_disbanded_in",
    "first_appearance_characters", "first_appearance_concepts", "first_appearance_locations",
    "first_appearance_objects", "first_appearance_storyarcs", "first_appearance_teams"]) {
    if (has(field)) result[field] = parseCredits(row[field]);
  }
  return result;
  }
  if (singular === "publisher") {
  const result = {
    id: row.id,
    name: row.name,
    image: row.image_url ? { original_url: row.image_url } : null,
    site_detail_url: row.site_detail_url
    };
  // SRV-21: the live API always emits api_detail_url; derive it from the id
  // (canonical base URL + domain prefix + id) instead of reading a stored column.
  result.api_detail_url = buildApiDetailUrl("publisher", row.id);
  for (const field of ["aliases", "deck", "description", "date_added", "date_last_updated"]) {
   if (has(field)) result[field] = row[field];
  }
  for (const field of ["location_address", "location_city", "location_state"]) {
   if (has(field)) result[field] = row[field];
  }
  for (const rel of ["characters", "story_arcs", "teams", "volumes"]) {
   if (has(rel)) result[rel] = parseJsonColumn(row[rel]);
  }
  return result;
  }
  if (singular === "person") {
  const result = { id: row.id, name: row.name };
  for (const field of ["aliases", "api_detail_url", "birth", "country", "deck", "description", "date_added", "date_last_updated", "death", "email", "hometown", "site_detail_url", "website"]) {
   if (has(field)) result[field] = row[field];
  }
  // SRV-20: the live API emits the issue-credit count under its typo name; the
  // stored column keeps the corrected spelling (count_of_issue_appearances).
  if (has("count_of_issue_appearances")) result.count_of_isssue_appearances = row.count_of_issue_appearances;
  // SRV-20: gender is stored as TEXT (including float spellings); the live API emits a number.
  if (has("gender")) result.gender = parseGender(row.gender);
  // SRV-20: image is built from the stored image_url; the internal column is not emitted.
  if (has("image_url")) result.image = row.image_url ? { original_url: row.image_url } : null;
  for (const rel of ["created_characters", "story_arc_credits", "volume_credits"]) {
   if (has(rel)) result[rel] = parseJsonColumn(row[rel]);
  }
  // SRV-20: the live API emits the person's issue credits under `issues`.
  if (has("issue_credits")) result.issues = parseJsonColumn(row.issue_credits);
  return result;
  }
  if (singular === "team") {
  const publisher = has("publisher") ? parseJsonColumn(row.publisher) : null;
  const result = {
   id: row.id,
   name: row.name,
   publisher
    };
  // SRV-22: the live API always emits api_detail_url; derive it from the id
  // (the table has no such column; same approach as publisher, SRV-21).
  result.api_detail_url = buildApiDetailUrl("team", row.id);
  for (const field of ["aliases", "count_of_team_members", "deck", "description", "date_added", "date_last_updated", "site_detail_url"]) {
  if (has(field)) result[field] = row[field];
  }
  // SRV-22: the live API emits the appearance count under its typo name; the
  // stored column keeps the corrected spelling (same as person, SRV-20).
  if (has("count_of_issue_appearances")) result.count_of_isssue_appearances = row.count_of_issue_appearances;
  // SRV-22: image is built from the stored image_url; the internal column is not emitted.
  if (has("image_url")) result.image = row.image_url ? { original_url: row.image_url } : null;
  if (has("first_appeared_in_issue")) result.first_appeared_in_issue = parseJsonColumn(row.first_appeared_in_issue);
  for (const rel of ["character_enemies", "character_friends", "characters", "disbanded_in_issues", "issue_credits", "movies", "story_arc_credits", "volume_credits"]) {
  if (has(rel)) result[rel] = parseJsonColumn(row[rel]);
  }
  // SRV-22: the live API emits the disbanded collection under its typo name; the
  // stored column keeps the corrected spelling (same as person, SRV-20).
  if (has("issues_disbanded_in")) result.isssues_disbanded_in = parseJsonColumn(row.issues_disbanded_in);
  return result;
  }
  if (singular === "story_arc") {
  const publisher = has("publisher") ? parseJsonColumn(row.publisher) : null;
  const result = {
   id: row.id,
   name: row.name,
   publisher
    };
  for (const field of ["aliases", "count_of_issue_appearances", "deck", "description", "date_added", "date_last_updated", "image_url", "site_detail_url"]) {
   if (has(field)) result[field] = row[field];
  }
  if (has("image_url")) result.image = row.image_url ? { original_url: row.image_url } : null;
  if (has("first_appeared_in_issue")) result.first_appeared_in_issue = parseJsonColumn(row.first_appeared_in_issue);
  for (const rel of ["issues", "movies"]) {
   if (has(rel)) result[rel] = parseJsonColumn(row[rel]);
  }
  return result;
  }
  if (singular === "concept") {
  const result = { id: row.id, name: row.name };
  for (const field of ["aliases", "api_detail_url", "count_of_issue_appearances", "date_added", "date_last_updated", "deck", "description", "site_detail_url", "start_year"]) {
   if (has(field)) result[field] = row[field];
  }
  if (has("image_url")) result.image = row.image_url ? { original_url: row.image_url } : null;
  if (has("first_appeared_in_issue")) result.first_appeared_in_issue = parseJsonColumn(row.first_appeared_in_issue);
  return result;
  }
  return null;
}

// Map an API field name to the SQL expression used to filter or sort a resource.
// A field with no backing column cannot match or order any row, so it yields a
// marker the caller replaces with a no-match clause or an id fallback.
function columnExpression(config, field) {
  const lower = field.toLowerCase();
  if (config.singular === "issue" && (lower === "volume" || lower === "volume_id")) {
   return { kind: "volume" };
   }
  // SRV-20/SRV-22: the live API's typo count name maps to the corrected-spelling column.
  if ((config.singular === "person" || config.singular === "team") && lower === "count_of_isssue_appearances") {
   return { kind: "column", expression: `${config.alias}.count_of_issue_appearances` };
   }
  if (config.columns.has(lower)) {
   return { kind: "column", expression: `${config.alias}.${lower}` };
   }
  return { kind: "none" };
}

// SRV-5: build a text-match clause for a single-value field. When the resource
// has an FTS5 trigram table covering the field, return an `id IN (SELECT rowid
// FROM ..._fts WHERE ..._fts MATCH ...)` clause; otherwise return null so the
// caller keeps the legacy `LIKE '%value%'` behavior. The trigram tokenizer is
// case-insensitive and matches substrings — the same semantics as the LIKE path
// — but only for values of at least 3 characters, so shorter values fall back
// to LIKE. NULL values match nothing; the column must exist in both the table
// and the FTS index.
const FTS_TEXT_FIELDS = new Set(["name", "aliases", "deck", "description"]);
function ftsOrLike(config, field, value) {
  const lower = field.toLowerCase();
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (config.ftsTable && config.ftsColumns.has(lower) && FTS_TEXT_FIELDS.has(lower) && text.length >= 3) {
    // FTS5 column filter: <column>:<phrase>, where the phrase is a quoted string
    // (embedded double-quotes doubled) so it matches as a single substring.
    const match = `${lower}:"${text.replace(/"/g, '""')}"`;
    return { clause: `${config.alias}.id IN (SELECT rowid FROM ${config.ftsTable} WHERE ${config.ftsTable} MATCH ?)`, values: [match] };
  }
  return null;
}

// Build the resource's SQL subquery, its column alias, the set of primary columns,
// and a JS row-to-result projector. Only resources with a normalized table are
// configured; resources without one return null so their endpoints report 404.
function buildResourceConfig(database, resource) {
  const columns = tableColumns(database, resource.table);
  if (columns.size === 0) return null;
  const has = (name) => columns.has(name);
  const singular = resource.singular;
  const hasPublisherTable = tableColumns(database, "cv_publisher").size > 0;
  const volumeColumns = tableColumns(database, "cv_volume");

  let alias;
  let from;
  let selectExtra;
  let build = (row) => buildResult(row, singular);

  if (singular === "volume") {
  alias = "v";
  from = `${resource.table} ${alias}`;
  // The volume's publisher is resolved from the shared table when present.
  if (hasPublisherTable && has("publisher_id")) from += " LEFT JOIN cv_publisher ON cv_publisher.id = " + "v.publisher_id";
  selectExtra = `${alias}.*, ${hasPublisherTable ? "cv_publisher.name AS publisher_name" : "NULL AS publisher_name"}`;
  // SRV-6c: generate the collections from the join tables only once the
  // backfill has completed. The credits_presence column is added by the
  // updater at the start of the backfill and is the reliable completion
  // marker (it survives a rolled-back migration), so its presence means the
  // JSON columns have been replaced. Otherwise fall back to the JSON-text
  // columns in buildResult (also the path for test fixtures without join tables).
  const hasCreditTables =
    volumeColumns.has("credits_presence") &&
    tableColumns(database, "cv_volume_credit").size > 0 &&
    tableColumns(database, "cv_volume_issue_ref").size > 0 &&
    tableColumns(database, "cv_issue").size > 0;
  if (hasCreditTables) build = (row) => buildVolumeResult(row, database);
  } else if (singular === "team" || singular === "story_arc") {
  alias = singular === "team" ? "t" : "a";
  from = `${resource.table} ${alias}`;
  selectExtra = `${alias}.*`;
  } else if (singular === "issue") {
  alias = "i";
  from = `${resource.table} i` + (volumeColumns.size > 0 ? " LEFT JOIN cv_volume v ON v.id = i.volume_id" : "");
  // The volume's api_detail_url is stored; fall back to the deterministic
  // ComicVine URL only when the column is absent or null.
  const volumeApiDetailUrl = volumeColumns.has("api_detail_url") ? "v.api_detail_url AS volume_api_detail_url" : "NULL AS volume_api_detail_url";
  const volumeSite = volumeColumns.has("site_detail_url") ? "v.site_detail_url AS volume_site_detail_url" : "NULL AS volume_site_detail_url";
  selectExtra = `i.*, ${volumeColumns.has("name") ? "v.name AS volume_name" : "NULL AS volume_name"}, ${volumeApiDetailUrl}, ${volumeSite}`;
  } else {
  alias = "p";
  from = `${resource.table} ${alias}`;
  selectExtra = `${alias}.*`;
  }

  const subquery = `SELECT ${selectExtra} FROM ${from}`;
  // SRV-5: detect the resource's FTS5 trigram table (created by the updater).
  // It must exist, cover the searchable text columns, and be populated; any of
  // those missing means the resource falls back to LIKE matching. The FTS table
  // is external-content, so its row count tracks the base table only after a
  // rebuild — gate on > 0 so an empty index does not silently match nothing.
  const ftsTable = `${resource.table}_fts`;
  const ftsColumns = tableColumns(database, ftsTable);
  let ftsEnabled = false;
  if (ftsColumns.size > 0) {
    try { ftsEnabled = database.prepare(`SELECT COUNT(*) AS count FROM ${ftsTable}`).get().count > 0; }
    catch { ftsEnabled = false; }
  }
  return { subquery, alias, columns, build, singular, table: resource.table, ftsTable: ftsEnabled ? ftsTable : null, ftsColumns };
}

function createResourceMap(database) {
  const resourceByPath = new Map();
  for (const [singular, resource] of Object.entries(resources)) {
     const config = buildResourceConfig(database, { ...resource, singular });
     // An empty/absent table is unavailable; only configured resources serve endpoints.
     const configuredResource = {
         ...resource,
        singular,
       config,
      table: config ? resource.table : null
     };
     resourceByPath.set(singular, configuredResource);
     resourceByPath.set(resource.plural, configuredResource);
    }
  for (const [name, resource] of searchOnlyResources) resourceByPath.set(name, resource);
  return resourceByPath;
}

// SRV-14: the CORS headers to send with a response. The request handler stashes
// the computed headers on the response object (see corsHeaders); when absent
// (defensive default) it falls back to the permissive "*" the server always sent.
function corsHeadersFor(response) {
  return response.__corsHeaders ?? { "Access-Control-Allow-Origin": "*" };
}

// SRV-14: build the CORS headers for a request. `corsOrigins` is the configured
// allowlist (an array of origins, or a comma/whitespace-separated string).
//  - No allowlist set (empty): permissive "*" — the current default, fine for
//    local dev, mirroring how the live API answers browsers.
//  - Allowlist set: echo the request's Origin only when it matches (plus
//    `Vary: Origin` so caches key by origin); omit the header entirely when it
//    does not match, so non-allowed origins get no CORS grant.
function corsHeaders(request, corsOrigins) {
  const allowlist = parseKeyList(corsOrigins);
  const origin = request.headers["origin"];
  if (allowlist.length === 0) return { "Access-Control-Allow-Origin": "*" };
  if (typeof origin === "string" && origin && allowlist.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin"
    };
  }
  return { Vary: "Origin" };
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    ...corsHeadersFor(response),
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

// Serialize the shared ComicVine envelope; resultItemName distinguishes collection types in XML.
function sendFormattedResponse(response, body, format, callback, resultItemName = "result") {
  if (format === "xml") {
    const escapeXml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&apos;"
    })[character]);
    const toXml = (name, value) => {
      if (value === null || value === undefined) return `<${name}></${name}>`;
      if (Array.isArray(value)) {
        const itemName = name === "results" ? resultItemName : "item";
        return `<${name}>${value.map((item) => toXml(itemName, item)).join("")}</${name}>`;
      }
      if (typeof value === "object") {
        return `<${name}>${Object.entries(value).map(([key, item]) => toXml(key, item)).join("")}</${name}>`;
      }
      return `<${name}>${escapeXml(value)}</${name}>`;
    };

    response.writeHead(200, {
      ...corsHeadersFor(response),
      "Content-Type": "application/xml; charset=utf-8"
    });
    response.end(`<?xml version="1.0" encoding="UTF-8"?>${toXml("response", body)}`);
    return;
  }

  if (format === "jsonp") {
    response.writeHead(200, {
      ...corsHeadersFor(response),
      "Content-Type": "application/javascript; charset=utf-8"
    });
    response.end(`${callback}(${JSON.stringify(body)});`);
    return;
  }

  sendJson(response, 200, body);
}

// Reduce a request path to a stable endpoint key so per-endpoint stats aggregate
// across ids and query strings (e.g. /api/volume/4050-1487/ -> /api/volume/{id}/).
function endpointKey(pathname) {
  if (pathname === "/api" || pathname === "/api/") return "/api";
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "api" || segments.length < 2) return pathname;
  return segments.length === 3 ? `/api/${segments[1]}/{id}/` : `/api/${segments[1]}/`;
}

// Keep list, detail, and search responses on the same ComicVine envelope shape.
function comicVineResponse(results, limit, offset, total) {
  return {
    error: "OK",
    limit,
    offset,
    number_of_page_results: Array.isArray(results) ? results.length : 1,
    number_of_total_results: total,
    status_code: 1,
    results
  };
}

// Filters support comma-separated field:value terms and inclusive field:start|end ranges.
// Fields resolve to real columns; unknown fields match nothing. Issue volume filters
// resolve to the joined volume id.
function parseFilters(filter, config) {
  if (!filter) return { clauses: [], values: [] };

  const clauses = [];
  const values = [];
  for (const expression of filter.split(",")) {
   const match = expression.match(/^([a-z][a-z0-9_]*):(.+)$/i);
   if (!match) {
     throw new Error("Filters must use field:value format.");
    }

   const field = match[1];
   if (config.singular === "issue" && ["volume", "volume_id"].includes(field.toLowerCase())) {
     const volumeIdMatch = match[2].trim().match(/(?:^|-)(\d+)$/);
     if (!volumeIdMatch || !Number.isSafeInteger(Number(volumeIdMatch[1]))) {
       throw new Error("Issue volume filters require a numeric volume ID.");
      }
     clauses.push(`${config.alias}.volume_id = ?`);
     values.push(Number(volumeIdMatch[1]));
     continue;
    }

   const expressionRef = columnExpression(config, field);
   if (expressionRef.kind !== "column") {
      // A field without a backing column matches no rows.
    clauses.push("1 = 0");
    continue;
   }
   const column = expressionRef.expression;
   const raw = match[2];
   if (config.singular === "volume" && field.toLowerCase() === "id") {
    // Volume id filters are exact matches, not partial LIKE matches. A
    // pipe-separated list of all-numeric ids (filter=id:1|2|3) matches any of
    // them via IN (...) — SRV-15. A single value stays an exact match. This
    // branch is checked before the numeric range branch because ids are
    // never a range.
    const ids = raw.split("|").map((token) => token.trim()).filter(Boolean);
    if (ids.length > 1 && ids.every((token) => /^\d+$/.test(token))) {
      clauses.push(`${column} IN (${ids.map(() => "?").join(", ")})`);
      values.push(...ids);
    } else {
      clauses.push(`${column} = ?`);
      values.push(raw.trim());
    }
    continue;
   }
   const range = raw.split("|");
   if (range.length === 2) {
     clauses.push(`${column} >= ? AND ${column} <= ?`);
     values.push(range[0].trim(), range[1].trim());
   } else {
    // SRV-5: single-value text filters use the FTS trigram index when available;
    // shorter values (< 3 chars) and non-text fields keep the LIKE partial match.
    const ftsMatch = ftsOrLike(config, field, match[2]);
    if (ftsMatch) {
      clauses.push(ftsMatch.clause);
      values.push(...ftsMatch.values);
    } else {
      clauses.push(`${column} LIKE ? COLLATE NOCASE`);
      values.push(`%${match[2]}%`);
    }
   }
   }

  return { clauses, values };
}

// Sort SQL is built from the resource's columns; a field with no column leaves the
// default order. The allowlist guards the interpolated column name. When `sort`
// is absent the resource's default sort column (default "id ASC") is used, so each
// list endpoint has a stable, predictable ordering.
function parseSort(config, sort, sortableFields, defaultColumn = "id") {
  if (!sort) {
    const expression = columnExpression(config, defaultColumn);
    const column = expression.kind === "column" ? expression.expression : `${config.alias}.id`;
    return `${column} ASC`;
  }
  const match = sort.match(/^([a-z][a-z0-9_]*):(asc|desc)$/i);
  if (!match || !sortableFields.has(match[1])) {
   throw new Error("Sort must use a supported field and asc or desc direction.");
  }
  const expression = columnExpression(config, match[1]);
  const column = expression.kind === "column" ? expression.expression : `${config.alias}.id`;
  return `${column} ${match[2].toUpperCase()}`;
}

function validateFormattedRequest(url) {
  const format = (url.searchParams.get("format") || "json").toLowerCase();
  if (!["json", "xml", "jsonp"].includes(format)) {
    throw new Error("Format must be json, xml, or jsonp.");
  }
  if (format !== "jsonp") return { format, callback: null };

  const callback = url.searchParams.get("json_callback") || url.searchParams.get("callback");
  if (!callback || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callback)) {
    throw new Error("JSONP requires a valid json_callback parameter.");
  }
  return { format, callback };
}

function parseSearchResources(resourceList, resourceByPath) {
  const requested = resourceList
    ? resourceList.split(",").map((resource) => resource.trim().toLowerCase()).filter(Boolean)
    : [...Object.keys(resources), ...searchOnlyResources.keys()];
  const selected = [...new Set(requested.map((resource) => resourceByPath.get(resource)))];

  if (selected.length === 0 || selected.includes(undefined)) {
    throw new Error("Unknown search resource.");
  }

  return selected;
}

function normalizeResult(result, resourceType) {
  let normalized = result;
  // SRV-19: issues keep their image (the live API returns one); only default a
  // missing description to null for fixtures predating the column.
  if (resourceType === "issue" && !Object.hasOwn(result, "description")) {
    normalized = { ...result };
    normalized.description = null;
  }
  if (!normalized.image || typeof normalized.image !== "object" || !normalized.image.original_url) return normalized;

  const image = { ...normalized.image };
  const variants = {
    icon_url: "square_avatar",
    medium_url: "scale_medium",
    screen_url: "screen_medium",
    screen_large_url: "screen_kubrick",
    small_url: "scale_small",
    super_url: "scale_large",
    thumb_url: "scale_avatar",
    tiny_url: "square_mini"
  };
  for (const [field, variant] of Object.entries(variants)) {
    image[field] ??= image.original_url.replace("/original/", `/${variant}/`);
  }
  image.image_tags ??= "All Images";
  return { ...normalized, image };
}

function projectSearchFields(resource, result, fieldList) {
  const normalized = normalizeResult(result, resource.singular);
  if (!fieldList) return { ...normalized, resource_type: resource.singular };

  const fields = new Set(fieldList.split(",").map((field) => field.trim()).filter(Boolean));
   // ComicVine includes resource_type even when callers request a narrower field_list.
  fields.add("resource_type");
  const projected = projectResult(resource.singular, normalized, [...fields].filter((field) => field !== "resource_type").join(","));
  return { resource_type: resource.singular, ...projected };
}

// Coerce an option to a positive integer, falling back when unset or invalid.
function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

// Resolve an effective page size. A requested limit is clamped to [1, maxLimit];
// when no limit is requested, the default is used (still clamped to maxLimit).
function resolveLimit(requested, defaultLimit, maxLimit) {
  const limit = Number.isFinite(requested) ? requested : defaultLimit;
  return Math.min(Math.max(Math.floor(limit), 1), maxLimit);
}

// Parse a comma/whitespace-separated list of integers (e.g. "5, 9, 42"), dropping
// blanks and non-numeric tokens and de-duplicating. Non-numeric tokens are ignored
// rather than throwing so a stray token never breaks a request.
function parseIdList(value) {
  if (value === undefined || value === null) return [];
  const seen = new Set();
  const ids = [];
  for (const token of String(value).split(/[\s,]+/)) {
    if (!token) continue;
    const id = Number(token);
    if (!Number.isSafeInteger(id)) continue;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

// SRV-13: parse a comma/whitespace-separated list of API keys (e.g. "key1, key2").
// Blanks are dropped and the list is de-duplicated, preserving order. A key is
// an opaque string (the live ComicVine key format is 31 hex chars, but we accept
// any non-empty token).
function parseKeyList(value) {
  if (value === undefined || value === null) return [];
  const seen = new Set();
  const keys = [];
  for (const token of String(value).split(/[\s,]+/)) {
    if (!token) continue;
    if (!seen.has(token)) {
      seen.add(token);
      keys.push(token);
    }
  }
  return keys;
}

// SRV-25: parse a boolean environment flag. The opt-in flags (validation, the
// response/SQL loggers) are enabled only by an explicit on-spelling
// (1/true/yes/on, case-insensitive); 0/false/no/off and unset are all off. A
// plain truthiness test would wrongly enable a flag set to "0" — a non-empty
// string is truthy in JS — so COMICVINE_VALIDATE=0 (the README's "off" spelling)
// actually turned validation *on*.
function parseBoolFlag(value) {
  if (value === undefined || value === null) return false;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

// SRV-13: pull the caller's API key from the most likely carrier, in priority
// order: the `X-Api-Key` (or `X_API_KEY`) header, a `Bearer` Authorization
// header, then the `api_key`/`key` query parameter. Returns the raw string or
// null when no credential is present.
function extractApiKey(request, url) {
  const headerKey = request.headers["x-api-key"] ?? request.headers["x_api_key"];
  if (typeof headerKey === "string" && headerKey.trim()) return headerKey.trim();
  const auth = request.headers["authorization"];
  if (typeof auth === "string") {
    const match = auth.match(/^Bearer\s+(\S+)$/i);
    if (match && match[1]) return match[1];
  }
  const queryKey = url.searchParams.get("api_key") ?? url.searchParams.get("key");
  if (queryKey && queryKey.trim()) return queryKey.trim();
  return null;
}

// SRV-12: a `publisher_id NOT IN (...)` predicate for volume queries. Empty when
// there is no blocklist or the resource has no publisher_id column. Returns separate
// clause and values so the caller can append both to a prepared statement.
function publisherBlocklistPredicate(config, ids) {
  if (!ids.length || !config.columns.has("publisher_id")) return { clause: "", values: [] };
  const placeholders = ids.map(() => "?").join(", ");
  return { clause: ` AND ${config.alias}.publisher_id NOT IN (${placeholders})`, values: ids };
}

// Format a stamped log entry as one line: a readable `[timestamp] [LEVEL]`
// prefix followed by the JSON body. Shared by the console and file loggers so
// both emit identical lines.
function formatLogLine(entry) {
  const prefix = `[${entry.timestamp ?? new Date().toISOString()}] [${(entry.level ?? "info").toUpperCase()}] `;
  return `${prefix}${JSON.stringify(entry)}`;
}

// Default logger: one line per entry, written to the stream matching its level.
// Custom loggers (e.g. tests) receive the stamped entry directly and ignore this
// formatting.
function defaultLogger(entry) {
  const line = formatLogLine(entry);
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.info(line);
}

// SRV-7: a rotating file logger. Each entry is appended to `filePath` as a
// formatted line (same shape as the console output). When the file grows past
// `maxSize` bytes it is rotated: the current file is renamed to `filePath.1`,
// `filePath.1` to `filePath.2`, and so on up to `maxFiles` generations, with the
// oldest removed. The append is synchronous (matching the server's synchronous
// node:sqlite usage) so each line is on disk before the request handler returns.
// Rotation and writes are best-effort — a filesystem error is surfaced to stderr
// and the entry is skipped rather than crashing the server.
function createRotatingFileLogger(filePath, maxSize = 10 * 1024 * 1024, maxFiles = 5) {
  const rotate = () => {
    // Shift the existing generations, dropping the one beyond maxFiles.
    for (let i = maxFiles - 1; i >= 1; i--) {
      const source = `${filePath}.${i}`;
      if (fs.existsSync(source)) fs.renameSync(source, `${filePath}.${i + 1}`);
    }
    if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`);
  };
  return (entry) => {
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).size >= maxSize) rotate();
      fs.appendFileSync(filePath, formatLogLine(entry) + "\n");
    } catch (error) {
      console.error(`[LOG] file logging error: ${error.message}`);
    }
  };
}

function createApiServer(
  databasePath = path.join(__dirname, "..", "localcv.db"),
  logger = defaultLogger,
  options = {}
) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const resourceByPath = createResourceMap(database);

  // Overridable paging controls. Both the maximum cap and the default limit can
  // be overridden per server instance; when unset they keep ComicVine's defaults
  // (list default 100, search default 10, maximum 100).
  const maxLimit = positiveInt(options.maxLimit, 100);
  const defaultLimit = positiveInt(options.defaultLimit, 100);
  const searchDefaultLimit = positiveInt(options.searchDefaultLimit, 10);
   // When set, this value replaces any client-sent limit on the SEARCH endpoint
   // only (still clamped to maxLimit). It does not affect list or detail
   // endpoints. Unset by default, so client limits are honored.
  const searchForcedLimit = options.searchForcedLimit === undefined ? null : positiveInt(options.searchForcedLimit, null);

   // SRV-12: publisher ids whose volumes are excluded from search and list
   // results. `options.publisherBlocklist` is an array of ids; when unset it
   // falls back to the COMICVINE_PUBLISHER_BLOCKLIST env var (comma-separated).
   // Applied only to volumes (the only resource with a publisher_id column).
   const publisherBlocklist = parseIdList(
     options.publisherBlocklist !== undefined
       ? (Array.isArray(options.publisherBlocklist) ? options.publisherBlocklist.join(",") : options.publisherBlocklist)
       : process.env.COMICVINE_PUBLISHER_BLOCKLIST
   );

   // SRV-13: optional API-key authentication. `options.apiKeys` is an array of
   // accepted keys (or a comma-separated string); when unset it falls back to the
   // COMICVINE_API_KEYS env var. Authentication is OFF when no keys are
   // configured (empty list), so existing local usage is unchanged. When one or
   // more keys are set, requests to resource endpoints must present a matching
   // key. The local-only index (/api) and /api/status endpoints stay open.
   const apiKeys = new Set(parseKeyList(
     options.apiKeys !== undefined
       ? (Array.isArray(options.apiKeys) ? options.apiKeys.join(",") : options.apiKeys)
       : process.env.COMICVINE_API_KEYS
   ));

   // SRV-14: configurable CORS. `options.corsOrigins` is an array of allowed
   // origins (or a comma/whitespace-separated string); when unset it falls back
   // to the COMICVINE_CORS_ORIGINS env var. An EMPTY allowlist is the default and
   // means permissive "*" (the previous behavior, suitable for local dev). When
   // one or more origins are set, only matching request Origins are echoed.
   const corsOrigins = parseKeyList(
     options.corsOrigins !== undefined
       ? (Array.isArray(options.corsOrigins) ? options.corsOrigins.join(",") : options.corsOrigins)
       : process.env.COMICVINE_CORS_ORIGINS
   );

   // SRV-1: the default sort column for list endpoints that have no ?sort=.
   // `options.defaultSort` is either a single field name (applied to every
   // resource) or a per-resource map, e.g. { volume: "name", issue: "issue_number" };
   // when unset it falls back to the COMICVINE_DEFAULT_SORT env var (a single field
   // name). Unset, it keeps every resource on "id" (the live API's ordering).
   const defaultSortRaw = options.defaultSort !== undefined
     ? options.defaultSort
     : process.env.COMICVINE_DEFAULT_SORT || undefined;
   // Accept both singular and plural resource keys in the per-resource map
   // (e.g. { person: "name" } or { people: "name" }); normalize to singular.
   const pluralToSingular = { ...Object.fromEntries(Object.entries(resources).map(([singular, resource]) => [resource.plural, singular])) };
   const defaultSort =
     defaultSortRaw !== undefined && typeof defaultSortRaw === "object" && !Array.isArray(defaultSortRaw)
       ? { ...defaultSortByResource, ...Object.fromEntries(Object.entries(defaultSortRaw).map(([key, column]) => [pluralToSingular[key] ?? key, column])) }
       : { ...defaultSortByResource, ...(typeof defaultSortRaw === "string" ? { issue: defaultSortRaw, person: defaultSortRaw, publisher: defaultSortRaw, story_arc: defaultSortRaw, team: defaultSortRaw, volume: defaultSortRaw } : {}) };

   // SRV-8: when enabled, detail responses are diffed against the live ComicVine
   // API to verify the bundled data. The live key comes from the environment
   // (COMICVINE_API_KEY); without it the validator cannot run and is skipped.
   // `options.fetchFn` is an injectable live-fetch (used by tests); defaults to the
   // real network call in validate.js.
   const validateEnabled = Boolean(options.validate);
   const validateApiKey = validateEnabled ? process.env.COMICVINE_API_KEY : null;
   const validateFetchFn = options.fetchFn;

   // In-memory per-endpoint request stats for /api/status; resets on restart.
   const requestStats = new Map();

   // SRV-10: log levels, ordered from least to most severe. Entries at or below
   // the configured threshold are emitted; anything above is dropped.
   const logLevels = { debug: 10, info: 20, warn: 30, error: 40 };
   const logThreshold = logLevels[String(options.logLevel ?? process.env.COMICVINE_LOG_LEVEL ?? "info").toLowerCase()] ?? logLevels.info;

   // SRV-7: optional file logging. When a path is configured (options.logFile or
   // COMICVINE_LOG_FILE) every emitted entry is also appended to that file, with
   // size-based rotation. Options fall back to the matching COMICVINE_* env vars;
   // stdout/stderr logging (the `logger` above) always continues regardless.
   const logFilePath = options.logFile ?? process.env.COMICVINE_LOG_FILE ?? null;
   const logMaxSize = positiveInt(options.logMaxSize ?? process.env.COMICVINE_LOG_MAX_SIZE, 10 * 1024 * 1024);
   const logMaxFiles = positiveInt(options.logMaxFiles ?? process.env.COMICVINE_LOG_MAX_FILES, 5);
   const fileLogger = logFilePath ? createRotatingFileLogger(logFilePath, logMaxSize, logMaxFiles) : null;

   // SRV-16: log the serialized response body with each request line, off by
   // default. `options.logResponses` (boolean) or COMICVINE_LOG_RESPONSES
   // (any non-empty value) enables it; the body is appended to the per-request
   // "finish" log line as `response_body`, truncated to `logResponseMaxLength`
   // (COMICVINE_LOG_RESPONSE_MAX_LENGTH, default 10000) to keep lines bounded.
   const logResponses = Boolean(options.logResponses ?? process.env.COMICVINE_LOG_RESPONSES);
   const logResponseMaxLength = positiveInt(options.logResponseMaxLength ?? process.env.COMICVINE_LOG_RESPONSE_MAX_LENGTH, 10000);

   // SRV-17: log the SQL executed to build a response, off by default. Each
   // request's queries (the list/search SELECT plus the COUNT) are recorded with
   // their bound values and emitted as `sql` in the per-request "finish" line;
   // the serialized array is truncated to `logSqlMaxLength`
   // (COMICVINE_LOG_SQL_MAX_LENGTH, default 20000) to keep lines bounded.
   const logSql = Boolean(options.logSql ?? process.env.COMICVINE_LOG_SQL);
   const logSqlMaxLength = positiveInt(options.logSqlMaxLength ?? process.env.COMICVINE_LOG_SQL_MAX_LENGTH, 20000);
   // Per-request SQL capture. When the flag is on, `database` is wrapped so every
   // statement run during a request is appended to that request's `__sql` array.
   // `currentResponse` is set per-request in the handler below (the wrapper is built
   // before any request exists, so it reads the current response at call time).
   let currentResponse = null;
   const wrappedDatabase = logSql
     ? {
         prepare: (sql) => {
           const statement = database.prepare(sql);
           const record = (...params) => {
             if (currentResponse?.__sql) currentResponse.__sql.push({ sql, params });
           };
           return {
             get: (...params) => { record(...params); return statement.get(...params); },
             all: (...params) => { record(...params); return statement.all(...params); },
             run: (...params) => { record(...params); return statement.run(...params); }
           };
         }
       }
     : database;

   // Central log sink: stamps an ISO-8601 timestamp and a level (defaulting to
   // "info") on every entry, applies the level threshold, then delegates to the
   // configured logger (stdout/stderr) and, when enabled, the rotating file.
   const log = (level, entry) => {
     const record = { ...entry, level, timestamp: new Date().toISOString() };
     if ((logLevels[level] ?? logLevels.info) < logThreshold) return;
     logger(record);
     if (fileLogger) fileLogger(record);
   };

   const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    const requestUrl = new URL(request.url, "http://localhost");
    const requestPath = requestUrl.pathname;
    // Keep useful query context in logs while redacting credential-like parameters.
    for (const key of requestUrl.searchParams.keys()) {
      if (/^(api[_-]?key|key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)$/i.test(key)) {
        requestUrl.searchParams.set(key, "[REDACTED]");
      }
    }
    const durationMs = () => Date.now() - startedAt;
    // SRV-14: compute the CORS headers once per request and stash them on the
    // response so every sendJson/sendFormattedResponse below can merge them in.
    response.__corsHeaders = corsHeaders(request, corsOrigins);
    // SRV-17: when SQL logging is enabled, collect the queries run for this
    // request so the per-request "finish" line can include them.
    if (logSql) {
      response.__sql = [];
      currentResponse = response;
    }
    // SRV-16: when response-body logging is enabled, buffer the emitted body
    // (the chunks written before `end`) so the per-request "finish" line can
    // include it. Off by default, so this captures nothing for normal requests.
    if (logResponses) {
      const chunks = [];
      let length = 0;
      const originalWrite = response.write.bind(response);
      response.write = (chunk, ...args) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        length += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        return originalWrite(chunk, ...args);
      };
      const originalEnd = response.end.bind(response);
      response.end = (chunk, ...args) => {
        if (chunk !== undefined && chunk !== null) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          chunks.push(buf);
          length += buf.length;
        }
        return originalEnd(chunk, ...args);
      };
      response.__responseBody = () => {
        const full = Buffer.concat(chunks);
        const truncated = full.length > logResponseMaxLength;
        const text = full.slice(0, logResponseMaxLength).toString("utf8");
        return truncated ? `${text}…[truncated ${full.length - logResponseMaxLength} of ${full.length} bytes]` : text;
      };
    }
    response.once("finish", () => {
      const status = response.statusCode;
      const key = endpointKey(requestPath);
      const entry = requestStats.get(key) ?? { requests: 0, status_codes: {}, duration_sum_ms: 0 };
      entry.requests += 1;
      entry.status_codes[status] = (entry.status_codes[status] ?? 0) + 1;
      entry.duration_sum_ms += durationMs();
      requestStats.set(key, entry);
      const entryBody = {
        method: request.method,
        path: requestPath,
        query: requestUrl.searchParams.toString(),
        status,
        duration_ms: durationMs()
      };
      if (logResponses) entryBody.response_body = response.__responseBody ? response.__responseBody() : "";
      if (logSql && response.__sql) {
        const serialized = JSON.stringify(response.__sql);
        entryBody.sql = serialized.length > logSqlMaxLength
          ? serialized.slice(0, logSqlMaxLength) + `…[truncated ${serialized.length - logSqlMaxLength} of ${serialized.length} chars]`
          : serialized;
      }
      log("info", entryBody);
    });

    if (request.method === "OPTIONS") {
      // SRV-13: allow the credential headers the auth check accepts, so a
      // browser client can preflight a request that carries an API key.
      // SRV-14: the origin grant comes from the computed CORS headers above.
      response.writeHead(204, {
        ...response.__corsHeaders,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, Authorization"
      });
      response.end();
      return;
    }

    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/api" || url.pathname === "/api/") {
      sendJson(response, 200, {
        name: "ComicVine API Mock",
        endpoints: [
          "/api/search/",
          ...Object.entries(resources).flatMap(([singular, resource]) => resourceByPath.get(singular).table
            ? [`/api/${resource.plural}/`, `/api/${singular}/{id}/`]
            : [])
        ],
        available_resources: [...resourceByPath.entries()]
          .filter(([, resource]) => resource.table)
          .map(([name]) => name)
      });
      return;
    }

    if (url.pathname === "/api/status" || url.pathname === "/api/status/") {
      // Local-only endpoint (not part of the live ComicVine API): database
      // coverage, sync freshness, and per-endpoint request statistics.
      let tables = {};
      try {
        const rows = wrappedDatabase.prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cv\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%\\_fts' ESCAPE '\\' ORDER BY name`
        ).all();
        for (const row of rows) {
          tables[row.name] = wrappedDatabase.prepare(`SELECT COUNT(*) AS count FROM ${row.name}`).get().count;
        }
      } catch {
        tables = {};
      }
      let sync_metadata = [];
      try {
        if (tableColumns(database, "cv_sync_metadata").size > 0) {
          sync_metadata = wrappedDatabase.prepare(
            `SELECT endpoint, last_sync_date, last_sync_timestamp FROM cv_sync_metadata ORDER BY endpoint`
          ).all();
        }
      } catch {
        sync_metadata = [];
      }
      const endpoints = [...requestStats.entries()].map(([endpoint, entry]) => ({
        endpoint,
        requests: entry.requests,
        status_codes: entry.status_codes,
        avg_duration_ms: entry.requests ? Number((entry.duration_sum_ms / entry.requests).toFixed(2)) : 0
      }));
      sendJson(response, 200, {
        tables,
        sync_metadata,
        endpoints,
        total_requests: endpoints.reduce((sum, entry) => sum + entry.requests, 0)
      });
      return;
    }

    // SRV-13: enforce API-key authentication on resource endpoints (search,
    // list, detail) when one or more keys are configured. The local-only index
    // (/api) and /api/status endpoints are handled above and stay open, so
    // monitoring and discovery work without a key. A missing or invalid key
    // yields HTTP 401 with a ComicVine-style `status_code: 100` envelope
    // (matching the live API's "invalid API key" response).
    if (apiKeys.size > 0) {
      const providedKey = extractApiKey(request, url);
      if (!providedKey || !apiKeys.has(providedKey)) {
        response.once("finish", () => {
          log("warn", {
            type: "auth",
            method: request.method,
            path: url.pathname,
            status: 401,
            reason: providedKey ? "invalid_api_key" : "missing_api_key"
          });
        });
        sendJson(response, 401, {
          error: "Invalid API key. Provide a valid key via the api_key query parameter, the X-Api-Key header, or an Authorization Bearer header.",
          status_code: 100
        });
        return;
      }
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // All resource routes must be under /api; the root API index is handled above.
    if (segments[0] !== "api" || segments.length < 2 || segments.length > 3) {
      sendJson(response, 404, { error: "Not Found" });
      return;
    }

    if (segments.length === 2 && segments[1] === "search") {
      try {
        const query = url.searchParams.get("query")?.trim();
        if (!query) {
          sendJson(response, 400, { error: "A query parameter is required." });
          return;
        }

        const { format, callback } = validateFormattedRequest(url);
        const selectedResources = parseSearchResources(url.searchParams.get("resources"), resourceByPath);
        // subscriber_only is accepted for API compatibility but intentionally unsupported:
        // the bundled data has no subscriber flag to filter on, so the parameter is ignored.
        const requestedLimit = Number.parseInt(url.searchParams.get("limit"), 10);
        const requestedOffset = Number.parseInt(url.searchParams.get("offset"), 10);
        const limit = resolveLimit(searchForcedLimit ?? requestedLimit, searchDefaultLimit, maxLimit);
        const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
        const escapedQuery = query.replace(/[\\%_]/g, "\\$&");
        const pattern = `%${escapedQuery}%`;
        // Each searchable resource is queried on its own; results are concatenated
        // in resource order (so earlier resources lead) and sliced as one page.
        const allResults = [];
        let total = 0;
        for (const resource of selectedResources.filter((resource) => resource.config)) {
         const config = resource.config;
        // SRV-5: token-based FTS match when the resource has a populated trigram
        // index; otherwise the legacy case-insensitive LIKE on name. Both match
        // the name column only, so the result set is unchanged.
        const ftsMatch = ftsOrLike(config, "name", query);
        const nameMatch = ftsMatch
          ? ftsMatch
          : { clause: `${config.alias}.name LIKE lower(?) ESCAPE '\\' COLLATE NOCASE`, values: [pattern] };
        // Volumes lead with the newest first; issues by issue number (numeric,
        // since it is stored as text, with non-numeric specials after the
        // numbers); other resources keep id order.
        let orderBy;
        if (config.singular === "volume" && config.columns.has("start_year")) {
          orderBy = `${config.alias}.start_year DESC`;
        } else if (config.singular === "issue" && config.columns.has("issue_number")) {
          orderBy = `CASE WHEN ${config.alias}.issue_number GLOB '[0-9]*' THEN 0 ELSE 1 END, ` +
              `CAST(${config.alias}.issue_number AS REAL) ASC, ${config.alias}.id`;
        } else {
          orderBy = `${config.alias}.id`;
        }
        // SRV-12: exclude blocked publishers from volume search. Search has no
        // ?filter= parameter, so the blocklist always applies when set.
        const blocklist = config.singular === "volume"
          ? publisherBlocklistPredicate(config, publisherBlocklist)
          : { clause: "", values: [] };
        const matched = wrappedDatabase.prepare(
          `SELECT * FROM (${config.subquery}) ${config.alias} WHERE ${nameMatch.clause}${blocklist.clause} ORDER BY ${orderBy}`
           ).all(...nameMatch.values, ...blocklist.values);
        total += matched.length;
        for (const row of matched) allResults.push(projectSearchFields(resource, config.build(row), url.searchParams.get("field_list")));
        }

        const results = allResults.slice(offset, offset + limit);
        sendFormattedResponse(response, comicVineResponse(results, limit, offset, total), format, callback);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    const resource = resourceByPath.get(segments[1]);
    if (!resource) {
      sendJson(response, 404, { error: "Unknown resource" });
      return;
    }
    if (!resource.table) {
      sendJson(response, 404, { error: "Resource is not available in the configured database." });
      return;
    }

    try {
     const { config } = resource;
     const requestedLimit = Number.parseInt(url.searchParams.get("limit"), 10);
     const requestedOffset = Number.parseInt(url.searchParams.get("offset"), 10);
     const { format, callback } = validateFormattedRequest(url);
     const fieldList = url.searchParams.get("field_list");

     if (segments.length === 3) {
      const id = Number(segments[2].split("-").at(-1));
      if (!Number.isSafeInteger(id)) {
         sendJson(response, 400, { error: "Invalid resource ID" });
         return;
        }

      const row = wrappedDatabase.prepare(`SELECT * FROM (${config.subquery}) ${config.alias} WHERE ${config.alias}.id = ?`)
          .get(id);
      if (!row) {
         const notFound = {
            ...comicVineResponse(null, 1, 0, 0),
          error: "Object Not Found",
          status_code: 101
          };
         sendFormattedResponse(response, notFound, format, callback);
         return;
        }

      const normalized = normalizeResult(config.build(row), resource.singular);
      const result = projectResult(resource.singular, normalized, fieldList);

      // SRV-8: when enabled and a key is present, diff the local entity against the
      // live API before responding. The full (unprojected) result is compared, and
      // collections are included for issues (the only type the live API returns
      // them for). The diff is reported in the response `validation` field.
      if (validateEnabled && validateApiKey) {
        const compareCollections = resource.singular === "issue";
        const validation = await validateEntity(resource.singular, id, normalized, validateApiKey, compareCollections, validateFetchFn);
        // A clean match is a routine info line; a mismatch or a live entity that
        // could not be fetched is a warning worth surfacing.
        const level = validation.status === "match" ? "info" : "warn";
        log(level, {
          type: "validation",
          method: request.method,
          path: requestPath,
          resource: resource.singular,
          id,
          status: validation.status,
          diffs: validation.diffs,
          collections: validation.collections,
          duration_ms: durationMs()
        });
        // The envelope keeps its shape; the diff is reported in an extra field.
        const body = { ...comicVineResponse(result, 1, 0, 1), validation };
        sendFormattedResponse(response, body, format, callback);
        return;
      }

      sendFormattedResponse(response, comicVineResponse(result, 1, 0, 1), format, callback);
      return;
      }

     // SRV-1: every list endpoint honors ?sort= via its sortable*Fields allowlist;
     // an absent or unsupported field/direction keeps the default id ordering.
     // COMICVINE_FORCED_LIMIT does not apply to list endpoints, only to search.
     const limit = resolveLimit(requestedLimit, defaultLimit, maxLimit);
     const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
     const { clauses, values } = parseFilters(url.searchParams.get("filter"), config);
     // SRV-12: exclude blocked publishers from list results, but never override an
     // explicit publisher filter the client requested (publisher_id or publisher).
     const filterText = url.searchParams.get("filter") ?? "";
     const hasPublisherFilter = filterText
       .split(",")
       .some((expression) => {
         const match = expression.match(/^([a-z][a-z0-9_]*):/i);
         return match && ["publisher_id", "publisher"].includes(match[1].toLowerCase());
       });
     const blocklist = resource.singular === "volume" && !hasPublisherFilter
       ? publisherBlocklistPredicate(config, publisherBlocklist)
       : { clause: "", values: [] };
     const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}${blocklist.clause}` : (blocklist.clause ? ` WHERE 1 = 1${blocklist.clause}` : "");
     const orderBy = parseSort(config, url.searchParams.get("sort"), sortableFieldsByResource[resource.singular], defaultSort[resource.singular]);
     const total = wrappedDatabase.prepare(`SELECT COUNT(*) AS count FROM (${config.subquery}) ${config.alias}${where}`)
      .get(...values, ...blocklist.values).count;
     const rows = wrappedDatabase.prepare(
      `SELECT * FROM (${config.subquery}) ${config.alias}${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
      ).all(...values, ...blocklist.values, limit, offset);
     const results = rows.map((row) => {
      const built = config.build(row);
      const normalized = resource.singular === "volume" || resource.singular === "issue"
          ? normalizeResult(built, resource.singular)
          : built;
      return projectResult(resource.singular, normalized, fieldList);
      });

     sendFormattedResponse(response, comicVineResponse(results, limit, offset, total), format, callback, resource.singular);
    } catch (error) {
     sendJson(response, 400, { error: error.message });
    }
  });

  server.on("close", () => database.close());
  return server;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT, 10) || 3333;
  const host = process.env.HOST || "127.0.0.1";
  const databasePath = process.env.COMICVINE_DB_PATH;
  const options = {};
   // Optional paging overrides: COMICVINE_MAX_LIMIT raises the maximum page size,
   // COMICVINE_DEFAULT_LIMIT overrides the default for list endpoints, and
   // COMICVINE_SEARCH_DEFAULT_LIMIT overrides the default for search.
  if (process.env.COMICVINE_MAX_LIMIT) options.maxLimit = process.env.COMICVINE_MAX_LIMIT;
  if (process.env.COMICVINE_DEFAULT_LIMIT) options.defaultLimit = process.env.COMICVINE_DEFAULT_LIMIT;
  if (process.env.COMICVINE_SEARCH_DEFAULT_LIMIT) options.searchDefaultLimit = process.env.COMICVINE_SEARCH_DEFAULT_LIMIT;
    // COMICVINE_FORCED_LIMIT overrides the client's ?limit on the search endpoint only.
  if (process.env.COMICVINE_FORCED_LIMIT) options.searchForcedLimit = process.env.COMICVINE_FORCED_LIMIT;
    // COMICVINE_VALIDATE=1 enables SRV-8 live-API validation on detail endpoints;
    // the live key is read from COMICVINE_API_KEY. Only an explicit on-spelling
    // enables it, so COMICVINE_VALIDATE=0 (the README's "off" spelling) disables
    // it — a truthiness test would treat the string "0" as enabled (SRV-25).
  if (parseBoolFlag(process.env.COMICVINE_VALIDATE)) options.validate = true;
    // SRV-13: COMICVINE_API_KEYS enables incoming-request key authentication for
    // resource endpoints. When unset the server stays open (local default).
  if (process.env.COMICVINE_API_KEYS) options.apiKeys = process.env.COMICVINE_API_KEYS;
    // SRV-16: COMICVINE_LOG_RESPONSES logs each request's serialized response body
    // (truncated to COMICVINE_LOG_RESPONSE_MAX_LENGTH). Off by default.
    if (parseBoolFlag(process.env.COMICVINE_LOG_RESPONSES)) options.logResponses = true;
    if (process.env.COMICVINE_LOG_RESPONSE_MAX_LENGTH) options.logResponseMaxLength = process.env.COMICVINE_LOG_RESPONSE_MAX_LENGTH;
    // SRV-17: COMICVINE_LOG_SQL logs the SQL executed to build each response
    // (truncated to COMICVINE_LOG_SQL_MAX_LENGTH). Off by default.
    if (parseBoolFlag(process.env.COMICVINE_LOG_SQL)) options.logSql = true;
    if (process.env.COMICVINE_LOG_SQL_MAX_LENGTH) options.logSqlMaxLength = process.env.COMICVINE_LOG_SQL_MAX_LENGTH;
    const server = createApiServer(databasePath, undefined, options);
  server.listen(port, host, () => {
    defaultLogger({ type: "startup", level: "info", message: `listening at http://${host}:${port}`, timestamp: new Date().toISOString() });
  });
}

module.exports = { createApiServer, resourceConfig, parseBoolFlag };