-- Single persistent source of truth for the EasyBosnian video pipeline.

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  automation_enabled INTEGER NOT NULL DEFAULT 0,
  automation_enabled_at TEXT,            -- only occurrences strictly after this instant may publish
  schedule_json TEXT,                    -- normalized weekly slots; NULL = never saved (default Fri 05:00 applies)
  selection_policy TEXT NOT NULL DEFAULT 'fifo' CHECK (selection_policy IN ('fifo','lifo')),
  pending_custom_file_id TEXT,           -- one-occurrence custom override
  pending_custom_file_name TEXT,
  pending_custom_config_version INTEGER,
  publishing_enabled INTEGER NOT NULL DEFAULT 0,  -- global kill switch: 0 = no live publication
  config_version INTEGER NOT NULL DEFAULT 1,      -- bumped by every configuration change; stale runs abort
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
INSERT OR IGNORE INTO settings (id, updated_at, updated_by) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration');

CREATE TABLE IF NOT EXISTS occurrence_claims (
  occurrence_key TEXT PRIMARY KEY,       -- UTC minute of the occurrence, or 'test:<uuid>' for dispatch tests
  kind TEXT NOT NULL DEFAULT 'scheduled' CHECK (kind IN ('scheduled','dispatch_test')),
  config_version INTEGER NOT NULL,
  claim_token_hash TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  dispatch_http_status INTEGER,
  dispatch_note TEXT,
  state TEXT NOT NULL DEFAULT 'claimed'  -- claimed | dispatched | dispatch_failed | started | finished
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,                  -- manual | scheduled | retry | dispatch_test
  occurrence_key TEXT,
  config_version INTEGER NOT NULL,
  github_run_id TEXT,
  github_run_url TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  selected_file_id TEXT,
  selected_file_name TEXT,
  selection_method TEXT,
  selection_note TEXT
);

CREATE TABLE IF NOT EXISTS videos (
  file_id TEXT PRIMARY KEY,              -- Drive file ID (identity; filename is informational)
  last_known_name TEXT,
  entered_folder_at TEXT,
  entry_source TEXT,                     -- drive_activity | observed | created_time_approximation
  first_observed_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,   -- published by this pipeline -> excluded from FIFO/LIFO
  consumed_at TEXT,
  consumed_run_id TEXT,
  md5_at_publication TEXT
);

CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  surface TEXT NOT NULL,                 -- feed | story | story_part_N
  provider TEXT,
  format TEXT,
  status TEXT NOT NULL,
  remote_id TEXT,
  url TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, platform, surface)
);
CREATE INDEX IF NOT EXISTS publications_file ON publications (file_id);
CREATE INDEX IF NOT EXISTS publications_status ON publications (status);

CREATE TABLE IF NOT EXISTS credentials (
  name TEXT PRIMARY KEY,                 -- rotated credentials, encrypted by the runner (AES-GCM); opaque here
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
