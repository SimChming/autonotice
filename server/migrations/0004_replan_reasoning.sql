-- 0004: 一键实时排程的思考链留存（仅保留最近一次）
ALTER TABLE summary_runs ADD COLUMN reasoning TEXT;
ALTER TABLE summary_runs ADD COLUMN reasoning_model TEXT;
