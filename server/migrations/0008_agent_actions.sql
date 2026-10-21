-- 0008: Autonotice Agent 动作队列（供大模型 / QQ 机器人驱动客户端）
CREATE TABLE IF NOT EXISTS agent_actions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  user_qq      TEXT NOT NULL DEFAULT '',
  action       TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  payload      TEXT NOT NULL DEFAULT '{}',
  source       TEXT NOT NULL DEFAULT 'api',
  due_at       INTEGER,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  acked_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_actions_user ON agent_actions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_actions_pending ON agent_actions(user_id, acked_at);
