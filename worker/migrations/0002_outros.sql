-- Per-platform outro clips appended to published videos: {"youtube":{"fileId","fileName"},...}
ALTER TABLE settings ADD COLUMN outros_json TEXT;
