-- Old rules retain all destinations; selection progress and reservations are unchanged.
ALTER TABLE scheduled_jobs ADD COLUMN destinations_json TEXT;
