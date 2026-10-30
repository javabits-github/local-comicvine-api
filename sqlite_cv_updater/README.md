# ComicVine SQLite Database Updater

> **Node.js port (recommended):** the updater is now written in Node.js at [`../src/updater.js`](../src/updater.js), using `node:sqlite` and `fetch` with no npm dependencies. Run it with `npm sync` (incremental) or `npm sync:full` (full refresh) from the project root. This page documents the original Python implementation, which remains in this directory for reference. The Node port covers the same sync behaviour (field lists, upserts, retry/backoff, resume state, dated-database copy/cleanup, config-file/env key precedence); the Python-only email report (`smtplib`) and GUI picker (`tkinter`) have no zero-dependency Node equivalent.

A Python script that maintains a local SQLite database of ComicVine data with automatic daily updates, email notifications, and intelligent cleanup.

Based on [/u/Logical-Feedback-543's](https://old.reddit.com/r/comicrackusers/comments/1q7rex8/here_it_is_an_offline_comicvine_tagger_for/) script. 

## Features

- Incremental Updates: Only fetches changes since last sync (1-day safety margin)
- Dated Backups: Creates dated copies (e.g., `localcv-2026-01-26.db`) for version history
- Automatic Cleanup: Keeps only the last N days of databases to save disk space
- Email Reports: Sends HTML email reports after each sync
- Resume Capability: Recovers from interruptions without losing progress
- Cron-Ready: Fully non-interactive mode for automated daily runs
- Config File: All settings in one file in the script directory

## What Gets Synced

The script syncs these ComicVine resources:
- Publishers
- Volumes (series)
- Issues (with full credits and metadata)
- Persons (creators/writers/artists)

## Requirements

- Python 3.9+
- `requests` library: `pip install requests`
- ComicVine API key (free at https://comicvine.gamespot.com/api/)
- SQLite database with the appropriate schema (see [this reddit post](https://old.reddit.com/r/comicrackusers/comments/1q7rex8/here_it_is_an_offline_comicvine_tagger_for/))

## Quick Start

### 1. Setup

```bash
# Install dependencies
pip install requests

# Copy the example config
cp comicvine_config.env.example comicvine_config.env

# Edit config with your settings
vi comicvine_config.env
```

### 2. Configure `comicvine_config.env`

```env
# Required: ComicVine API Key
COMICVINE_API_KEY=your_api_key_here

# Optional: Database retention (default: 7 days)
KEEP_DAYS=7

# Optional: Email notifications
EMAIL_TO=your@email.com
EMAIL_FROM=comicvine@yourdomain.com
SMTP_HOST=mail.smtp2go.com
SMTP_PORT=2525
SMTP_USER=your_smtp_username
SMTP_PASS=your_smtp_password
```

### 3. Run

```bash
# Interactive mode (first time)
python3 sqlite_cv_updater.py

# Non-interactive mode (for cron)
python3 sqlite_cv_updater.py --non-interactive --db-dir /path/to/db
```

## How It Works

### Daily Workflow

```
Day 1 (Jan 25):
  - Have: localcv-2026-01-25.db

Day 2 (Jan 26) - Script runs at 3 AM:
  1. Finds yesterday's database: localcv-2026-01-25.db
  2. Copies it to: localcv-2026-01-26.db
  3. Updates new database with changes from Jan 25-26
  4. Sends email report (if configured)
  5. Deletes old databases (keeps last 7 days)
```

## Usage

### Command Line Options

```bash
# Basic usage
python3 sqlite_cv_updater.py --non-interactive --db-dir /path/to/db

# Custom retention period
python3 sqlite_cv_updater.py --non-interactive --db-dir /path/to/db --keep-days 14

# Disable cleanup (keep all databases)
python3 sqlite_cv_updater.py --non-interactive --db-dir /path/to/db --keep-days 0

# Update specific database in-place (no dated copy)
python3 sqlite_cv_updater.py --non-interactive --db /path/to/localcv.db --no-copy

# Quiet mode (less output)
python3 sqlite_cv_updater.py --non-interactive --quiet --db-dir /path/to/db

# Custom start date (override automatic date detection)
python3 sqlite_cv_updater.py --non-interactive --db-dir /path/to/db --start-date 2026-01-01
```

### All Available Options

```
Arguments:
  --db-dir DIR              Directory containing dated databases
  --db FILE                 Path to specific database file
  --api-key KEY             ComicVine API key
  --start-date YYYY-MM-DD   Custom start date for sync
  --keep-days N             Number of databases to keep (default: 7, 0=disable cleanup)
  --no-copy                 Update database in place (no dated copy)
  --non-interactive         Run without prompts (required for cron)
  --quiet                   Reduce output verbosity
  
Email Options:
  --email-to EMAIL          Email address for reports
  --email-from EMAIL        From address for emails
  --smtp-host HOST          SMTP server (default: mail.smtp2go.com)
  --smtp-port PORT          SMTP port (default: 2525)
  --smtp-user USER          SMTP username
  --smtp-pass PASS          SMTP password
  --smtp-tls                Use STARTTLS
  --smtp-ssl                Use SSL
```

## Cron Setup

### Basic Crontab Entry

```bash
# Edit crontab
crontab -e

# Run daily at 3 AM
0 3 * * * cd /home/user/scripts && /usr/bin/python3 sqlite_cv_updater.py --non-interactive --db-dir /home/user/db >> /home/user/comicvine_sync.log 2>&1
```

### Advanced Crontab with Logging

```bash
# Run daily at 3 AM with log rotation
0 3 * * * cd /home/user/scripts && /usr/bin/python3 sqlite_cv_updater.py --non-interactive --db-dir /home/user/db >> /home/user/comicvine_sync.log 2>&1

# Weekly log rotation (runs Sundays at 2:59 AM)
59 2 * * 0 mv /home/user/comicvine_sync.log /home/user/comicvine_sync.log.old 2>/dev/null
```

### Testing Before Adding to Cron

```bash
# Test the exact command cron will run
cd /home/user/scripts && /usr/bin/python3 sqlite_cv_updater.py --non-interactive --db-dir /home/user/db

# Check exit code (should be 0 for success)
echo $?

# Verify email was sent
# Check that today's database was created
ls -lh /home/user/db/localcv-$(date +%Y-%m-%d).db
```

## Email Reports

When configured, you'll receive HTML email reports with:

### Subject Line
- ✓ **Success**: `✓ ComicVine Sync Success - 2026-01-26`
- ✗ **Failure**: `✗ ComicVine Sync Failed - 2026-01-26`

### Report Contents
- Sync duration
- Statistics (items added/updated)
- Full timestamped logs
- Color-coded formatting

### Example Email Preview
```
ComicVine Database Sync Report
Duration: 2m 34s

Statistics:
- API calls made: 47
- Publishers added: 2
- Publishers updated: 5
- Volumes added: 15
- Volumes updated: 23
- Issues added: 142
- Issues updated: 8

[Full detailed logs with timestamps...]
```

## SMTP Provider Examples

### SMTP2GO (Default)
```env
SMTP_HOST=mail.smtp2go.com
SMTP_PORT=2525
SMTP_USER=your_username
SMTP_PASS=your_password
```

### Gmail (App Password Required)
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your_app_specific_password
```

### SendGrid
```env
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=your_sendgrid_api_key
```

## Directory Structure

```
/path/to/your/scripts/
├── sqlite_cv_updater.py          # Main script
├── comicvine_config.env          # Your configuration (not in git)
└── comicvine_config.env.example  # Example template (in git)

/path/to/your/db/
├── localcv-2026-01-20.db
├── localcv-2026-01-21.db
├── localcv-2026-01-22.db
├── localcv-2026-01-23.db
├── localcv-2026-01-24.db
├── localcv-2026-01-25.db
└── localcv-2026-01-26.db  ← Today's (newest)
```

## Configuration Priority

Settings are loaded in this order (highest priority first):

1. Command-line arguments (e.g., `--api-key`, `--keep-days`)
2. Config file (`comicvine_config.env`)
3. Environment variables (e.g., `COMICVINE_API_KEY`)
4. Default values

Example:
```bash
# Config file has: KEEP_DAYS=7
# This run will keep 14 days instead:
python3 sqlite_cv_updater.py --keep-days 14 --db-dir /path/to/db
```

## Developer Notes

A running diary of decisions, gotchas, and experiments made while working on this script. Newest entries go at the top.

### Entry template

```markdown
### YYYY-MM-DD — Short title

- **Context:** what prompted the change.
- **Change:** what was done and why.
- **Gotcha / follow-up:** anything surprising or still open.
```

### Diary

#### 2026-10-29 — Superseded by the Node.js updater (UPD-3)

- **Context:** the project goal is a zero-dependency Node.js server, and a Python updater forced a second runtime for syncing.
- **Change:** the updater was ported to `src/updater.js` (Node `node:sqlite` + `fetch`), exposed as `npm sync` / `npm sync:full`. This Python script is kept for reference; the Node version is the tool to run.
- **Gotcha / follow-up:** the Python `smtplib` email report and `tkinter` GUI picker were dropped (no zero-dependency Node equivalent). `node:sqlite` rejects boolean binds, so the port's JSON serializer maps booleans to `1`/`0` (Python `sqlite3` coerces them implicitly).

#### 2026-10-29 — Rate-limit (status 107) handling

- **Context:** the live API returns HTTP 200 with `status_code: 107` when the hourly call quota is exhausted, which the updater previously treated as a hard failure and aborted the run.
- **Change:** `api_call` now backs off (60s × attempt, escalating) and retries up to `MAX_RETRIES` (5) on 107; `validate_api_key` treats 107 as "valid key, quota exhausted" instead of failing startup.
- **Gotcha / follow-up:** HTTP 420 is handled separately with its own 60s waits. See the project `TODO.md` for related items.