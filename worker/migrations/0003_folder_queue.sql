-- Keep recovery evidence until sources are archived; never erase it before moving files.
-- Preserve a conservative checkpoint if the old consumed flag is the only evidence of an upload.
INSERT INTO publications (run_id, file_id, platform, surface, provider, status, detail, created_at, updated_at)
SELECT COALESCE(v.consumed_run_id, 'legacy:' || v.file_id), v.file_id, 'pipeline', 'legacy', 'none',
       'uncertain', 'Legacy consumed marker without a durable provider outcome. Verify the old upload, then resolve this checkpoint manually.',
       COALESCE(v.consumed_at, v.first_observed_at), COALESCE(v.consumed_at, v.first_observed_at)
FROM videos v
WHERE v.consumed = 1 AND NOT EXISTS (
  SELECT 1 FROM publications p WHERE p.file_id = v.file_id
    AND p.status IN ('initiated', 'processing', 'confirmed', 'uncertain')
);

-- Selection now reads createdTime directly from Drive; no per-video history or entry-time table.
DROP TABLE videos;

-- SQLite CHECK constraints require rebuilding this table to add a persisted random policy.
CREATE TABLE settings_next (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  automation_enabled INTEGER NOT NULL DEFAULT 0,
  automation_enabled_at TEXT,
  schedule_json TEXT,
  selection_policy TEXT NOT NULL DEFAULT 'fifo' CHECK (selection_policy IN ('fifo','lifo','random')),
  pending_custom_file_id TEXT,
  pending_custom_file_name TEXT,
  pending_custom_config_version INTEGER,
  publishing_enabled INTEGER NOT NULL DEFAULT 0,
  config_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  outros_json TEXT
);
INSERT INTO settings_next SELECT * FROM settings;
DROP TABLE settings;
ALTER TABLE settings_next RENAME TO settings;
