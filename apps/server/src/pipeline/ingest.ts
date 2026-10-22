import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { bindings, groups, messages } from "../db/schema.js";
import type { NormalizedMessage } from "../onebot/normalize.js";
import { autoConfirmBind } from "../services/bind.js";

export interface IngestDeps {
  db: Db;
  bindGroupId: string;
  onAtBot: (message: NormalizedMessage) => Promise<void> | void;
  onBoundUserMessage?: (userId: number, message: NormalizedMessage, msgId: number) => void;
  onGroupMessageEvent?: (sessionKey: string, text: string) => void;
  /** 新群/群信息缺失时补全群名称。 */
  onGroupSeen?: (groupId: string) => void;
  /** 群内绑定码确认成功后，把该群加入用户的群聊列表。 */
  onBindConfirmed?: (userId: number, groupId: string) => void;
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
  if (!existing || !existing.name) {
    deps.onGroupSeen?.(message.groupId);
  }

  const inserted = db.insert(messages)
    .values({
      groupId: message.groupId,
      senderQq: message.senderQq,
      text: message.text,
      rawJson: JSON.stringify(message.raw),
      msgTime: message.msgTime,
    })
    .returning({ id: messages.id })
    .get();

  const binding = db.select().from(bindings).where(eq(bindings.qq, message.senderQq)).get();
  if (binding && deps.onBoundUserMessage && message.text.trim()) {
    deps.onBoundUserMessage(binding.userId, message, inserted.id);
  }

  if (deps.onGroupMessageEvent && message.text.trim()) {
    deps.onGroupMessageEvent(`group:${message.groupId}`, message.text);
  }

  if (message.groupId === deps.bindGroupId) {
    const bound = autoConfirmBind(db, message.senderQq, message.text);
    if (bound) {
      deps.onBindConfirmed?.(bound.userId, message.groupId);
      logger.info({ qq: bound.qq }, "绑定码已在群内自动确认");
    }
  }

  if (message.isAtBot) {
    await deps.onAtBot(message);
  }
}
