CREATE TABLE IF NOT EXISTS content_assets (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_qq TEXT,
  kind TEXT NOT NULL,
  title TEXT,
  declared_url TEXT,
  file_id TEXT,
  busid TEXT,
  file_name TEXT,
  file_ext TEXT,
  size_bytes INTEGER,
  mime TEXT,
  fetch_status TEXT NOT NULL DEFAULT 'pending',
  final_url TEXT,
  http_status INTEGER,
  body_text TEXT,
  body_chars INTEGER,
  blocked_reason TEXT,
  content_hash TEXT,
  fingerprint TEXT NOT NULL,
  fetched_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_assets_fingerprint ON content_assets(fingerprint);
CREATE INDEX IF NOT EXISTS idx_content_assets_status ON content_assets(fetch_status);
CREATE INDEX IF NOT EXISTS idx_content_assets_group ON content_assets(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_content_assets_hash ON content_assets(content_hash);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  user_qq TEXT NOT NULL,
  group_id TEXT NOT NULL,
  content_asset_id TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'high',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  context_excerpt TEXT,
  review_reason TEXT,
  delivered INTEGER NOT NULL DEFAULT 0,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_asset_user ON alerts(content_asset_id, user_qq);
CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_qq, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_unread ON alerts(user_qq, read_at);
