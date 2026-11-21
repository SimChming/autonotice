import { BOT_QQ } from "@autonotice/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../db/client.js";
import { messages } from "../../db/schema.js";
import type { OneBotClient } from "../../onebot/client.js";

export interface ChannelDeps {
  db: Db;
  onebot: OneBotClient;
  logger: FastifyBaseLogger;
  /** 后台聊天镜像；QQ 私聊不可用时仍能在后台看到她的回复。 */
  onAssistant?: (sessionKey: string, text: string) => void;
}

export function sessionParts(sessionKey: string): { kind: string; id: string } | null {
  const [kind, id] = sessionKey.split(":");
  return kind && id ? { kind, id } : null;
}

export function groupIdOf(sessionKey: string | null): string | undefined {
  if (!sessionKey) {
    return undefined;
  }
  const parts = sessionParts(sessionKey);
  return parts?.kind === "group" ? parts.id : undefined;
}

/** 把一句话发到会话；群聊同时写入 messages，供后续群上下文使用。 */
export async function sendToSession(
  deps: ChannelDeps,
  sessionKey: string,
  text: string,
): Promise<boolean> {
  const trimmed = text.trim();
  const parts = sessionParts(sessionKey);
  if (!trimmed || !parts) {
    return false;
  }
  try {
    if (parts.kind === "group") {
      await deps.onebot.sendGroupMsg(parts.id, trimmed);
      try {
        deps.db
          .insert(messages)
          .values({
            groupId: parts.id,
            senderQq: BOT_QQ,
            senderName: "鲸鱼娘",
            text: trimmed,
            rawJson: "{}",
            msgTime: Date.now(),
          })
          .run();
      } catch {
        // 写入失败不影响发送
      }
    } else if (parts.kind === "private") {
      await deps.onebot.sendPrivateMsg(parts.id, trimmed);
    } else if (parts.kind === "admin") {
      deps.onAssistant?.(sessionKey, trimmed);
      return true;
    } else {
      return false;
    }
    deps.onAssistant?.(sessionKey, trimmed);
    return true;
  } catch (error) {
    deps.logger.warn({ err: error, sessionKey }, "她发送消息失败");
    return false;
  }
}
