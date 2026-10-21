import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { groups, messages } from "../db/schema.js";
import type { NormalizedMessage } from "../onebot/normalize.js";
import { autoConfirmBind } from "../services/bind.js";

export interface IngestDeps {
  db: Db;
  bindGroupId: string;
  onAtBot: (message: NormalizedMessage) => Promise<void> | void;
  logger: FastifyBaseLogger;
}

/**
 * NapCat 群消息 → 归一化结果 → messages 入库 → 绑定码识别 → @ 机器人分发。
 * 本阶段只做最小链路，LLM 管线在 Phase 4 接入。
 */
export async function ingestMessage(deps: IngestDeps, message: NormalizedMessage): Promise<void> {
  const { db, logger } = deps;
  const now = Date.now();

  const existing = db.select().from(groups).where(eq(groups.groupId, message.groupId)).get();
  if (!existing) {
    db.insert(groups).values({ groupId: message.groupId, updatedAt: now }).run();
  } else {
    db.update(groups).set({ updatedAt: now }).where(eq(groups.groupId, message.groupId)).run();
  }

  db.insert(messages)
    .values({
      groupId: message.groupId,
      senderQq: message.senderQq,
      text: message.text,
      rawJson: JSON.stringify(message.raw),
      msgTime: message.msgTime,
    })
    .run();

  if (message.groupId === deps.bindGroupId) {
    const bound = autoConfirmBind(db, message.senderQq, message.text);
    if (bound) {
      logger.info({ qq: bound.qq }, "绑定码已在群内自动确认");
    }
  }

  if (message.isAtBot) {
    await deps.onAtBot(message);
  }
}
