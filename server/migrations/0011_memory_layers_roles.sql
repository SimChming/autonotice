-- Three-layer chatbot memory (persisted turns + rolling summary) and a
-- database-backed QQ role table. Additive only: existing memories,
-- summary_cursors and babble_stats are preserved.

CREATE TABLE IF NOT EXISTS bot_turns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT NOT NULL,
  role        TEXT NOT NULL,
  sender_qq   TEXT,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_turns_session ON bot_turns(session_key, id);

CREATE TABLE IF NOT EXISTS bot_summaries (
  session_key     TEXT PRIMARY KEY,
  summary         TEXT NOT NULL,
  covered_turn_id INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_roles (
  qq         TEXT PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'member',
  note       TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_roles_role ON bot_roles(role);
