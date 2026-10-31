#!/usr/bin/env python3
"""
ComicVine SQLite Database Updater

A stand-alone script to keep a localcv.db SQLite database updated with
new ComicVine data. Fetches publishers, people, volumes, issues, teams,
and story arcs that have been added or modified since the last sync.

Notes on the sync strategy:
  * Publishers, people, volumes, teams, and story arcs use an upsert that
    only touches the scalar fields the live API still returns. The live API
    no longer exposes the related-object arrays for these object types, so
    the UPDATE clause leaves the backfilled collections untouched (they are
    only populated on brand-new rows, defaulting to "[]").
  * Issues are fully refreshed from the issue detail endpoint, which still
    returns every credit array.

This version creates dated copies: localcv-YYYY-MM-DD.db

Usage:
    # Interactive mode
    python sqlite_cv_updater.py [database_path]
    
    # Non-interactive mode (for cron) - creates today's database from yesterday's
    python sqlite_cv_updater.py --non-interactive --db-dir /path/to/db/directory
    
    # Full synchronization (one-time initial load / repair): fetch EVERY record
    # from the API instead of only records changed since the last sync.
    python sqlite_cv_updater.py --full [database_path]
    
    # Using environment variable
    export COMICVINE_API_KEY=your_key_here
    python sqlite_cv_updater.py --non-interactive --db-dir /path/to/db/directory

Notes on --full:
  A full sync removes the date_last_updated filter and walks the entire API for
  each object type. It makes far more API calls (thousands) and can run for a
  long time, so it is intended for a one-time initial load or to repair a
  database, not for routine daily runs.
  Because the live API no longer returns the related-object/credit arrays for
  publishers, people, volumes, teams, and story arcs, a full sync can add rows
  for objects missing from the database but cannot repopulate those collections
  on existing rows (they keep their backfilled values; brand-new rows default
  to "[]"). Issues are an exception: the issue detail endpoint still returns
  every credit array, so a full issue sync fully refreshes all issue data.

Example crontab entry (runs daily at 3 AM):
    0 3 * * * /usr/bin/python3 /path/to/sqlite_cv_updater.py --non-interactive --db-dir /path/to/db >> /var/log/comicvine_sync.log 2>&1
"""

import argparse
import json
import os
import shutil
import smtplib
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from io import StringIO
from pathlib import Path
from typing import Any

try:
    import requests
except ImportError:
    print("ERROR: requests library is required.")
    print("Install with: pip install requests")
    sys.exit(1)

try:
    import tkinter as tk
    from tkinter import filedialog
    HAS_GUI = True
except ImportError:
    HAS_GUI = False

# API Configuration
API_BASE_URL = "https://comicvine.gamespot.com/api/"
HEADERS = {"User-Agent": "LocalCVUpdater/1.0", "From": "comicvine-user@example.com"}

# Rate limiting
API_DELAY = 1.5  # Seconds between API calls (ComicVine limit is ~200/hour)
MAX_RETRIES = 5  # Retries per call; gives an exhausted rate limit time to clear
# The live API signals rate limiting with HTTP 200 and status_code 107 in the
# JSON body (e.g. "Rate limit exceeded. Slow down cowboy."). We back off this
# long (scaled per attempt) and retry instead of treating it as a hard failure.
RATE_LIMIT_STATUS = 107
RATE_LIMIT_BACKOFF = 60  # Base seconds to wait on a rate-limit response


class LogCapture:
    """Captures log output for email reporting."""
    
    def __init__(self):
        self.buffer = StringIO()
        self.start_time = datetime.now()
        
    def write(self, message: str) -> None:
        """Write a message to the buffer."""
        self.buffer.write(message)
        if not message.endswith('\n'):
            self.buffer.write('\n')
    
    def get_contents(self) -> str:
        """Get all captured log contents."""
        return self.buffer.getvalue()
    
    def get_duration(self) -> str:
        """Get the duration since start."""
        duration = datetime.now() - self.start_time
        hours, remainder = divmod(int(duration.total_seconds()), 3600)
        minutes, seconds = divmod(remainder, 60)
        if hours > 0:
            return f"{hours}h {minutes}m {seconds}s"
        elif minutes > 0:
            return f"{minutes}m {seconds}s"
        else:
            return f"{seconds}s"


