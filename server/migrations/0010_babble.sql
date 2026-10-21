-- 群内随机冒泡的每日计数（按自然日，最多发几条由后台配置决定）。
CREATE TABLE IF NOT EXISTS babble_stats (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
