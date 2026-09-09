CREATE TABLE IF NOT EXISTS mimit_cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mimit_cache_created ON mimit_cache(created_at);
