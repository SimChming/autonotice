CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    sender_qq TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_key, created_at);

CREATE INDEX IF NOT EXISTS idx_memories_sender ON memories(sender_qq);