class ComicVineUpdater:
    """Updates a SQLite database with ComicVine data."""

    def __init__(self, db_path: str, api_key: str, verbose: bool = True, log_capture: LogCapture | None = None, full: bool = False):
        self.db_path = Path(db_path)
        self.api_key = api_key
        self.verbose = verbose
        self.log_capture = log_capture
        # Full sync fetches every record (no date filter) instead of only
        # records updated since the last sync.
        self.full = full
        self.conn: sqlite3.Connection | None = None
        self.stats = {
            "publishers_added": 0,
            "publishers_updated": 0,
            "persons_added": 0,
            "persons_updated": 0,
            "volumes_added": 0,
            "volumes_updated": 0,
            "issues_added": 0,
            "issues_updated": 0,
            "teams_added": 0,
            "teams_updated": 0,
            "storyarcs_added": 0,
            "storyarcs_updated": 0,
            "api_calls": 0,
        }

    def log(self, message: str, force: bool = False) -> None:
        """Print message if verbose mode is enabled."""
        if self.verbose or force:
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            formatted = f"[{timestamp}] {message}"
            print(formatted)
        
        # Always capture to log buffer if available (for email)
        if self.log_capture:
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            self.log_capture.write(f"[{timestamp}] {message}")

    def connect(self) -> bool:
        """Connect to the SQLite database."""
        if not self.db_path.exists():
            self.log(f"ERROR: Database not found: {self.db_path}", force=True)
            return False

        try:
            self.conn = sqlite3.connect(self.db_path)
            self.conn.row_factory = sqlite3.Row
            # Enable WAL mode for better concurrent access
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA synchronous=NORMAL")
            self.log(f"Connected to database: {self.db_path}")
            return True
        except sqlite3.Error as e:
            self.log(f"ERROR: Could not connect to database: {e}", force=True)
            return False

    def close(self) -> None:
        """Close the database connection."""
        if self.conn:
            self.conn.close()
            self.conn = None

    def ensure_resource_tables(self) -> None:
        """Create cv_team / cv_storyarc tables if they don't exist (added after the
        original schema). Kept in sync with the backfill migration."""
        if not self.conn:
            return

        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS cv_team (
                id INTEGER PRIMARY KEY,
                name TEXT,
                publisher TEXT,
                aliases TEXT,
                count_of_team_members INTEGER,
                count_of_issue_appearances INTEGER,
                deck TEXT,
                description TEXT,
                date_added TEXT,
                date_last_updated TEXT,
                image_url TEXT,
                site_detail_url TEXT,
                first_appeared_in_issue TEXT,
                character_enemies TEXT,
                character_friends TEXT,
                characters TEXT,
                disbanded_in_issues TEXT,
                issue_credits TEXT,
                issues_disbanded_in TEXT,
                movies TEXT,
                story_arc_credits TEXT,
                volume_credits TEXT
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS cv_storyarc (
                id INTEGER PRIMARY KEY,
                name TEXT,
                publisher TEXT,
                aliases TEXT,
                count_of_issue_appearances INTEGER,
                deck TEXT,
                description TEXT,
                date_added TEXT,
                date_last_updated TEXT,
                image_url TEXT,
                site_detail_url TEXT,
                first_appeared_in_issue TEXT,
                issues TEXT,
                movies TEXT
            )
        """)

        # Seed last_sync_date for the new endpoints at the raw-dump snapshot date
        # (2026-01-22) so the first run syncs everything added since the
        # backfill, without clobbering an existing sync date.
        snapshot = "2026-01-22"
        timestamp = datetime.now().isoformat()
        for endpoint in ("teams", "storyarcs"):
            self.conn.execute(
                """INSERT INTO cv_sync_metadata (endpoint, last_sync_date, last_sync_timestamp)
                   VALUES (?, ?, ?)
                   ON CONFLICT(endpoint) DO NOTHING""",
                (endpoint, snapshot, timestamp),
            )
        self.conn.commit()

    # SRV-5: the six resource tables, in search order. Each is indexed on the
    # searchable text columns (name, aliases, deck, description); the trigram
    # tokenizer is case-insensitive and matches substrings, the same semantics
    # the server's legacy LIKE matching used.
    FTS_RESOURCES = [
        ("cv_publisher", "cv_publisher_fts"),
        ("cv_person", "cv_person_fts"),
        ("cv_volume", "cv_volume_fts"),
        ("cv_issue", "cv_issue_fts"),
        ("cv_team", "cv_team_fts"),
        ("cv_storyarc", "cv_storyarc_fts"),
    ]

    def ensure_fts_tables(self) -> None:
        """Create the per-resource FTS5 trigram tables (idempotent).

        Each index is external-content, keyed on the base table's id/rowid, and
        covers only the text columns that actually exist on that table. Only the
        tables the server searches are created; the legacy raw-dump ``volume_fts``
        is left alone (rebuilt by ``rebuild_fts_index``).
        """
        if not self.conn:
            return
        for table, fts in self.FTS_RESOURCES:
            row = self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                (table,),
            ).fetchone()
            if not row:
                continue  # base resource table absent (e.g. minimal DB)
            base_columns = {c[1] for c in self.conn.execute(f"PRAGMA table_info({table})").fetchall()}
            if "id" not in base_columns:
                continue
            columns = [c for c in ("name", "aliases", "deck", "description") if c in base_columns]
            if not columns:
                continue
            exists = self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                (fts,),
            ).fetchone()
            if exists:
                continue  # already created; rebuilt in rebuild_fts_index
            try:
                self.conn.execute(
                    f"CREATE VIRTUAL TABLE {fts} USING fts5("
                    f"{', '.join(columns)}, content='{table}', "
                    f"content_rowid='id', tokenize='trigram case_sensitive 0')"
                )
                self.log(f"  Created {fts} ({', '.join(columns)})")
            except sqlite3.Error as e:
                self.log(f"  Warning: could not create {fts}: {e}")

    def ensure_metadata_table(self) -> None:
        """Create metadata table if it doesn't exist."""
        if not self.conn:
            return
        
        # Create table if not exists with new schema
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS cv_sync_metadata (
                endpoint TEXT PRIMARY KEY,
                last_sync_date TEXT NOT NULL,
                last_sync_timestamp TEXT NOT NULL,
                resume_state TEXT
            )
        """)
        
        # Check if resume_state column exists (for migration of existing DBs)
        cur = self.conn.execute("PRAGMA table_info(cv_sync_metadata)")
        columns = [info[1] for info in cur.fetchall()]
        if "resume_state" not in columns:
            self.log("  Adding resume_state column to cv_sync_metadata...")
            try:
                self.conn.execute("ALTER TABLE cv_sync_metadata ADD COLUMN resume_state TEXT")
            except sqlite3.OperationalError as e:
                self.log(f"  Warning: Could not add resume_state column: {e}")

        self.conn.commit()

    def get_endpoint_last_sync(self, endpoint: str) -> str | None:
        """Get the last sync date for a specific endpoint."""
        if not self.conn:
            return None
        try:
            cur = self.conn.execute(
                "SELECT last_sync_date FROM cv_sync_metadata WHERE endpoint = ?",
                (endpoint,)
            )
            row = cur.fetchone()
            return row[0] if row else None
        except sqlite3.OperationalError:
            return None

    def set_endpoint_last_sync(self, endpoint: str, date_str: str) -> None:
        """Set the last sync date for a specific endpoint."""
        if not self.conn:
            return
        timestamp = datetime.now().isoformat()
        
        # Use upsert to preserve resume_state if it exists
        self.conn.execute(
            """INSERT INTO cv_sync_metadata (endpoint, last_sync_date, last_sync_timestamp) 
               VALUES (?, ?, ?)
               ON CONFLICT(endpoint) DO UPDATE SET
               last_sync_date=excluded.last_sync_date,
               last_sync_timestamp=excluded.last_sync_timestamp""",
            (endpoint, date_str, timestamp),
        )
        self.conn.commit()

    def get_resume_state(self, endpoint: str) -> dict[str, Any] | None:
        """Get the resumption state for an endpoint."""
        if not self.conn:
            return None
        try:
            cur = self.conn.execute(
                "SELECT resume_state FROM cv_sync_metadata WHERE endpoint = ?",
                (endpoint,)
            )
            row = cur.fetchone()
            if row and row[0]:
                return json.loads(row[0])
            return None
        except (sqlite3.OperationalError, json.JSONDecodeError):
            return None

    def save_resume_state(self, endpoint: str, state: dict[str, Any]) -> None:
        """Save the resumption state for an endpoint."""
        if not self.conn:
            return
        try:
            state_json = json.dumps(state)
            # update existing row, don't insert new one if not exists (metadata should exist if we are syncing)
            self.conn.execute(
                "UPDATE cv_sync_metadata SET resume_state = ? WHERE endpoint = ?",
                (state_json, endpoint)
            )
            # If update affected 0 rows, we might need to insert (though unlikely if sync started)
            if self.conn.total_changes == 0:
                 # fallback insert with dummy date if needed, relying on ensure_metadata_table logic usually
                 pass
            self.conn.commit()
        except sqlite3.Error as e:
            self.log(f"  Warning: Could not save resume state: {e}")

    def clear_resume_state(self, endpoint: str) -> None:
        """Clear the resumption state for an endpoint."""
        if not self.conn:
            return
        try:
            self.conn.execute(
                "UPDATE cv_sync_metadata SET resume_state = NULL WHERE endpoint = ?",
                (endpoint,)
            )
            self.conn.commit()
        except sqlite3.Error:
            pass

    def calculate_safe_start_date(self, endpoint: str) -> str:
        """
        Calculate a safe start date for an endpoint by checking its last sync,
        then going back 1 day for safety margin.
        """
        last_sync = self.get_endpoint_last_sync(endpoint)
        
        if last_sync:
            try:
                last_date = datetime.strptime(last_sync, "%Y-%m-%d")
                # Go back 1 day for safety
                safe_date = (last_date - timedelta(days=1)).strftime("%Y-%m-%d")
                return safe_date
            except ValueError:
                pass
        
        # Default to 30 days ago if we can't determine
        default_date = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
        return default_date

    @staticmethod
    def _jsonify(value: Any) -> Any:
        """
        Make a value safe to bind into a SQLite parameter.

        The ComicVine API sometimes returns nested objects or arrays in fields
        that are otherwise scalar (e.g. `publisher` on teams/story arcs, an
        occasional dict `gender`). Binding a dict/list directly raises
        sqlite3.ProgrammingError, so dict/list values are serialized to JSON
        strings (matching the backfill storage format) while None, strings,
        numbers, and bools pass through unchanged.
        """
        if isinstance(value, (dict, list)):
            return json.dumps(value, ensure_ascii=False)
        return value

    def api_call(
        self, endpoint: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        """Make an API call to ComicVine with rate limiting and retries."""
        if params is None:
            params = {}

        params["api_key"] = self.api_key
        params["format"] = "json"

        url = f"{API_BASE_URL}{endpoint}"

        for attempt in range(MAX_RETRIES):
            try:
                time.sleep(API_DELAY)
                self.stats["api_calls"] += 1
                response = requests.get(url, params=params, headers=HEADERS, timeout=30)

                # Handle rate limiting
                if response.status_code == 420:
                    wait_time = 600 * (attempt + 1)
                    self.log(f"  Rate limited. Waiting {wait_time} seconds...")
                    time.sleep(wait_time)
                    continue

                response.raise_for_status()
                data = response.json()

                # The live API returns HTTP 200 with status_code 107 when the
                # per-hour call limit is exhausted. Back off and retry so the
                # window can clear, instead of treating it as a hard failure.
                if data.get("status_code") == RATE_LIMIT_STATUS:
                    wait_time = RATE_LIMIT_BACKOFF * (attempt + 1)
                    self.log(
                        f"  Rate limit exceeded (status 107). "
                        f"Waiting {wait_time}s before retry "
                        f"({attempt + 1}/{MAX_RETRIES})..."
                    )
                    time.sleep(wait_time)
                    continue

                if data.get("status_code") == 100:
                    self.log("ERROR: Invalid API key!", force=True)
                    return None

                if data.get("status_code") != 1:
                    error = data.get("error", "Unknown error")
                    self.log(f"  API error: {error}")
                    return None

                return data

            except requests.exceptions.Timeout:
                self.log(f"  Timeout on attempt {attempt + 1}/{MAX_RETRIES}")
                time.sleep(5)
            except requests.exceptions.RequestException as e:
                self.log(f"  Request error: {e}")
                if attempt < MAX_RETRIES - 1:
                    time.sleep(5)

        return None

    def sync_publishers(self, start_date: str, end_date: str, full: bool = False) -> None:
        """Sync publishers updated since start_date (or all publishers if full)."""
        self.log("\n--- Syncing Publishers ---" + (" (FULL)" if full else ""))
        if not self.conn:
            return

        offset = 0
        limit = 100

        while True:
            params = {
                "field_list": "id,name,aliases,api_detail_url,deck,description,"
                              "date_added,date_last_updated,location_address,"
                              "location_city,location_state,image,site_detail_url",
                "offset": offset,
                "limit": limit,
            }
            if not full:
                params["filter"] = f"date_last_updated:{start_date}|{end_date}"
            params["sort"] = "date_last_updated:asc"

            data = self.api_call("publishers/", params)
            if not data:
                # If API call failed (after retries), we must stop and NOT update sync date
                raise RuntimeError("API call failed for publishers")

            results = data.get("results", [])
            if not results:
                break

            for pub in results:
                pub_id = pub.get("id")
                if not pub_id:
                    continue

                name = pub.get("name")
                aliases = pub.get("aliases")
                api_detail_url = pub.get("api_detail_url")
                deck = pub.get("deck")
                description = pub.get("description")
                date_added = pub.get("date_added")
                date_last_updated = pub.get("date_last_updated")
                location_address = pub.get("location_address")
                location_city = pub.get("location_city")
                location_state = pub.get("location_state")
                image_url = None
                if pub.get("image"):
                    image_url = pub["image"].get("original_url")
                site_url = pub.get("site_detail_url")

                # Check if exists
                cur = self.conn.execute(
                    "SELECT id FROM cv_publisher WHERE id = ?", (pub_id,)
                )
                exists = cur.fetchone() is not None

                # Upsert the scalar fields the API still returns. The live API
                # no longer exposes the related-object arrays (characters,
                # story_arcs, teams, volumes), so the UPDATE clause leaves them
                # untouched to preserve the raw-dump backfill. On a brand-new
                # row the collections default to "[]" (matching the backfill
                # shape) since the API no longer provides them.
                self.conn.execute(
                    """INSERT INTO cv_publisher 
                       (id, name, image_url, site_detail_url, aliases, api_detail_url,
                        deck, description, date_added, date_last_updated,
                        location_address, location_city, location_state,
                        characters, story_arcs, teams, volumes) 
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                               COALESCE(?, '[]'), COALESCE(?, '[]'),
                               COALESCE(?, '[]'), COALESCE(?, '[]'))
                       ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        image_url = excluded.image_url,
                        site_detail_url = excluded.site_detail_url,
                        aliases = excluded.aliases,
                        api_detail_url = excluded.api_detail_url,
                        deck = excluded.deck,
                        description = excluded.description,
                        date_added = excluded.date_added,
                        date_last_updated = excluded.date_last_updated,
                        location_address = excluded.location_address,
                        location_city = excluded.location_city,
                        location_state = excluded.location_state""",
                    (
                        pub_id, self._jsonify(name), image_url, site_url,
                        self._jsonify(aliases), api_detail_url,
                        self._jsonify(deck), self._jsonify(description),
                        self._jsonify(date_added),
                        self._jsonify(date_last_updated),
                        self._jsonify(location_address),
                        self._jsonify(location_city),
                        self._jsonify(location_state),
                        json.dumps(pub.get("characters") or [], ensure_ascii=False),
                        json.dumps(pub.get("story_arcs") or [], ensure_ascii=False),
                        json.dumps(pub.get("teams") or [], ensure_ascii=False),
                        json.dumps(pub.get("volumes") or [], ensure_ascii=False),
                    ),
                )

                if exists:
                    self.stats["publishers_updated"] += 1
                else:
                    self.stats["publishers_added"] += 1

            self.conn.commit()

            total = data.get("number_of_total_results", 0)
            self.log(f"  Processed {offset + len(results)}/{total} publishers")

            if len(results) < limit:
                break
            offset += limit
        
        # Update metadata after successful completion
        self.set_endpoint_last_sync("publishers", end_date)

    def sync_persons(self, start_date: str, end_date: str, full: bool = False) -> None:
        """Sync persons/creators updated since start_date (or all if full)."""
        self.log("\n--- Syncing Persons ---" + (" (FULL)" if full else ""))
        if not self.conn:
            return

        offset = 0
        limit = 100

        while True:
            params = {
                "field_list": "id,name,aliases,api_detail_url,birth,country,death,"
                              "gender,hometown,email,website,image,site_detail_url,"
                              "count_of_isssue_appearances,deck,description,"
                              "date_added,date_last_updated",
                "offset": offset,
                "limit": limit,
            }
            if not full:
                params["filter"] = f"date_last_updated:{start_date}|{end_date}"
            params["sort"] = "date_last_updated:asc"

            data = self.api_call("people/", params)
            if not data:
                raise RuntimeError("API call failed for people")

            results = data.get("results", [])
            if not results:
                break

            for person in results:
                person_id = person.get("id")
                if not person_id:
                    continue

                name = person.get("name")
                aliases = person.get("aliases")
                api_detail_url = person.get("api_detail_url")
                birth = person.get("birth")
                country = person.get("country")
                death = person.get("death")
                gender = person.get("gender")
                hometown = person.get("hometown")
                email = person.get("email")
                website = person.get("website")
                image_url = None
                if person.get("image"):
                    image_url = person["image"].get("original_url")
                site_url = person.get("site_detail_url")
                # The API spells this key with a doubled 's'
                count_of_issue_appearances = person.get(
                    "count_of_isssue_appearances"
                ) or person.get("count_of_issue_appearances")
                deck = person.get("deck")
                description = person.get("description")
                date_added = person.get("date_added")
                date_last_updated = person.get("date_last_updated")

                # Check if exists
                cur = self.conn.execute(
                    "SELECT id FROM cv_person WHERE id = ?", (person_id,)
                )
                exists = cur.fetchone() is not None

                # Upsert only the scalar fields the API still returns. The
                # live API no longer exposes the related-object arrays
                # (created_characters, issue_credits, story_arc_credits,
                # volume_credits), so they are left untouched to preserve the
                # values from the raw-dump backfill.
                self.conn.execute(
                    """INSERT INTO cv_person 
                       (id, name, aliases, api_detail_url, birth, country, death,
                        gender, hometown, email, website, image_url, deck,
                        description, date_added, date_last_updated,
                        count_of_issue_appearances, site_detail_url) 
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        aliases = excluded.aliases,
                        api_detail_url = excluded.api_detail_url,
                        birth = excluded.birth,
                        country = excluded.country,
                        death = excluded.death,
                        gender = excluded.gender,
                        hometown = excluded.hometown,
                        email = excluded.email,
                        website = excluded.website,
                        image_url = excluded.image_url,
                        deck = excluded.deck,
                        description = excluded.description,
                        date_added = excluded.date_added,
                        date_last_updated = excluded.date_last_updated,
                        count_of_issue_appearances = excluded.count_of_issue_appearances,
                        site_detail_url = excluded.site_detail_url""",
                    (
                        person_id, name, self._jsonify(aliases),
                        api_detail_url, self._jsonify(birth),
                        self._jsonify(country), self._jsonify(death),
                        self._jsonify(gender), self._jsonify(hometown),
                        self._jsonify(email), self._jsonify(website), image_url,
                        self._jsonify(deck), self._jsonify(description),
                        self._jsonify(date_added),
                        self._jsonify(date_last_updated),
                        self._jsonify(count_of_issue_appearances), site_url,
                    ),
                )

                if exists:
                    self.stats["persons_updated"] += 1
                else:
                    self.stats["persons_added"] += 1

            self.conn.commit()

            total = data.get("number_of_total_results", 0)
            self.log(f"  Processed {offset + len(results)}/{total} persons")

            if len(results) < limit:
                break
            offset += limit
        
        # Update metadata after successful completion
        self.set_endpoint_last_sync("people", end_date)

    def sync_volumes(self, start_date: str, end_date: str, full: bool = False) -> None:
        """Sync volumes updated since start_date (or all volumes if full)."""
        self.log("\n--- Syncing Volumes ---" + (" (FULL)" if full else ""))
        if not self.conn:
            return

        offset = 0
        limit = 100

        while True:
            params = {
                "field_list": "id,name,aliases,start_year,publisher,count_of_issues,"
                              "description,image,site_detail_url,api_detail_url,deck,"
                              "date_added,date_last_updated,first_issue,last_issue",
                "offset": offset,
                "limit": limit,
            }
            if not full:
                params["filter"] = f"date_last_updated:{start_date}|{end_date}"
            params["sort"] = "date_last_updated:asc"

            data = self.api_call("volumes/", params)
            if not data:
                raise RuntimeError("API call failed for volumes")

            results = data.get("results", [])
            if not results:
                break

            for vol in results:
                vol_id = vol.get("id")
                if not vol_id:
                    continue

                name = vol.get("name")
                aliases = vol.get("aliases")
                start_year = vol.get("start_year")
                publisher_id = None
                if vol.get("publisher"):
                    publisher_id = vol["publisher"].get("id")
                count_of_issues = vol.get("count_of_issues")
                description = vol.get("description")
                image_url = None
                if vol.get("image"):
                    image_url = vol["image"].get("original_url")
                site_url = vol.get("site_detail_url")
                api_detail_url = vol.get("api_detail_url")
                deck = vol.get("deck")
                date_added = vol.get("date_added")
                date_last_updated = vol.get("date_last_updated")
                # Stored as JSON objects, matching the backfill migration
                first_issue = json.dumps(vol.get("first_issue"), ensure_ascii=False) if vol.get("first_issue") else None
                last_issue = json.dumps(vol.get("last_issue"), ensure_ascii=False) if vol.get("last_issue") else None

                # Check if exists
                cur = self.conn.execute(
                    "SELECT id FROM cv_volume WHERE id = ?", (vol_id,)
                )
                exists = cur.fetchone() is not None

                # Upsert the scalar fields plus first/last issue. The live API
                # no longer returns the credit arrays (characters, concepts,
                # locations, objects, people, teams), so they are left untouched
                # to preserve the raw-dump backfill. COALESCE keeps the existing
                # first/last issue when the API returns null (e.g. the issue was
                # deleted) rather than wiping the backfilled value.
                self.conn.execute(
                    """INSERT INTO cv_volume 
                       (id, name, aliases, start_year, publisher_id, count_of_issues,
                        description, image_url, site_detail_url, api_detail_url,
                        deck, date_added, date_last_updated, first_issue, last_issue) 
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        aliases = excluded.aliases,
                        start_year = excluded.start_year,
                        publisher_id = excluded.publisher_id,
                        count_of_issues = excluded.count_of_issues,
                        description = excluded.description,
                        image_url = excluded.image_url,
                        site_detail_url = excluded.site_detail_url,
                        api_detail_url = excluded.api_detail_url,
                        deck = excluded.deck,
                        date_added = excluded.date_added,
                        date_last_updated = excluded.date_last_updated,
                        first_issue = COALESCE(excluded.first_issue, cv_volume.first_issue),
                        last_issue = COALESCE(excluded.last_issue, cv_volume.last_issue)""",
                    (
                        vol_id,
                        self._jsonify(name),
                        self._jsonify(aliases),
                        self._jsonify(start_year),
                        publisher_id,
                        self._jsonify(count_of_issues),
                        self._jsonify(description),
                        image_url,
                        site_url,
                        api_detail_url,
                        self._jsonify(deck),
                        self._jsonify(date_added),
                        self._jsonify(date_last_updated),
                        first_issue,
                        last_issue,
                    ),
                )

                if exists:
                    self.stats["volumes_updated"] += 1
                else:
                    self.stats["volumes_added"] += 1

            self.conn.commit()

            total = data.get("number_of_total_results", 0)
            self.log(f"  Processed {offset + len(results)}/{total} volumes")

            if len(results) < limit:
                break
            offset += limit
        
        # Update metadata after successful completion
        self.set_endpoint_last_sync("volumes", end_date)

    def fetch_issue_details(self, issue_id: int) -> dict[str, Any] | None:
        """Fetch detailed issue info including credits."""
        data = self.api_call(f"issue/4000-{issue_id}/")
        if data:
            return data.get("results")
        return None

    def sync_issues(self, start_date: str, end_date: str, full: bool = False) -> None:
        """Sync issues updated since start_date (or all issues if full)."""
        self.log("\n--- Syncing Issues ---" + (" (FULL)" if full else ""))
        if not self.conn:
            return

        # Check for resume state
        resume_state = self.get_resume_state("issues")
        processed_ids = set()
        if resume_state and "processed_ids" in resume_state:
            processed_ids = set(resume_state["processed_ids"])
            self.log(f"  Resuming from previous run. Skipping {len(processed_ids)} already processed issues.")

        # Ensure metadata row exists so we can save state
        # Use start_date as the placeholder last_sync so if we crash, we pick up roughly from here
        timestamp = datetime.now().isoformat()
        self.conn.execute(
            """INSERT INTO cv_sync_metadata (endpoint, last_sync_date, last_sync_timestamp) 
               VALUES (?, ?, ?)
               ON CONFLICT(endpoint) DO NOTHING""",
            ("issues", start_date, timestamp),
        )
        self.conn.commit()

        # First, get list of updated issues
        issue_ids: list[int] = []
        offset = 0
        limit = 100

        self.log("  Finding updated issues..." + (" (full sync)" if full else ""))
        while True:
            params = {
                "field_list": "id",
                "offset": offset,
                "limit": limit,
            }
            if not full:
                params["filter"] = f"date_last_updated:{start_date}|{end_date}"
            params["sort"] = "date_last_updated:asc"

            data = self.api_call("issues/", params)
            if not data:
                raise RuntimeError("API call failed for issues")

            results = data.get("results", [])
            if not results:
                break

            for issue in results:
                issue_id = issue.get("id")
                if issue_id:
                    issue_ids.append(issue_id)

            total = data.get("number_of_total_results", 0)
            self.log(f"    Found {offset + len(results)}/{total} issues to update")

            if len(results) < limit:
                break
            offset += limit

        # Filter out already processed issues
        initial_count = len(issue_ids)
        issue_ids = [iid for iid in issue_ids if iid not in processed_ids]
        skipped_count = initial_count - len(issue_ids)
        if skipped_count > 0:
            self.log(f"  Skipping {skipped_count} issues (already processed). {len(issue_ids)} remaining.")

        # Now fetch details for each issue
        self.log(f"  Fetching details for {len(issue_ids)} issues...")
        for i, issue_id in enumerate(issue_ids):
            issue_data = self.fetch_issue_details(issue_id)
            if not issue_data:
                continue

            # Check if exists
            cur = self.conn.execute(
                "SELECT id FROM cv_issue WHERE id = ?", (issue_id,)
            )
            exists = cur.fetchone() is not None

            # Extract data
            volume_id = None
            if issue_data.get("volume"):
                volume_id = issue_data["volume"].get("id")

            name = issue_data.get("name")
            issue_number = issue_data.get("issue_number")
            cover_date = issue_data.get("cover_date")
            store_date = issue_data.get("store_date")
            description = issue_data.get("description")

            image_url = None
            if issue_data.get("image"):
                image_url = issue_data["image"].get("original_url")

            site_url = issue_data.get("site_detail_url")

            # Credits as JSON (ensure_ascii=False preserves UTF-8 characters)
            character_credits = json.dumps(issue_data.get("character_credits") or [], ensure_ascii=False)
            person_credits = json.dumps(issue_data.get("person_credits") or [], ensure_ascii=False)
            team_credits = json.dumps(issue_data.get("team_credits") or [], ensure_ascii=False)
            location_credits = json.dumps(issue_data.get("location_credits") or [], ensure_ascii=False)
            story_arc_credits = json.dumps(issue_data.get("story_arc_credits") or [], ensure_ascii=False)
            associated_images = json.dumps(issue_data.get("associated_images") or [], ensure_ascii=False)
            object_credits = json.dumps(issue_data.get("object_credits") or [], ensure_ascii=False)
            concept_credits = json.dumps(issue_data.get("concept_credits") or [], ensure_ascii=False)
            character_died_in = json.dumps(issue_data.get("character_died_in") or [], ensure_ascii=False)
            team_disbanded_in = json.dumps(issue_data.get("team_disbanded_in") or [], ensure_ascii=False)
            first_appearance_characters = json.dumps(issue_data.get("first_appearance_characters") or [], ensure_ascii=False)
            first_appearance_concepts = json.dumps(issue_data.get("first_appearance_concepts") or [], ensure_ascii=False)
            first_appearance_locations = json.dumps(issue_data.get("first_appearance_locations") or [], ensure_ascii=False)
            first_appearance_objects = json.dumps(issue_data.get("first_appearance_objects") or [], ensure_ascii=False)
            first_appearance_storyarcs = json.dumps(issue_data.get("first_appearance_storyarcs") or [], ensure_ascii=False)
            first_appearance_teams = json.dumps(issue_data.get("first_appearance_teams") or [], ensure_ascii=False)

            aliases = issue_data.get("aliases")
            api_detail_url = issue_data.get("api_detail_url")
            deck = issue_data.get("deck")
            date_added = issue_data.get("date_added")
            date_last_updated = issue_data.get("date_last_updated")
            has_staff_review = issue_data.get("has_staff_review")

            # The issue detail endpoint returns every credit array, so a full
            # INSERT OR REPLACE safely refreshes all columns (new rows get all
            # fields; existing rows are fully overwritten with fresh data).
            self.conn.execute(
                """INSERT OR REPLACE INTO cv_issue 
                   (id, volume_id, name, issue_number, cover_date, store_date,
                    description, image_url, site_detail_url,
                    character_credits, person_credits, team_credits,
                    location_credits, story_arc_credits, associated_images,
                    aliases, api_detail_url, deck, date_added, date_last_updated,
                    object_credits, concept_credits, character_died_in,
                    team_disbanded_in, first_appearance_characters,
                    first_appearance_concepts, first_appearance_locations,
                    first_appearance_objects, first_appearance_storyarcs,
                    first_appearance_teams, has_staff_review) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    issue_id,
                    volume_id,
                    self._jsonify(name),
                    self._jsonify(issue_number),
                    self._jsonify(cover_date),
                    self._jsonify(store_date),
                    self._jsonify(description),
                    image_url,
                    site_url,
                    character_credits,
                    person_credits,
                    team_credits,
                    location_credits,
                    story_arc_credits,
                    associated_images,
                    self._jsonify(aliases),
                    api_detail_url,
                    self._jsonify(deck),
                    self._jsonify(date_added),
                    self._jsonify(date_last_updated),
                    object_credits,
                    concept_credits,
                    character_died_in,
                    team_disbanded_in,
                    first_appearance_characters,
                    first_appearance_concepts,
                    first_appearance_locations,
                    first_appearance_objects,
                    first_appearance_storyarcs,
                    first_appearance_teams,
                    self._jsonify(has_staff_review),
                ),
            )

            if exists:
                self.stats["issues_updated"] += 1
            else:
                self.stats["issues_added"] += 1
            
            # Print update for every 10th issue in verbose mode, or milestone in non-verbose
            if self.verbose or (i + 1) % 100 == 0:
                action = "Updated" if exists else "Added"
                self.log(f"    [{i + 1}/{len(issue_ids)}] {action} issue: {name} (#{issue_number})")
            
            # Track progress
            processed_ids.add(issue_id)

            # Commit periodically and save state
            if (i + 1) % 50 == 0:
                self.save_resume_state("issues", {"processed_ids": list(processed_ids)})
                self.conn.commit()
                self.log(f"    --- SAVED RESUME STATE ({i + 1}/{len(issue_ids)}) ---")

        self.conn.commit()
        # Clear resume state on successful completion
        self.clear_resume_state("issues")
        self.log(f"  Completed {len(issue_ids)} issues")
        
        # Update metadata after successful completion
        self.set_endpoint_last_sync("issues", end_date)

    def sync_teams(self, start_date: str, end_date: str, full: bool = False) -> None:
        """Sync teams updated since start_date (or all teams if full)."""
        self.log("\n--- Syncing Teams ---" + (" (FULL)" if full else ""))
        if not self.conn:
            return

        offset = 0
        limit = 100

        while True:
            params = {
                "field_list": "id,name,publisher,aliases,count_of_team_members,"
                              "count_of_isssue_appearances,deck,description,"
                              "date_added,date_last_updated,image,site_detail_url,"
                              "first_appeared_in_issue",
                "offset": offset,
                "limit": limit,
            }
            if not full:
                params["filter"] = f"date_last_updated:{start_date}|{end_date}"
            params["sort"] = "date_last_updated:asc"

            data = self.api_call("teams/", params)
            if not data:
                raise RuntimeError("API call failed for teams")

            results = data.get("results", [])
            if not results:
                break

            for team in results:
                team_id = team.get("id")
                if not team_id:
                    continue

                name = team.get("name")
                publisher = team.get("publisher")
                aliases = team.get("aliases")
                count_of_team_members = team.get("count_of_team_members")
                count_of_issue_appearances = team.get(
                    "count_of_isssue_appearances"
                ) or team.get("count_of_issue_appearances")
                deck = team.get("deck")
                description = team.get("description")
                date_added = team.get("date_added")
                date_last_updated = team.get("date_last_updated")
                image_url = None
                if team.get("image"):
                    image_url = team["image"].get("original_url")
                site_url = team.get("site_detail_url")
                # Stored as a JSON object string, matching the backfill migration
                first_appeared_in_issue = (
                    json.dumps(team["first_appeared_in_issue"], ensure_ascii=False)
                    if team.get("first_appeared_in_issue")
                    else None
                )

                # Check if exists
                cur = self.conn.execute(
                    "SELECT id FROM cv_team WHERE id = ?", (team_id,)
                )
                exists = cur.fetchone() is not None

                # Upsert scalar fields + first_appeared_in_issue. The live API
                # no longer returns the related-object arrays (characters,
                # character_enemies, character_friends, disbanded_in_issues,
                # issue_credits, issues_disbanded_in, movies, story_arc_credits,
                # volume_credits), so they are left untouched to preserve the
                # raw-dump backfill. COALESCE keeps the existing
                # first_appeared_in_issue when the API returns null.
                self.conn.execute(
                    """INSERT INTO cv_team 
                       (id, name, publisher, aliases, count_of_team_members,
                        count_of_issue_appearances, deck, description,
                        date_added, date_last_updated, image_url, site_detail_url,
                        first_appeared_in_issue) 
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        publisher = excluded.publisher,
                        aliases = excluded.aliases,
                        count_of_team_members = excluded.count_of_team_members,
                        count_of_issue_appearances = excluded.count_of_issue_appearances,
                        deck = excluded.deck,
                        description = excluded.description,
                        date_added = excluded.date_added,
                        date_last_updated = excluded.date_last_updated,
                        image_url = excluded.image_url,
                        site_detail_url = excluded.site_detail_url,
                        first_appeared_in_issue = COALESCE(excluded.first_appeared_in_issue, cv_team.first_appeared_in_issue)""",
                    (
                        team_id, self._jsonify(name), self._jsonify(publisher),
                        self._jsonify(aliases),
                        self._jsonify(count_of_team_members),
                        self._jsonify(count_of_issue_appearances),
                        self._jsonify(deck), self._jsonify(description),
                        self._jsonify(date_added),
                        self._jsonify(date_last_updated), image_url, site_url,
                        first_appeared_in_issue,
                    ),
                )

                if exists:
                    self.stats["teams_updated"] += 1
                else:
                    self.stats["teams_added"] += 1

            self.conn.commit()

            total = data.get("number_of_total_results", 0)
            self.log(f"  Processed {offset + len(results)}/{total} teams")

            if len(results) < limit:
                break
            offset += limit

        # Update metadata after successful completion
        self.set_endpoint_last_sync("teams", end_date)

    def sync_storyarcs(self, start_date: str, end_date: str, full: bool = False) -> None:
        """Sync story arcs updated since start_date (or all if full)."""
        self.log("\n--- Syncing Story Arcs ---" + (" (FULL)" if full else ""))
        if not self.conn:
            return

        offset = 0
        limit = 100

        while True:
            params = {
                "field_list": "id,name,publisher,aliases,count_of_isssue_appearances,"
                              "deck,description,date_added,date_last_updated,image,"
                              "site_detail_url,first_appeared_in_issue",
                "offset": offset,
                "limit": limit,
            }
            if not full:
                params["filter"] = f"date_last_updated:{start_date}|{end_date}"
            params["sort"] = "date_last_updated:asc"

            # The list endpoint is "story_arcs/" (singular "story_arc/" is the
            # detail path); "storyarcs/" is not a valid ComicVine endpoint.
            data = self.api_call("story_arcs/", params)
            if not data:
                raise RuntimeError("API call failed for storyarcs")

            results = data.get("results", [])
            if not results:
                break

            for arc in results:
                arc_id = arc.get("id")
                if not arc_id:
                    continue

                name = arc.get("name")
                publisher = arc.get("publisher")
                aliases = arc.get("aliases")
                # The API spells this key with a doubled 's'
                count_of_issue_appearances = arc.get(
                    "count_of_isssue_appearances"
                ) or arc.get("count_of_issue_appearances")
                deck = arc.get("deck")
                description = arc.get("description")
                date_added = arc.get("date_added")
                date_last_updated = arc.get("date_last_updated")
                image_url = None
                if arc.get("image"):
                    image_url = arc["image"].get("original_url")
                site_url = arc.get("site_detail_url")
                # Stored as a JSON object string, matching the backfill migration
                first_appeared_in_issue = (
                    json.dumps(arc["first_appeared_in_issue"], ensure_ascii=False)
                    if arc.get("first_appeared_in_issue")
                    else None
                )

                # Check if exists
                cur = self.conn.execute(
                    "SELECT id FROM cv_storyarc WHERE id = ?", (arc_id,)
                )
                exists = cur.fetchone() is not None

                # Upsert scalar fields + first_appeared_in_issue. The live API
                # no longer returns the issues/movies arrays, so they are left
                # untouched to preserve the raw-dump backfill. COALESCE keeps
                # the existing first_appeared_in_issue when the API returns null.
                self.conn.execute(
                    """INSERT INTO cv_storyarc 
                       (id, name, publisher, aliases, count_of_issue_appearances,
                        deck, description, date_added, date_last_updated,
                        image_url, site_detail_url, first_appeared_in_issue) 
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        publisher = excluded.publisher,
                        aliases = excluded.aliases,
                        count_of_issue_appearances = excluded.count_of_issue_appearances,
                        deck = excluded.deck,
                        description = excluded.description,
                        date_added = excluded.date_added,
                        date_last_updated = excluded.date_last_updated,
                        image_url = excluded.image_url,
                        site_detail_url = excluded.site_detail_url,
                        first_appeared_in_issue = COALESCE(excluded.first_appeared_in_issue, cv_storyarc.first_appeared_in_issue)""",
                    (
                        arc_id, self._jsonify(name), self._jsonify(publisher),
                        self._jsonify(aliases),
                        self._jsonify(count_of_issue_appearances),
                        self._jsonify(deck), self._jsonify(description),
                        self._jsonify(date_added),
                        self._jsonify(date_last_updated), image_url, site_url,
                        first_appeared_in_issue,
                    ),
                )

                if exists:
                    self.stats["storyarcs_updated"] += 1
                else:
                    self.stats["storyarcs_added"] += 1

            self.conn.commit()

            total = data.get("number_of_total_results", 0)
            self.log(f"  Processed {offset + len(results)}/{total} story arcs")

            if len(results) < limit:
                break
            offset += limit

        # Update metadata after successful completion
        self.set_endpoint_last_sync("storyarcs", end_date)

    def recalculate_volume_issue_counts(self) -> None:
        """
        Recalculate count_of_issues for all volumes based on actual issue counts.
        
        This is necessary because ComicVine doesn't always update a volume's
        date_last_updated when new issues are added, so the count_of_issues
        from the API can become stale.
        """
        self.log("\n--- Recalculating Volume Issue Counts ---")
        if not self.conn:
            return

        try:
            # Get all volumes that have a mismatch between stored count and actual count
            cur = self.conn.execute("""
                SELECT v.id, v.name, v.count_of_issues as stored_count, 
                       COALESCE(i.actual_count, 0) as actual_count
                FROM cv_volume v
                LEFT JOIN (
                    SELECT volume_id, COUNT(*) as actual_count
                    FROM cv_issue
                    GROUP BY volume_id
                ) i ON v.id = i.volume_id
                WHERE v.count_of_issues != COALESCE(i.actual_count, 0)
                   OR (v.count_of_issues IS NULL AND i.actual_count > 0)
            """)
            
            mismatches = cur.fetchall()
            
            if not mismatches:
                self.log("  All volume issue counts are accurate")
                return
            
            self.log(f"  Found {len(mismatches)} volumes with incorrect counts")
            
            # Update each mismatched volume
            updated = 0
            for row in mismatches:
                vol_id, vol_name, stored, actual = row
                self.conn.execute(
                    "UPDATE cv_volume SET count_of_issues = ? WHERE id = ?",
                    (actual, vol_id)
                )
                updated += 1
                
                # Log a few examples in verbose mode
                if self.verbose and updated <= 5:
                    self.log(f"    {vol_name}: {stored} -> {actual}")
            
            if updated > 5:
                self.log(f"    ... and {updated - 5} more")
            
            self.conn.commit()
            self.log(f"  Updated {updated} volume counts")
            
        except sqlite3.Error as e:
            self.log(f"  Error recalculating counts: {e}")

    def rebuild_fts_index(self) -> None:
        """Rebuild the FTS5 full-text search indexes."""
        self.log("\n--- Rebuilding Search Index ---")
        if not self.conn:
            return

        # SRV-5: rebuild every per-resource FTS5 trigram index from the base tables.
        for _table, fts in self.FTS_RESOURCES:
            try:
                exists = self.conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                    (fts,),
                ).fetchone()
                if exists:
                    self.conn.execute(f"INSERT INTO {fts}({fts}) VALUES('rebuild')")
                    self.log(f"  {fts} rebuilt")
            except sqlite3.Error as e:
                self.log(f"  Warning: could not rebuild {fts}: {e}")
        self.conn.commit()

        # Legacy raw-dump index (out of scope for the API, but kept in sync).
        try:
            cur = self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='volume_fts'"
            )
            if cur.fetchone():
                self.conn.execute("INSERT INTO volume_fts(volume_fts) VALUES('rebuild')")
                self.conn.commit()
                self.log("  volume_fts rebuilt")
            else:
                self.log("  volume_fts not found, skipping")
        except sqlite3.Error as e:
            self.log(f"  Warning: Could not rebuild volume_fts: {e}")

    def print_stats(self) -> None:
        """Print sync statistics."""
        self.log("\n" + "=" * 50, force=True)
        self.log("SYNC COMPLETE", force=True)
        self.log("=" * 50, force=True)
        self.log(f"API calls made:     {self.stats['api_calls']}", force=True)
        self.log(f"Publishers added:   {self.stats['publishers_added']}", force=True)
        self.log(f"Publishers updated: {self.stats['publishers_updated']}", force=True)
        self.log(f"Persons added:      {self.stats['persons_added']}", force=True)
        self.log(f"Persons updated:    {self.stats['persons_updated']}", force=True)
        self.log(f"Volumes added:      {self.stats['volumes_added']}", force=True)
        self.log(f"Volumes updated:    {self.stats['volumes_updated']}", force=True)
        self.log(f"Issues added:       {self.stats['issues_added']}", force=True)
        self.log(f"Issues updated:     {self.stats['issues_updated']}", force=True)
        self.log(f"Teams added:        {self.stats['teams_added']}", force=True)
        self.log(f"Teams updated:      {self.stats['teams_updated']}", force=True)
        self.log(f"Story arcs added:   {self.stats['storyarcs_added']}", force=True)
        self.log(f"Story arcs updated: {self.stats['storyarcs_updated']}", force=True)

    def run_sync(self, start_date: str | None = None) -> bool:
        """Run the full sync process."""
        # Ensure metadata table exists
        self.ensure_metadata_table()
        # Ensure cv_team / cv_storyarc tables exist
        self.ensure_resource_tables()
        # Ensure SRV-5 FTS5 trigram tables exist (rebuilt after the sync below)
        self.ensure_fts_tables()

        # Determine end date (always today)
        end_date = datetime.now().strftime("%Y-%m-%d")
        
        # Sync each endpoint with its own start date
        # Publishers
        pub_start = start_date if start_date else self.calculate_safe_start_date("publishers")
        last_pub = self.get_endpoint_last_sync("publishers")
        if last_pub:
            self.log(f"Publishers last synced: {last_pub}")
        self.log(f"Syncing publishers from {pub_start} to {end_date}" + (" (FULL)" if self.full else ""))
        try:
            self.sync_publishers(pub_start, end_date, full=self.full)
        except RuntimeError as e:
            self.log(f"ERROR: {e}. Skipping metadata update for publishers.", force=True)
        
        # Persons
        person_start = start_date if start_date else self.calculate_safe_start_date("people")
        last_person = self.get_endpoint_last_sync("people")
        if last_person:
            self.log(f"People last synced: {last_person}")
        self.log(f"Syncing people from {person_start} to {end_date}" + (" (FULL)" if self.full else ""))
        try:
            self.sync_persons(person_start, end_date, full=self.full)
        except RuntimeError as e:
            self.log(f"ERROR: {e}. Skipping metadata update for people.", force=True)
        
        # Volumes
        vol_start = start_date if start_date else self.calculate_safe_start_date("volumes")
        last_vol = self.get_endpoint_last_sync("volumes")
        if last_vol:
            self.log(f"Volumes last synced: {last_vol}")
        self.log(f"Syncing volumes from {vol_start} to {end_date}" + (" (FULL)" if self.full else ""))
        try:
            self.sync_volumes(vol_start, end_date, full=self.full)
        except RuntimeError as e:
            self.log(f"ERROR: {e}. Skipping metadata update for volumes.", force=True)
        
        # Issues
        issue_start = start_date if start_date else self.calculate_safe_start_date("issues")
        last_issue = self.get_endpoint_last_sync("issues")
        if last_issue:
            self.log(f"Issues last synced: {last_issue}")
        self.log(f"Syncing issues from {issue_start} to {end_date}" + (" (FULL)" if self.full else ""))
        try:
            self.sync_issues(issue_start, end_date, full=self.full)
        except RuntimeError as e:
            self.log(f"ERROR: {e}. Skipping metadata update for issues.", force=True)

        # Teams
        team_start = start_date if start_date else self.calculate_safe_start_date("teams")
        last_team = self.get_endpoint_last_sync("teams")
        if last_team:
            self.log(f"Teams last synced: {last_team}")
        self.log(f"Syncing teams from {team_start} to {end_date}" + (" (FULL)" if self.full else ""))
        try:
            self.sync_teams(team_start, end_date, full=self.full)
        except RuntimeError as e:
            self.log(f"ERROR: {e}. Skipping metadata update for teams.", force=True)

        # Story arcs
        arc_start = start_date if start_date else self.calculate_safe_start_date("storyarcs")
        last_arc = self.get_endpoint_last_sync("storyarcs")
        if last_arc:
            self.log(f"Story arcs last synced: {last_arc}")
        self.log(f"Syncing story arcs from {arc_start} to {end_date}" + (" (FULL)" if self.full else ""))
        try:
            self.sync_storyarcs(arc_start, end_date, full=self.full)
        except RuntimeError as e:
            self.log(f"ERROR: {e}. Skipping metadata update for storyarcs.", force=True)

        # Recalculate volume issue counts (API counts can be stale)
        self.recalculate_volume_issue_counts()

        # Rebuild search index
        self.rebuild_fts_index()

        # Print stats
        self.print_stats()

        return True


