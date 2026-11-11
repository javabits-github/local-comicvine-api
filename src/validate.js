const { resourceConfig } = require("./fieldConfig.js");

// Live ComicVine API client + local-vs-live result diffing for SRV-8.
//
// The live API returns HTTP 200 with a `status_code` in the body: 1 = OK,
// 100 = invalid key, 107 = rate limit exceeded. Mirrors the updater's api_call
// contract (escalating backoff on 107, abort on 100, null on exhaustion).

const API_BASE_URL = "https://comicvine.gamespot.com/api/";
const HEADERS = {
  "User-Agent": "LocalCVValidator/1.0",
  From: "comicvine-user@example.com"
};
const MAX_RETRIES = 5;
const RATE_LIMIT_BACKOFF_SECONDS = 60;
const API_DELAY_SECONDS = 1.5;

// SRV-25: ComicVine domain prefixes. The live API requires the domain-prefixed id
// form (e.g. issue/4000-2797/); a bare numeric id (issue/2797/) answers 102
// "Error in URL Format", which fetchLiveEntity maps to null -> "missing_on_live",
// so validation could never produce a real diff in production. Every value here
// was verified against the live API on 2026-11-10 (publisher is 4010, not the
// 4030 first guessed in the TODO).
const DOMAIN_PREFIXES = {
  issue: "4000",
  volume: "4050",
  person: "4040",
  team: "4060",
  story_arc: "4045",
  publisher: "4010",
  concept: "4015"
};

// Fields that legitimately differ between a live entity and the bundled snapshot
// (the mock never refreshes these), or are absent from the bundled data.
const IGNORED_FIELDS = new Set([
  "date_added",
  "date_last_updated",
  "api_detail_url",
  "site_detail_url",
  "image",
  "associated_images",
  "count_of_issues",
  "count_of_issue_appearances",
  "count_of_isssue_appearances",
  "count_of_team_members"
]);

// Normalize a value for comparison: null/undefined/empty-string collapse to null;
// numbers and booleans compare by value; everything else is the stringified form.
function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = String(value).trim();
  return text === "" ? null : text;
}

// Order-insensitive identity for a relationship entry: id + name + role/count, if present.
function entryKey(entry) {
  if (entry === null || typeof entry !== "object") return String(entry);
  return [
    entry.id ?? null,
    entry.name ?? null,
    entry.role ?? null,
    entry.count ?? null
  ].map((part) => String(part ?? "")).join("|");
}

// Identity for a scalar object reference (e.g. a volume's publisher, or a team's
// first_appeared_in_issue): compare the denormalized id + name rather than
// stringifying the whole object, which would read "[object Object]".
function objectKey(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return normalizeValue(value);
  return `${value.id ?? ""}|${value.name ?? ""}`;
}

// Compare one field of a live result against the local one. Returns a diff record
// or null when they match. Arrays compare as order-insensitive sets of entry keys;
// object references compare by id + name; everything else by normalized scalar.
function diffField(name, live, local) {
  if (Array.isArray(live) || Array.isArray(local)) {
    const liveEntries = new Set(Array.isArray(live) ? live.map(entryKey) : []);
    const localEntries = new Set(Array.isArray(local) ? local.map(entryKey) : []);
    const missing = [...liveEntries].filter((k) => !localEntries.has(k));
    const extra = [...localEntries].filter((k) => !localEntries.has(k));
    if (missing.length === 0 && extra.length === 0) return null;
    return { field: name, kind: "array", missing: missing.length, extra: extra.length };
  }
  const liveNorm = objectKey(live);
  const localNorm = objectKey(local);
  if (liveNorm === localNorm) return null;
  return { field: name, kind: "value", live: liveNorm, local: localNorm };
}

