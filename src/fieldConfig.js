// Per-resource field allowlists and relationship (collection) sets, shared by the
// server (field_list projection) and the live-API validator (field classification).

// SRV-25: ComicVine domain prefixes. The live API requires the domain-prefixed id
// form (e.g. issue/4000-2797/); a bare numeric id (issue/2797/) answers 102
// "Error in URL Format", which fetchLiveEntity maps to null -> "missing_on_live",
// so validation could never produce a real diff in production. Every value here
// was verified against the live API on 2026-11-10 (publisher is 4010, not the
// 4030 first guessed in the TODO).
const API_BASE_URL = "https://comicvine.gamespot.com/api/";
const DOMAIN_PREFIXES = {
  issue: "4000",
  volume: "4050",
  person: "4040",
  team: "4060",
  story_arc: "4045",
  publisher: "4010",
  concept: "4015",
  // SRV-3: the three new resources, verified against the live API (and the
  // verbatim raw-API dump) on 2026-11-13.
  character: "4005",
  location: "4020",
  power: "4035",
  // UPD-15: the first_appeared_in_issue reference's api_detail_url uses the
  // resource-type segment `first_appeared_in_issue` (not `issue`) with the same
  // 4000 numeric prefix — …/api/first_appeared_in_issue/4000-<id>/. Verified
  // against the verbatim rawapi dump: buildApiDetailUrl reproduces the live URL.
  first_appeared_in_issue: "4000"
};

// SRV-21: the canonical api_detail_url for an entity: base URL + resource type +
// domain-prefixed id. The live API always emits it for these resources, and the
// stored column (where one exists) matches it for every row, so it can be derived
// from the id alone. Returns null when the resource has no known domain prefix.
function buildApiDetailUrl(singular, id) {
  const prefix = DOMAIN_PREFIXES[singular];
  if (!prefix) return null;
  return `${API_BASE_URL}${singular}/${prefix}-${id}/`;
}

const volumeFields = new Set([
  "aliases", "api_detail_url", "count_of_issues", "date_added", "date_last_updated",
  "character_credits", "concept_credits", "deck", "description", "first_issue", "id",
  "image", "last_issue", "location_credits", "name", "object_credits", "person_credits",
  "publisher", "site_detail_url", "start_year", "team_credits"
]);
const volumeCreditFields = new Set([
  "character_credits", "concept_credits", "location_credits", "object_credits",
  "person_credits", "team_credits"
]);
// SRV-22: the live API emits the team's appearance count and disbanded collection
// under its typo names; the allowlist uses the live names so field_list matches
// the live API (same as person, SRV-20).
const teamFields = new Set([
  "aliases", "api_detail_url", "count_of_isssue_appearances", "count_of_team_members",
  "character_enemies", "character_friends", "characters", "date_added", "date_last_updated",
  "deck", "description", "disbanded_in_issues", "first_appeared_in_issue", "id", "image",
  "issue_credits", "isssues_disbanded_in", "movies", "name", "publisher", "site_detail_url",
  "story_arc_credits", "volume_credits"
]);
const teamRelationshipFields = new Set([
  "character_enemies", "character_friends", "characters", "disbanded_in_issues",
  "issue_credits", "isssues_disbanded_in", "movies", "story_arc_credits", "volume_credits"
]);
const storyArcFields = new Set([
  "aliases", "api_detail_url", "count_of_issue_appearances", "date_added",
  "date_last_updated", "deck", "description", "first_appeared_in_issue", "id", "image",
  "issues", "movies", "name", "publisher", "site_detail_url"
]);
const storyArcRelationshipFields = new Set(["issues", "movies"]);
// SRV-26: the live API emits the appearance count under its typo name and always
// returns the three relationship collections (never null); the allowlist uses the
// live names so field_list matches the live API (same as person SRV-20 / team SRV-22).
const conceptFields = new Set([
  "aliases", "api_detail_url", "count_of_isssue_appearances", "date_added",
  "date_last_updated", "deck", "description", "first_appeared_in_issue", "id",
  "image", "issue_credits", "movies", "name", "site_detail_url", "start_year",
  "volume_credits"
]);
const conceptRelationshipFields = new Set(["issue_credits", "movies", "volume_credits"]);
// SRV-3: the live API emits the appearance count under its corrected spelling
// for characters and locations (the January raw-API dump shows
// `count_of_issue_appearances`, unlike person/team/concept which use the typo).
const characterFields = new Set([
  "aliases", "api_detail_url", "birth", "character_enemies", "character_friends",
  "count_of_issue_appearances", "creators", "date_added", "date_last_updated",
  "deck", "description", "first_appeared_in_issue", "gender", "id", "image",
  "issues_died_in", "name", "origin", "powers", "publisher", "real_name",
  "site_detail_url", "story_arc_credits", "teams", "team_enemies", "team_friends",
  "volume_credits", "movies"
]);
const characterRelationshipFields = new Set([
  "character_enemies", "character_friends", "creators", "issues_died_in",
  "movies", "powers", "publisher", "origin", "story_arc_credits", "teams",
  "team_enemies", "team_friends", "volume_credits"
]);
const locationFields = new Set([
  "aliases", "api_detail_url", "count_of_issue_appearances", "date_added",
  "date_last_updated", "deck", "description", "first_appeared_in_issue", "id",
  "image", "issue_credits", "movies", "name", "site_detail_url", "start_year",
  "story_arc_credits", "volume_credits"
]);
const locationRelationshipFields = new Set(["issue_credits", "movies", "story_arc_credits", "volume_credits"]);
const powerFields = new Set([
  "aliases", "api_detail_url", "characters", "date_added", "date_last_updated",
  "description", "id", "image", "name", "site_detail_url"
]);
const powerRelationshipFields = new Set(["characters"]);
const publisherFields = new Set([
  "aliases", "api_detail_url", "characters", "date_added", "date_last_updated", "deck",
  "description", "id", "image", "location_address", "location_city", "location_state",
  "name", "site_detail_url", "story_arcs", "teams", "volumes"
]);
const publisherRelationshipFields = new Set(["characters", "story_arcs", "teams", "volumes"]);
// SRV-20: the live API emits the person's issue credits as `issues` and the
// appearance count under its typo name `count_of_isssue_appearances`; the allowlist
// uses the live names so field_list matches the live API.
const personFields = new Set([
  "aliases", "api_detail_url", "birth", "count_of_isssue_appearances", "country",
  "created_characters", "date_added", "date_last_updated", "death", "deck", "description",
  "email", "gender", "hometown", "id", "image", "issues", "name",
  "site_detail_url", "story_arc_credits", "volume_credits", "website"
]);
const personRelationshipFields = new Set([
  "created_characters", "issues", "story_arc_credits", "volume_credits"
]);