def validate_api_key(api_key: str, verbose: bool = True) -> bool:
    """Validate the API key by making a test call."""
    if verbose:
        print("Validating API key...")
    try:
        response = requests.get(
            f"{API_BASE_URL}publishers/",
            params={"api_key": api_key, "format": "json", "limit": 1},
            headers=HEADERS,
            timeout=30,
        )
        data = response.json()
        if data.get("status_code") == 100:
            if verbose:
                print("ERROR: Invalid API key!")
            return False
        # A rate-limit response (107) means the key is valid but the hourly
        # quota is currently exhausted. Treat it as a valid key and proceed;
        # api_call will back off and retry once the window clears.
        if data.get("status_code") == RATE_LIMIT_STATUS:
            if verbose:
                print("API key is valid, but the rate limit is currently "
                      "exhausted. Proceeding; calls will back off and retry.")
            return True
        if data.get("status_code") == 1:
            if verbose:
                print("API key validated successfully!")
            return True
        if verbose:
            print(f"Unexpected API response: {data.get('error', 'Unknown')}")
        return False
    except requests.exceptions.RequestException as e:
        if verbose:
            print(f"ERROR: Could not connect to ComicVine: {e}")
        return False


def find_latest_database(db_dir: Path, today: str) -> Path | None:
    """Find the most recent database file before today."""
    # Look for dated databases
    pattern = "localcv-*.db"
    db_files = sorted(db_dir.glob(pattern), reverse=True)
    
    today_date = datetime.strptime(today, "%Y-%m-%d").date()
    
    for db_file in db_files:
        # Extract date from filename
        try:
            date_str = db_file.stem.replace("localcv-", "")
            file_date = datetime.strptime(date_str, "%Y-%m-%d").date()
            
            # Find the most recent file before today
            if file_date < today_date:
                return db_file
        except ValueError:
            continue
    
    # Fallback to non-dated localcv.db
    default_db = db_dir / "localcv.db"
    if default_db.exists():
        return default_db
    
    return None


