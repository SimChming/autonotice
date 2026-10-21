CREATE TABLE IF NOT EXISTS admins (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_qqs (
    qq TEXT PRIMARY KEY,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS doc_files (
    id TEXT PRIMARY KEY,
    user_qq TEXT NOT NULL,
    chat_key TEXT NOT NULL,
    filename TEXT NOT NULL,
    type TEXT NOT NULL,
    path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_doc_files_user_time ON doc_files(user_qq, created_at);
CREATE INDEX IF NOT EXISTS idx_doc_files_time ON doc_files(created_at);

CREATE TABLE IF NOT EXISTS doc_drafts (
    chat_key TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    slot_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit(created_at);
