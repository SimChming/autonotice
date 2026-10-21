import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { alerts, scheduleItems } from "../db/schema.js";
import type { LlmClient } from "../llm/client.js";
import type { ExtractedItem } from "./extract.js";

interface MergeOptions {
  db: Db;
  llm: LlmClient;
  logger: FastifyBaseLogger;
}

interface ExistingItem {
  id: number;
  title: string;
  dueAt: number | null;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[\s\p{P}]/gu, "");
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** LLM 判定重复；失败则回退到「标题归一化 + 同一天截止」的确定性判定。 */
async function findDuplicate(
  llm: LlmClient,
  existing: ExistingItem[],
  item: ExtractedItem,
): Promise<number | null> {
  const prompt = `请判断新日程是否与已有日程重复。只输出 json：
{"duplicate":true/false,"existing_id":数字或null}
判定标准：同一件事、同一截止日期即视为重复。

已有日程：
${JSON.stringify(existing)}

新日程：
${JSON.stringify({ title: item.title, due_at: item.dueAt ? new Date(item.dueAt).toISOString() : null })}`;

  try {
    const raw = await llm.chatJson([
      { role: "system", content: "你是日程去重判断器，只输出 json。" },
      { role: "user", content: prompt },
    ]);
    const parsed = JSON.parse(raw) as { duplicate?: boolean; existing_id?: number | null };
    if (parsed.duplicate && typeof parsed.existing_id === "number") {
      return parsed.existing_id;
    }
  } catch {
    // 落入确定性兜底
  }

  const key = normalizeTitle(item.title);
  const match = existing.find(
    (candidate) =>
      normalizeTitle(candidate.title) === key &&
      item.dueAt !== null &&
      candidate.dueAt !== null &&
      dayKey(candidate.dueAt) === dayKey(item.dueAt),
  );
  return match?.id ?? null;
}

/** 合并入库：返回新建的日程 id 列表；重复项直接跳过。 */
export async function mergeAndSave(
  options: MergeOptions,
  userId: number,
  groupId: string,
  sourceMsgId: number | null,
  items: ExtractedItem[],
): Promise<number[]> {
  const { db, llm, logger } = options;
  if (!items.length) {
    return [];
  }

  const existing = db
    .select({ id: scheduleItems.id, title: scheduleItems.title, dueAt: scheduleItems.dueAt })
    .from(scheduleItems)
    .where(eq(scheduleItems.userId, userId))
    .all()
    .slice(0, 50) as ExistingItem[];

  const created: number[] = [];
  const now = Date.now();

  for (const item of items) {
    const duplicateId = existing.length ? await findDuplicate(llm, existing, item) : null;
    if (duplicateId !== null) {
      logger.info({ duplicateId, title: item.title }, "日程重复，已跳过");
      continue;
    }

    const inserted = db
      .insert(scheduleItems)
      .values({
        userId,
        groupId,
        title: item.title,
        type: item.type,
        priority: item.priority,
        status: "pending",
        dueAt: item.dueAt,
        remindAt: item.remindAt,
        notes: item.notes,
        sourceMsgId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: scheduleItems.id })
      .get();

    created.push(inserted.id);
    existing.push({ id: inserted.id, title: item.title, dueAt: item.dueAt });

    const alertAt = item.remindAt ?? item.dueAt;
    if (alertAt !== null) {
      db.insert(alerts)
        .values({
          userId,
          scheduleId: inserted.id,
          level: item.priority === "high" ? "high" : "normal",
          title: item.title,
          body: item.notes,
          route: "ws",
          at: alertAt,
        })
        .run();
    }
  }

  return created;
}