def create_todays_database(db_dir: Path, today: str, verbose: bool = True) -> Path | None:
    """Create today's database by copying from the most recent one."""
    source_db = find_latest_database(db_dir, today)
    
    if not source_db:
        if verbose:
            print(f"ERROR: No source database found in {db_dir}", file=sys.stderr)
            print("Expected format: localcv-YYYY-MM-DD.db or localcv.db", file=sys.stderr)
        return None
    
    target_db = db_dir / f"localcv-{today}.db"
    
    # Check if today's database already exists
    if target_db.exists():
        if verbose:
            print(f"Database for {today} already exists: {target_db}")
        return target_db
    
    # Copy the database
    if verbose:
        print(f"Creating {target_db.name} from {source_db.name}...")
    
    try:
        # Copy with progress for large files
        source_size = source_db.stat().st_size
        if verbose and source_size > 100 * 1024 * 1024:  # > 100MB
            print(f"  Copying {source_size / (1024**3):.2f} GB database...")
        
        shutil.copy2(source_db, target_db)
        
        # Also copy WAL and SHM files if they exist
        for ext in ["-wal", "-shm"]:
            source_aux = Path(str(source_db) + ext)
            if source_aux.exists():
                target_aux = Path(str(target_db) + ext)
                shutil.copy2(source_aux, target_aux)
        
        if verbose:
            print(f"  Database copied successfully")
        
        return target_db
        
    except (OSError, shutil.Error) as e:
        if verbose:
            print(f"ERROR: Failed to copy database: {e}", file=sys.stderr)
        return None


