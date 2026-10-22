import { desc, eq, gt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { BOT_QQ } from "@autonotice/shared";
import type { Db } from "../db/client.js";
import { botHistory, botSummary, messages } from "../db/schema.js";
import type { LlmClient } from "../llm/client.js";

const RECENT_LIMIT = 12;
const SUMMARY_THRESHOLD = 40;
const SUMMARY_CHUNK = 30;

export interface HistoryEntry {
  role: string;
  text: string;
  senderLabel: string;
  /** 用户消息是否已经有对应的助手回复，用于避免模型重复回答旧消息。 */
  replied: boolean;
}

export function appendHistory(
  db: Db,
  sessionKey: string,
  role: "user" | "assistant" | "tool",
  senderQq: string | null,
  text: string,
): void {
  db.insert(botHistory)
    .values({ sessionKey, role, senderQq, text, createdAt: Date.now() })
    .run();
}

export function loadRecentHistory(db: Db, sessionKey: string): HistoryEntry[] {
  const rows = db
    .select()
    .from(botHistory)
    .where(eq(botHistory.sessionKey, sessionKey))
    .orderBy(desc(botHistory.id))
    .limit(RECENT_LIMIT)
    .all()
    .reverse();

  return rows.map((row, index) => {
    let replied = row.role !== "user";
    if (row.role === "user") {
      replied = rows.slice(index + 1).some((later) => later.role === "assistant");
    }
    return {
      role: row.role,
      text: row.text,
      senderLabel: row.role === "assistant" ? "鲸鱼娘" : `QQ${row.senderQq ?? "?"}`,
      replied,
    };
  });
}

export function loadSummary(db: Db, sessionKey: string): string | null {
  return db.select().from(botSummary).where(eq(botSummary.sessionKey, sessionKey)).get()?.summary ?? null;
}

export interface GroupContextEntry {
  senderLabel: string;
  text: string;
  at: string;
}

/** 群聊全量上下文：最近 N 条消息（含未 @ 机器人的消息与机器人自己的发言）。 */
export function loadGroupContext(db: Db, groupId: string, limit = 15): GroupContextEntry[] {
  const rows = db
    .select()
    .from(messages)
    .where(eq(messages.groupId, groupId))
    .orderBy(desc(messages.id))
    .limit(limit)
    .all()
    .reverse();

  return rows.map((row) => ({
    senderLabel:
      row.senderQq === BOT_QQ
        ? "鲸鱼娘"
        : row.senderName
          ? `${row.senderName}(QQ${row.senderQq})`
          : `QQ${row.senderQq}`,
    text: row.text.slice(0, 200),
    at: new Date(row.msgTime).toISOString(),
  }));
}

/** 未摘要历史超过阈值时压缩成 ≤500 字摘要（§4.5，单层摘要）。 */
export async function maybeSummarize(
  db: Db,
  llm: LlmClient,
  sessionKey: string,
  logger: FastifyBaseLogger,
): Promise<void> {
  const existing = db.select().from(botSummary).where(eq(botSummary.sessionKey, sessionKey)).get();
  const coveredId = existing?.coveredId ?? 0;

  const pending = db
    .select()
    .from(botHistory)
    .where(gt(botHistory.id, coveredId))
    .orderBy(botHistory.id)
    .limit(SUMMARY_CHUNK)
    .all();
  if (pending.length < SUMMARY_THRESHOLD) {
    return;
  }

  const transcript = pending
    .map((row) => `${row.role === "assistant" ? "鲸鱼娘" : `QQ${row.senderQq ?? "?"}`}: ${row.text}`)
    .join("\n");

  try {
    const raw = await llm.chatJson([
      { role: "system", content: "你是对话摘要器，只输出 json。" },
      {
        role: "user",
        content: `把下面的对话压缩成不超过 500 字的中文摘要，保留人物身份、约定与重要事实。只输出 json：{"summary":"..."}\n\n${transcript}`,
      },
    ]);
    const parsed = JSON.parse(raw) as { summary?: string };
    if (!parsed.summary?.trim()) {
      return;
    }
    const lastId = pending[pending.length - 1]?.id ?? coveredId;
    db.insert(botSummary)
      .values({ sessionKey, summary: parsed.summary.slice(0, 500), coveredId: lastId, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: botSummary.sessionKey,
        set: { summary: parsed.summary.slice(0, 500), coveredId: lastId, updatedAt: Date.now() },
      })
      .run();
  } catch (error) {
    logger.warn({ err: error, sessionKey }, "会话摘要失败");
  }
}
