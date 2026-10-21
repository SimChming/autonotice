-- 为 alerts 表增加来源元信息列，用于前端正确展示私聊 / 群聊来源、
-- 展示群名 / 昵称 / 头像。旧行填 NULL 由客户端回退展示。
ALTER TABLE alerts ADD COLUMN message_type TEXT NOT NULL DEFAULT 'group';
ALTER TABLE alerts ADD COLUMN source_name TEXT DEFAULT '';
ALTER TABLE alerts ADD COLUMN source_avatar TEXT DEFAULT '';

-- 反馈 / 联系我们表（匿名或登录用户均可提交）
CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    user_qq TEXT,
    user_id TEXT,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
CREATE INDEX IF NOT EXISTS idx_feedback_time ON feedback(created_at);