def cleanup_old_databases(db_dir: Path, keep_days: int = 7, verbose: bool = True) -> int:
    """
    Delete old dated database files, keeping only the most recent ones.
    
    Args:
        db_dir: Directory containing the databases
        keep_days: Number of most recent databases to keep (default: 7)
        verbose: Print progress messages
    
    Returns:
        Number of databases deleted
    """
    if verbose:
        print(f"\n--- Cleaning Up Old Databases (keeping last {keep_days} days) ---")
    
    # Find all dated database files
    pattern = "localcv-*.db"
    db_files = []
    
    for db_file in db_dir.glob(pattern):
        # Extract date from filename
        try:
            date_str = db_file.stem.replace("localcv-", "")
            file_date = datetime.strptime(date_str, "%Y-%m-%d").date()
            db_files.append((file_date, db_file))
        except ValueError:
            # Skip files that don't match the date pattern
            continue
    
    if not db_files:
        if verbose:
            print("  No dated database files found")
        return 0
    
    # Sort by date (newest first)
    db_files.sort(reverse=True)
    
    # Keep the most recent ones
    files_to_keep = db_files[:keep_days]
    files_to_delete = db_files[keep_days:]
    
    if not files_to_delete:
        if verbose:
            print(f"  Only {len(files_to_keep)} database(s) found, nothing to delete")
        return 0
    
    # Delete old files
    deleted_count = 0
    total_size_freed = 0
    
    for file_date, db_file in files_to_delete:
        try:
            # Get file size before deleting
            file_size = db_file.stat().st_size
            
            # Delete main database file
            db_file.unlink()
            deleted_count += 1
            total_size_freed += file_size
            
            if verbose:
                size_mb = file_size / (1024**2)
                print(f"  Deleted: {db_file.name} ({size_mb:.1f} MB)")
            
            # Also delete associated WAL and SHM files if they exist
            for ext in ["-wal", "-shm"]:
                aux_file = Path(str(db_file) + ext)
                if aux_file.exists():
                    aux_size = aux_file.stat().st_size
                    aux_file.unlink()
                    total_size_freed += aux_size
                    
        except OSError as e:
            if verbose:
                print(f"  Warning: Could not delete {db_file.name}: {e}")
    
    if verbose and deleted_count > 0:
        size_gb = total_size_freed / (1024**3)
        print(f"  Deleted {deleted_count} old database(s), freed {size_gb:.2f} GB")
    
    return deleted_count