// Diff a single live entity object against the locally built one. Relationship
// (collection) fields are skipped here; they are compared separately by the
// caller, which knows whether the live API returned collections for this type.
function diffEntity(singular, live, local) {
  const config = resourceConfig[singular];
  const fields = config?.fields ?? new Set();
  const relationshipFields = config?.relationships ?? new Set();
  const diffs = [];
  const keys = new Set([...Object.keys(live ?? {}), ...Object.keys(local ?? {})]);
  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue;
    if (relationshipFields.has(key)) continue;
    // Skip live-only fields the mock does not project at all (e.g. a live field
    // that was never synced); the bundled data can neither match nor miss them.
    if (!fields.has(key)) continue;
    const liveValue = live?.[key];
    const localValue = local?.[key];
    if (normalizeValue(liveValue) === null && normalizeValue(localValue) === null) continue;
    const diff = diffField(key, liveValue, localValue);
    if (diff) diffs.push(diff);
  }
  return diffs;
}

// Diff the relationship collections of a live entity against the local one.
// Collections carry denormalized refs to entities that often have no local table,
// so only the denormalized id/name/role/count are compared, not full sub-objects.
function diffCollections(singular, live, local) {
  const config = resourceConfig[singular];
  const relationshipFields = config?.relationships ?? new Set();
  const diffs = [];
  for (const field of relationshipFields) {
    const liveValue = live?.[field];
    const localValue = local?.[field];
    const diff = diffField(field, liveValue, localValue);
    if (diff) diffs.push(diff);
  }
  return diffs;
}

// Build the live-API detail URL for one entity. `id` is the bare numeric id; the
// resource's domain prefix is prepended (issue/4000-2797/). An unknown resource
// type falls back to the bare id, preserving the previous (102-answering) behavior.
function buildLiveUrl(singular, id) {
  const prefix = DOMAIN_PREFIXES[singular];
  const idPath = prefix ? `${prefix}-${id}` : String(id);
  return `${API_BASE_URL}${singular}/${idPath}/`;
}

// Fetch a single entity from the live API. Returns the result object, or null if
// the entity is absent (status_code 101) or the call cannot be completed.
async function fetchLiveEntity(singular, id, apiKey) {
  const url = `${buildLiveUrl(singular, id)}?api_key=${encodeURIComponent(apiKey)}&format=json&limit=1`;
  await new Promise((resolve) => setTimeout(resolve, API_DELAY_SECONDS * 1000));

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let body;
    try {
      const response = await fetch(url, { headers: HEADERS });
      body = await response.json();
    } catch {
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }
      return null;
    }

    if (body.status_code === 100) return null; // invalid key: abort, do not retry
    if (body.status_code === 107) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_SECONDS * (attempt + 1) * 1000));
      continue;
    }
    if (body.status_code === 1) return body.results ?? null;
    if (body.status_code === 101) return null; // not found on live
    return null;
  }
  return null; // rate-limit retries exhausted
}

// Validate one local entity against the live API.
//
// Returns { singular, id, status, diffs, collections } where status is one of
// "match" (identical), "mismatch" (differences found), "missing_on_live" (live
// reports 101), or "unavailable" (live call could not be completed).
// `compareCollections` gates the collection diff: the live API returns collections
// only for issue resources, so non-issue types should skip it (see UPD-1).
// `fetchFn` is an injectable replacement for fetchLiveEntity (used by tests).
async function validateEntity(singular, id, localResult, apiKey, compareCollections = false, fetchFn = fetchLiveEntity) {
  const live = await fetchFn(singular, id, apiKey);
  if (live === null) {
    return { singular, id, status: "missing_on_live", diffs: [], collections: [] };
  }
  const diffs = diffEntity(singular, live, localResult);
  const collections = compareCollections ? diffCollections(singular, live, localResult) : [];
  return {
    singular,
    id,
    status: diffs.length > 0 || collections.length > 0 ? "mismatch" : "match",
    diffs,
    collections
  };
}

module.exports = {
  validateEntity,
  fetchLiveEntity,
  buildLiveUrl,
  DOMAIN_PREFIXES,
  diffEntity,
  diffCollections,
  API_BASE_URL,
  MAX_RETRIES,
  RATE_LIMIT_BACKOFF_SECONDS,
  API_DELAY_SECONDS
};
