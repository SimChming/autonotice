CREATE TABLE IF NOT EXISTS user_state (
  user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  digest TEXT,
  last_summary_at INTEGER,
  updated_at INTEGER NOT NULL
);
