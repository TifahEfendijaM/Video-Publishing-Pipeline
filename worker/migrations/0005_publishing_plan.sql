-- One user-facing plan; scheduled_jobs remain internal timetable/rule entries.
CREATE TABLE publishing_plan (
  id INTEGER PRIMARY KEY CHECK(id=1),
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 0,
  outros_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
INSERT INTO publishing_plan(id,paused,updated_at)
SELECT 1,CASE WHEN EXISTS(SELECT 1 FROM scheduled_jobs WHERE status='stopped') THEN 1 ELSE 0 END,
  strftime('%Y-%m-%dT%H:%M:%fZ','now');
ALTER TABLE scheduled_jobs ADD COLUMN custom_original_json TEXT;
ALTER TABLE scheduled_jobs ADD COLUMN plan_position INTEGER NOT NULL DEFAULT 0;
UPDATE scheduled_jobs SET custom_original_json=remaining_json WHERE policy='custom';
-- Previously stopped entries are retained under the plan's global pause control.
UPDATE scheduled_jobs SET status='active' WHERE status='stopped';
