// Per-resource field allowlists and relationship (collection) sets, shared by the
// server (field_list projection) and the live-API validator (field classification).

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
const teamFields = new Set([
  "aliases", "api_detail_url", "count_of_issue_appearances", "count_of_team_members",
  "character_enemies", "character_friends", "characters", "date_added", "date_last_updated",
  "deck", "description", "disbanded_in_issues", "first_appeared_in_issue", "id", "image",
  "issue_credits", "issues_disbanded_in", "movies", "name", "publisher", "site_detail_url",
  "story_arc_credits", "volume_credits"
]);
const teamRelationshipFields = new Set([
  "character_enemies", "character_friends", "characters", "disbanded_in_issues",
  "issue_credits", "issues_disbanded_in", "movies", "story_arc_credits", "volume_credits"
]);
const storyArcFields = new Set([
  "aliases", "api_detail_url", "count_of_issue_appearances", "date_added",
  "date_last_updated", "deck", "description", "first_appeared_in_issue", "id", "image",
  "issues", "movies", "name", "publisher", "site_detail_url"
]);
const storyArcRelationshipFields = new Set(["issues", "movies"]);
const conceptFields = new Set([
  "aliases", "api_detail_url", "count_of_issue_appearances", "date_added",
  "date_last_updated", "deck", "description", "first_appeared_in_issue", "id",
  "image", "name", "site_detail_url", "start_year"
]);
const conceptRelationshipFields = new Set();
const publisherFields = new Set([
  "aliases", "api_detail_url", "characters", "date_added", "date_last_updated", "deck",
  "description", "id", "image", "location_address", "location_city", "location_state",
  "name", "site_detail_url", "story_arcs", "teams", "volumes"
]);
const publisherRelationshipFields = new Set(["characters", "story_arcs", "teams", "volumes"]);
const personFields = new Set([
  "aliases", "api_detail_url", "birth", "count_of_issue_appearances", "country",
  "created_characters", "date_added", "date_last_updated", "death", "deck", "description",
  "email", "gender", "hometown", "id", "image", "issue_credits", "name",
  "site_detail_url", "story_arc_credits", "volume_credits", "website"
]);
const personRelationshipFields = new Set([
  "created_characters", "issue_credits", "story_arc_credits", "volume_credits"
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
  issue: { fields: issueFields, relationships: issueRelationshipFields }
};

module.exports = { resourceConfig };
