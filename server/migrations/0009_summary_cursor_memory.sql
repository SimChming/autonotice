-- 每个（用户, 群聊）各有一个总结时间指针：每次 AI 总结只从指针往后读，
-- 成功后把指针推进到最后一条已处理的消息，避免每次都从很久以前重扫。
CREATE TABLE IF NOT EXISTS summary_cursors (
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  last_msg_time INTEGER NOT NULL DEFAULT 0,
  last_row_id INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id)
);

-- 记忆分两类：chat = 闲聊碎片（按会话召回），preference = 系统级偏好（每轮注入）。
-- scope = global 表示对所有会话生效，peer 表示只对当前会话/这个人生效。
ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'peer';

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_pref
  ON memories(scope, content) WHERE kind = 'preference';

CREATE INDEX IF NOT EXISTS idx_memories_pref_scope
  ON memories(kind, scope, created_at);
