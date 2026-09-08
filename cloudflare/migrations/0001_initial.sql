PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS snapshots (
  version TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  station_count INTEGER NOT NULL DEFAULT 0,
  price_count INTEGER NOT NULL DEFAULT 0,
  source_date TEXT NOT NULL DEFAULT '',
  last_refresh_at TEXT NOT NULL DEFAULT '',
  warning TEXT,
  cells_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS tiles (
  version TEXT NOT NULL REFERENCES snapshots(version) ON DELETE CASCADE,
  cell TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(version, cell)
);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  subscription TEXT NOT NULL,
  monitor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_sent (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY(subscription_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS geocode_cache (
  query TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS limits (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

INSERT OR IGNORE INTO limits(key, value) VALUES('geocode_next', 0);
CREATE INDEX IF NOT EXISTS idx_snapshots_published_created ON snapshots(published, created_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_id ON subscriptions(id);
CREATE INDEX IF NOT EXISTS idx_push_sent_old ON push_sent(sent_at);
CREATE INDEX IF NOT EXISTS idx_geocode_cache_created ON geocode_cache(created_at);