def get_script_dir() -> Path:
    """Get the directory where the script is located."""
    return Path(__file__).parent.resolve()


def get_config_file_path() -> Path:
    """Get path to config file in script directory."""
    return get_script_dir() / "comicvine_config.env"


def load_config_file() -> dict[str, str]:
    """Load configuration from .env file in script directory."""
    config = {}
    config_file = get_config_file_path()
    
    if not config_file.exists():
        return config
    
    try:
        with open(config_file, 'r') as f:
            for line in f:
                line = line.strip()
                # Skip empty lines and comments
                if not line or line.startswith('#'):
                    continue
                
                # Parse KEY=VALUE format
                if '=' in line:
                    key, value = line.split('=', 1)
                    key = key.strip()
                    value = value.strip()
                    
                    # Remove quotes if present
                    if value.startswith('"') and value.endswith('"'):
                        value = value[1:-1]
                    elif value.startswith("'") and value.endswith("'"):
                        value = value[1:-1]
                    
                    config[key] = value
        
        return config
    except OSError as e:
        print(f"Warning: Could not read config file: {e}")
        return config


def save_config_file(config: dict[str, str]) -> bool:
    """Save configuration to .env file in script directory."""
    config_file = get_config_file_path()
    
    try:
        with open(config_file, 'w') as f:
            f.write("# ComicVine Database Updater Configuration\n")
            f.write("# This file is automatically generated\n\n")
            
            # API Key
            if 'COMICVINE_API_KEY' in config:
                f.write(f"COMICVINE_API_KEY={config['COMICVINE_API_KEY']}\n\n")
            
            # Email settings
            f.write("# Email Configuration\n")
            for key in ['EMAIL_TO', 'EMAIL_FROM', 'SMTP_HOST', 'SMTP_PORT', 
                       'SMTP_USER', 'SMTP_PASS']:
                if key in config:
                    f.write(f"{key}={config[key]}\n")
        
        return True
    except OSError as e:
        print(f"Warning: Could not save config file: {e}")
        return False