// SRV-19: image is included — the live API returns it for issues (built from the
// stored image_url), so it is a valid field_list target.
const issueFields = new Set([
  "id", "name", "aliases", "api_detail_url", "deck", "description", "image", "issue_number",
  "cover_date", "store_date", "date_added", "date_last_updated", "has_staff_review",
  "site_detail_url", "volume", "character_credits", "person_credits", "team_credits",
  "location_credits", "story_arc_credits", "object_credits", "concept_credits",
  "associated_images", "character_died_in", "team_disbanded_in",
  "first_appearance_characters", "first_appearance_concepts", "first_appearance_locations",
  "first_appearance_objects", "first_appearance_storyarcs", "first_appearance_teams"
]);
const issueRelationshipFields = new Set([
  "character_credits", "person_credits", "team_credits", "location_credits",
  "story_arc_credits", "object_credits", "concept_credits", "associated_images",
  "character_died_in", "team_disbanded_in",
  "first_appearance_characters", "first_appearance_concepts", "first_appearance_locations",
  "first_appearance_objects", "first_appearance_storyarcs", "first_appearance_teams"
]);

// Per-resource field allowlist and relationship (defaults to []) sets for projection.
const resourceConfig = {
  volume: { fields: volumeFields, relationships: volumeCreditFields },
  team: { fields: teamFields, relationships: teamRelationshipFields },
  story_arc: { fields: storyArcFields, relationships: storyArcRelationshipFields },
  concept: { fields: conceptFields, relationships: conceptRelationshipFields },
  publisher: { fields: publisherFields, relationships: publisherRelationshipFields },
  person: { fields: personFields, relationships: personRelationshipFields },
  issue: { fields: issueFields, relationships: issueRelationshipFields },
  // SRV-3: the three new resources.
  character: { fields: characterFields, relationships: characterRelationshipFields },
  location: { fields: locationFields, relationships: locationRelationshipFields },
  power: { fields: powerFields, relationships: powerRelationshipFields }
};

module.exports = { resourceConfig, API_BASE_URL, DOMAIN_PREFIXES, buildApiDetailUrl };
