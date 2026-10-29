CREATE TABLE scheduled_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  schedule_json TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('fifo','lifo','random','custom','title_rule')),
  remaining_json TEXT NOT NULL DEFAULT '[]',
  title_rule_json TEXT,
  outros_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','stopped')),
  version INTEGER NOT NULL DEFAULT 1,
  enabled_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE job_reservations (
  file_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE
);
CREATE TABLE job_batches (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dispatch_status INTEGER,
  dispatch_note TEXT
);
ALTER TABLE occurrence_claims ADD COLUMN job_id TEXT;
ALTER TABLE runs ADD COLUMN job_id TEXT;
CREATE INDEX job_pending_claims ON occurrence_claims(job_id, state, claimed_at);

-- Preserve an enabled old schedule as a named job, including its next-occurrence custom override.
INSERT INTO scheduled_jobs(id,name,name_key,schedule_json,policy,remaining_json,outros_json,enabled_at,created_at,updated_at)
SELECT 'legacy-default','Default schedule','default schedule',COALESCE(schedule_json,'[{"day":5,"minute":300}]'),selection_policy,
  CASE WHEN pending_custom_file_id IS NULL THEN '[]' ELSE json_array(json_object('fileId',pending_custom_file_id,'fileName',COALESCE(pending_custom_file_name,pending_custom_file_id))) END,
  COALESCE(outros_json,'{}'),COALESCE(automation_enabled_at,updated_at),updated_at,updated_at
FROM settings WHERE id=1 AND automation_enabled=1;
INSERT INTO job_reservations(file_id,job_id)
SELECT pending_custom_file_id,'legacy-default' FROM settings
WHERE id=1 AND automation_enabled=1 AND pending_custom_file_id IS NOT NULL;
-- Disable the legacy singleton, avoiding a second dispatch of the migrated schedule.
UPDATE settings SET automation_enabled=0,pending_custom_file_id=NULL,pending_custom_file_name=NULL,
  pending_custom_config_version=NULL,config_version=config_version+1 WHERE id=1 AND (automation_enabled=1 OR pending_custom_file_id IS NOT NULL);