def get_api_key_interactive() -> str | None:
    """Get API key interactively from user."""
    config_file = get_config_file_path()
    config = load_config_file()
    
    # Check for saved key in config
    if 'COMICVINE_API_KEY' in config:
        print(f"Found saved API key in {config_file}")
        use_saved = input("Use saved API key? (Y/n): ").strip().lower()
        if use_saved in ("", "y", "yes"):
            return config['COMICVINE_API_KEY']

    # Ask user for key
    print("\n" + "=" * 50)
    print("ComicVine API Key Required")
    print("=" * 50)
    print("To use this tool, you need a ComicVine API key.")
    print("Get one free at: https://comicvine.gamespot.com/api/")
    print()

    api_key = input("Enter your ComicVine API key: ").strip()
    if not api_key:
        return None

    # Offer to save the key
    save_key = input("Save this API key for future use? (y/N): ").strip().lower()
    if save_key in ("y", "yes"):
        config['COMICVINE_API_KEY'] = api_key
        if save_config_file(config):
            print(f"API key saved to {config_file}")

    return api_key


def get_database_path_gui() -> Path | None:
    """Get database path using GUI file picker."""
    if not HAS_GUI:
        return None
    
    try:
        root = tk.Tk()
        root.withdraw()  # Hide the main window
        root.attributes('-topmost', True)  # Bring dialog to front
        
        file_path = filedialog.askopenfilename(
            title="Select ComicVine SQLite Database",
            filetypes=[("SQLite Database", "*.db"), ("All Files", "*.*")],
            initialfile="localcv.db"
        )
        
        root.destroy()
        
        if file_path:
            return Path(file_path)
        return None
    except Exception as e:
        print(f"GUI error: {e}")
        return None


def get_database_path_interactive() -> Path | None:
    """Get database path interactively."""
    # Look for default file in current directory
    default_path = Path("localcv.db")
    if default_path.exists():
        print(f"Found database: {default_path}")
        use_default = input("Use this database? (Y/n): ").strip().lower()
        if use_default in ("", "y", "yes"):
            return default_path

    # Try GUI file picker
    if HAS_GUI:
        print("\nOpening file picker...")
        path = get_database_path_gui()
        if path:
            print(f"Selected: {path}")
            return path
        print("No file selected.")
    
    # Fallback to manual entry
    print("\nEnter database path manually:")
    while True:
        path_str = input("Path to localcv.db (or press Enter to cancel): ").strip()
        if not path_str:
            return None
        path = Path(path_str)
        if path.exists():
            return path
        print(f"ERROR: File not found: {path}")


def parse_arguments() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="ComicVine SQLite Database Updater (Dated Version)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
This version creates dated database copies: localcv-YYYY-MM-DD.db

Examples:
  # Interactive mode
  %(prog)s
  %(prog)s /path/to/localcv.db
  
  # Non-interactive mode - creates today's DB from yesterday's
  %(prog)s --non-interactive --db-dir /path/to/db/directory
  
  # With email notifications
  %(prog)s --non-interactive --db-dir /path/to/db --email-to your@email.com
  
  # Configuration file (comicvine_config.env in script directory)
  # The script will create this file when you save settings interactively
  # You can also create it manually with these settings:
  
  COMICVINE_API_KEY=your_api_key_here
  EMAIL_TO=your@email.com
  EMAIL_FROM=comicvine@yourdomain.com
  SMTP_HOST=mail.smtp2go.com
  SMTP_PORT=2525
  SMTP_USER=your_smtp2go_username
  SMTP_PASS=your_smtp2go_password
  
  %(prog)s --non-interactive --db-dir /path/to/db/directory
  
  # Crontab entry (runs daily at 3 AM):
  0 3 * * * /usr/bin/python3 /path/to/sqlite_cv_updater.py --non-interactive --db-dir /path/to/db >> /var/log/comicvine_sync.log 2>&1
  
How it works:
  1. Looks for most recent localcv-YYYY-MM-DD.db before today
  2. Copies it to localcv-{today}.db
  3. Updates the new database with today's ComicVine data
  4. Optionally sends email report with sync results
"""
    )
    
    parser.add_argument(
        "database",
        nargs="?",
        help="Path to a specific database file (interactive mode)"
    )
    
    parser.add_argument(
        "--db",
        dest="db_path",
        help="Path to a specific database file (alternative to positional arg)"
    )
    
    parser.add_argument(
        "--db-dir",
        dest="db_dir",
        help="Directory containing dated databases (for non-interactive mode)"
    )
    
    parser.add_argument(
        "--api-key",
        help="ComicVine API key (or set COMICVINE_API_KEY environment variable)"
    )
    
    parser.add_argument(
        "--start-date",
        help="Custom start date in YYYY-MM-DD format (default: automatic based on last sync)"
    )
    
    parser.add_argument(
        "--full",
        action="store_true",
        help="Full synchronization: fetch every record from the API (no date filter) "
             "instead of only records updated since the last sync. This makes many "
             "API calls and can take a long time; use for a one-time initial load or "
             "to repair a database."
    )
    
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Run without any user prompts (required for cron jobs)"
    )
    
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Reduce output verbosity (only show errors and final stats)"
    )
    
    parser.add_argument(
        "--no-copy",
        action="store_true",
        help="Don't create dated copy, update database in place"
    )
    
    parser.add_argument(
        "--keep-days",
        type=int,
        default=7,
        help="Number of dated databases to keep (default: 7, set to 0 to disable cleanup)"
    )
    
    # Email configuration
    parser.add_argument(
        "--email-to",
        help="Email address to send sync report to (or set EMAIL_TO environment variable)"
    )
    
    parser.add_argument(
        "--email-from",
        help="Email address to send from (or set EMAIL_FROM environment variable)"
    )
    
    parser.add_argument(
        "--smtp-host",
        help="SMTP server hostname (default: mail.smtp2go.com, or set SMTP_HOST)"
    )
    
    parser.add_argument(
        "--smtp-port",
        type=int,
        help="SMTP server port (default: 2525, or set SMTP_PORT)"
    )
    
    parser.add_argument(
        "--smtp-user",
        help="SMTP username (or set SMTP_USER environment variable)"
    )
    
    parser.add_argument(
        "--smtp-pass",
        help="SMTP password (or set SMTP_PASS environment variable)"
    )
    
    parser.add_argument(
        "--smtp-tls",
        action="store_true",
        help="Use STARTTLS for SMTP connection (default for port 587)"
    )
    
    parser.add_argument(
        "--smtp-ssl",
        action="store_true",
        help="Use SSL for SMTP connection (default for port 465)"
    )
    
    return parser.parse_args()


def send_email_report(
    email_to: str,
    email_from: str,
    subject: str,
    log_contents: str,
    stats: dict[str, int],
    duration: str,
    smtp_host: str,
    smtp_port: int,
    smtp_user: str | None = None,
    smtp_pass: str | None = None,
    use_tls: bool = False,
    use_ssl: bool = False,
) -> bool:
    """Send email report with sync results."""
    try:
        # Create message
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = email_from
        msg['To'] = email_to
        
        # Create plain text version
        text_body = """
ComicVine Database Sync Report
{separator}

Duration: {duration}

Statistics:
-----------
API calls made:     {api_calls}
Publishers added:   {publishers_added}
Publishers updated: {publishers_updated}
Persons added:      {persons_added}
Persons updated:    {persons_updated}
Volumes added:      {volumes_added}
Volumes updated:    {volumes_updated}
Issues added:       {issues_added}
Issues updated:     {issues_updated}

Full Log:
{separator}
{log_contents}
""".format(
            separator='=' * 50,
            duration=duration,
            api_calls=stats['api_calls'],
            publishers_added=stats['publishers_added'],
            publishers_updated=stats['publishers_updated'],
            persons_added=stats['persons_added'],
            persons_updated=stats['persons_updated'],
            volumes_added=stats['volumes_added'],
            volumes_updated=stats['volumes_updated'],
            issues_added=stats['issues_added'],
            issues_updated=stats['issues_updated'],
            log_contents=log_contents
        )
        
        # Create HTML version
        html_body = """
