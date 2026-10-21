CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  group_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_qq TEXT,
  sender_name TEXT,
  message_type TEXT NOT NULL DEFAULT 'group',
  sub_type TEXT,
  text TEXT,
  raw_message TEXT,
  segments_json TEXT,
  mentions TEXT,
  reply_to_msg_id TEXT,
  fingerprint TEXT NOT NULL,
  msg_time INTEGER,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_fingerprint ON messages(fingerprint);
CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages(group_id, msg_time);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_qq);
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to_msg_id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bindings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  qq_uid TEXT NOT NULL,
  group_id TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_user_qq ON bindings(user_id, qq_uid);
CREATE INDEX IF NOT EXISTS idx_bindings_qq ON bindings(qq_uid);
CREATE INDEX IF NOT EXISTS idx_bindings_verified ON bindings(verified);

CREATE TABLE IF NOT EXISTS bind_codes (
  code TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  qq_uid TEXT NOT NULL,
  group_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bind_codes_user ON bind_codes(user_id);

CREATE TABLE IF NOT EXISTS summary_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  qq_uid TEXT,
  group_id TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  revision INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_summary_runs_user ON summary_runs(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_summary_runs_status ON summary_runs(status);

CREATE TABLE IF NOT EXISTS schedule_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'task',
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT NOT NULL DEFAULT 'normal',
  due_at INTEGER,
  remind_at INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  locked_by_user INTEGER NOT NULL DEFAULT 0,
  source_json TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedule_items_user ON schedule_items(user_id, deleted);
CREATE INDEX IF NOT EXISTS idx_schedule_items_rev ON schedule_items(user_id, revision);