<html>
<head>
    <style>
        body {{ font-family: 'Courier New', monospace; margin: 20px; }}
        h1 {{ color: #333; }}
        h2 {{ color: #666; margin-top: 20px; }}
        .stats {{ background: #f5f5f5; padding: 15px; border-radius: 5px; }}
        .stats-item {{ margin: 5px 0; }}
        .success {{ color: #2e7d32; }}
        .log {{ background: #f9f9f9; padding: 15px; border: 1px solid #ddd; 
                border-radius: 5px; overflow-x: auto; white-space: pre-wrap; 
                font-size: 12px; max-height: 500px; overflow-y: auto; }}
        .duration {{ font-weight: bold; color: #1976d2; }}
    </style>
</head>
<body>
    <h1>ComicVine Database Sync Report</h1>
    
    <div class="stats">
        <div class="duration">Duration: {duration}</div>
        
        <h2>Statistics</h2>
        <div class="stats-item">API calls made: <strong>{api_calls}</strong></div>
        <div class="stats-item">Publishers added: <strong class="success">{publishers_added}</strong></div>
        <div class="stats-item">Publishers updated: <strong>{publishers_updated}</strong></div>
        <div class="stats-item">Persons added: <strong class="success">{persons_added}</strong></div>
        <div class="stats-item">Persons updated: <strong>{persons_updated}</strong></div>
        <div class="stats-item">Volumes added: <strong class="success">{volumes_added}</strong></div>
        <div class="stats-item">Volumes updated: <strong>{volumes_updated}</strong></div>
        <div class="stats-item">Issues added: <strong class="success">{issues_added}</strong></div>
        <div class="stats-item">Issues updated: <strong>{issues_updated}</strong></div>
    </div>
    
    <h2>Full Log</h2>
    <div class="log">{log_html}</div>
</body>
</html>
"""
        
        # Format log for HTML (escape and replace newlines/spaces)
        log_html = log_contents.replace('\n', '<br>').replace(' ', '&nbsp;')
        html_body = html_body.format(
            duration=duration,
            api_calls=stats['api_calls'],
            publishers_added=stats['publishers_added'],
            publishers_updated=stats['publishers_updated'],
            persons_added=stats['persons_added'],
            persons_updated=stats['persons_updated'],
            volumes_added=stats['volumes_added'],
            volumes_updated=stats['volumes_updated'],
            issues_added=stats['issues_added'],
            issues_updated=stats['issues_updated'],
            log_html=log_html
        )
        
        # Attach both versions
        part1 = MIMEText(text_body, 'plain')
        part2 = MIMEText(html_body, 'html')
        msg.attach(part1)
        msg.attach(part2)
        
        # Connect to SMTP server
        if use_ssl:
            server = smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=30)
        else:
            server = smtplib.SMTP(smtp_host, smtp_port, timeout=30)
            if use_tls:
                server.starttls()
        
        # Login if credentials provided
        if smtp_user and smtp_pass:
            server.login(smtp_user, smtp_pass)
        
        # Send email
        server.send_message(msg)
        server.quit()
        
        return True
        
    except Exception as e:
        print(f"ERROR: Failed to send email: {e}", file=sys.stderr)
        return False


def main() -> int:
    """Main entry point."""
    args = parse_arguments()
    
    # Load configuration from file in script directory
    config = load_config_file()
    
    # Determine if we're running interactively
    interactive = not args.non_interactive
    verbose = not args.quiet
    
    # Email configuration - prioritize command line args, then config file, then environment variables
    email_to = args.email_to or config.get("EMAIL_TO") or os.environ.get("EMAIL_TO")
    email_from = args.email_from or config.get("EMAIL_FROM") or os.environ.get("EMAIL_FROM", "comicvine-updater@localhost")
    smtp_host = args.smtp_host or config.get("SMTP_HOST") or os.environ.get("SMTP_HOST", "mail.smtp2go.com")
    smtp_port = args.smtp_port or int(config.get("SMTP_PORT", os.environ.get("SMTP_PORT", "2525")))
    smtp_user = args.smtp_user or config.get("SMTP_USER") or os.environ.get("SMTP_USER")
    smtp_pass = args.smtp_pass or config.get("SMTP_PASS") or os.environ.get("SMTP_PASS")
    
    # Determine TLS/SSL settings
    use_tls = args.smtp_tls or (smtp_port == 587)
    use_ssl = args.smtp_ssl or (smtp_port == 465)
    
    # Create log capture if email is configured
    log_capture = None
    if email_to:
        log_capture = LogCapture()
        if verbose:
            print(f"Email reporting enabled: will send report to {email_to}")
    
    if interactive and verbose:
        print("=" * 50)
        print("ComicVine SQLite Database Updater")
        print("=" * 50)
        print()
        config_file = get_config_file_path()
        if config:
            print(f"Loaded configuration from: {config_file}")
        else:
            print(f"No config file found at: {config_file}")
            print("(This is normal for first run)")
        print()

    today = datetime.now().strftime("%Y-%m-%d")

    # Get database path
    db_path = None
    db_dir_for_cleanup = None  # Track which directory needs cleanup
    
    if args.db_dir:
        # Dated database mode
        db_dir = Path(args.db_dir)
        if not db_dir.exists():
            print(f"ERROR: Directory not found: {db_dir}", file=sys.stderr)
            return 1
        
        if args.no_copy:
            # Just find the latest and use it
            db_path = find_latest_database(db_dir, today)
            if not db_path:
                print(f"ERROR: No database found in {db_dir}", file=sys.stderr)
                return 1
        else:
            # Create today's database
            db_path = create_todays_database(db_dir, today, verbose=verbose)
            if not db_path:
                return 1
            db_dir_for_cleanup = db_dir
    
    elif args.db_path:
        db_path = Path(args.db_path)
    elif args.database:
        db_path = Path(args.database)
    elif interactive:
        db_path = get_database_path_interactive()
    else:
        # Non-interactive mode without db-dir - look in current directory
        current_dir = Path.cwd()
        if args.no_copy:
            db_path = find_latest_database(current_dir, today)
        else:
            db_path = create_todays_database(current_dir, today, verbose=verbose)
            db_dir_for_cleanup = current_dir
        
        if not db_path:
            print("ERROR: No database found. Use --db-dir or --db to specify location", file=sys.stderr)
            return 1
    
    if not db_path:
        print("No database selected. Exiting.", file=sys.stderr)
        return 1
    
    if not db_path.exists():
        print(f"ERROR: Database not found: {db_path}", file=sys.stderr)
        return 1

    # Get API key - prioritize command line, then config file, then environment variable
    api_key = args.api_key or config.get("COMICVINE_API_KEY") or os.environ.get("COMICVINE_API_KEY")
    
    if not api_key:
        if interactive:
            api_key = get_api_key_interactive()
        else:
            print("ERROR: No API key provided.", file=sys.stderr)
            print(f"Add COMICVINE_API_KEY to: {get_config_file_path()}", file=sys.stderr)
            print("Or use --api-key flag or set COMICVINE_API_KEY environment variable", file=sys.stderr)
            return 1
    
    if not api_key:
        print("ERROR: No API key provided.", file=sys.stderr)
        return 1

    # Validate API key
    if not validate_api_key(api_key, verbose=verbose):
        return 1

    # Validate custom start date if provided. In full mode the start date is
    # unused (no date filter), so skip it to avoid a pointless prompt.
    start_date = None
    if not args.full:
        start_date = args.start_date
        if start_date:
            try:
                datetime.strptime(start_date, "%Y-%m-%d")
            except ValueError:
                print(f"ERROR: Invalid date format: {start_date} (use YYYY-MM-DD)", file=sys.stderr)
                return 1
        elif interactive:
            custom_date = input(
                "\nEnter custom start date (YYYY-MM-DD) or press Enter for automatic: "
            ).strip()
            if custom_date:
                try:
                    datetime.strptime(custom_date, "%Y-%m-%d")
                    start_date = custom_date
                except ValueError:
                    print("Invalid date format, using automatic date range")

    # Run the updater
    updater = ComicVineUpdater(str(db_path), api_key, verbose=verbose, log_capture=log_capture, full=args.full)
    if not updater.connect():
        return 1

    sync_success = False
    exit_code = 0
    error_message = None
    
    try:
        updater.run_sync(start_date)
        sync_success = True
        
        # Clean up old databases after successful sync
        if sync_success and db_dir_for_cleanup and args.keep_days > 0:
            cleanup_old_databases(db_dir_for_cleanup, keep_days=args.keep_days, verbose=verbose)
            
    except KeyboardInterrupt:
        error_message = "Interrupted by user. Progress has been saved."
        print(f"\n\n{error_message}", file=sys.stderr)
        exit_code = 130
    except Exception as e:
        error_message = f"Sync failed: {e}"
        print(f"\nERROR: {error_message}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        exit_code = 1
    finally:
        updater.close()

    # Send email if configured
    if email_to and log_capture:
        # Prepare subject
        if sync_success:
            subject = f"✓ ComicVine Sync Success - {today}"
        else:
            subject = f"✗ ComicVine Sync Failed - {today}"
        
        # Add error to log if present
        if error_message and log_capture:
            log_capture.write(f"\nERROR: {error_message}")
        
        # Send email
        if verbose:
            print(f"\nSending email report to {email_to}...")
        
        email_sent = send_email_report(
            email_to=email_to,
            email_from=email_from,
            subject=subject,
            log_contents=log_capture.get_contents(),
            stats=updater.stats,
            duration=log_capture.get_duration(),
            smtp_host=smtp_host,
            smtp_port=smtp_port,
            smtp_user=smtp_user,
            smtp_pass=smtp_pass,
            use_tls=use_tls,
            use_ssl=use_ssl,
        )
        
        if email_sent and verbose:
            print("Email sent successfully!")
        elif not email_sent:
            print("Failed to send email report", file=sys.stderr)

    if interactive:
        print("\nDone! Press Enter to exit...")
        input()
    
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
