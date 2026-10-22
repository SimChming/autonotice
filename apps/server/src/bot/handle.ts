import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { LlmClient } from "../llm/client.js";
import type { NotifyHub } from "../notify/hub.js";
import type { OneBotClient } from "../onebot/client.js";
import type { NormalizedMessage, NormalizedPrivateMessage } from "../onebot/normalize.js";
import { BotChat } from "./chat.js";

interface HandlerOptions {
  db: Db;
  config: Config;
  llm: LlmClient;
  hub: NotifyHub;
  onebot: OneBotClient;
  logger: FastifyBaseLogger;
  /** 私聊消息与回复镜像到管理后台聊天（QQ 不可用时的备用通道）。 */
  mirrorPrivate?: (message: { role: "user" | "assistant"; text: string; qq: string; at: string }) => void;
}

/** 群内 @ 与私聊统一走鲸鱼娘对话；权限与限流在 BotChat 内强制。 */
export function createBotHandlers(options: HandlerOptions) {
  const chat = new BotChat(options);

  return {
    chat,

    async onGroupAt(message: NormalizedMessage): Promise<void> {
      await chat.handle({
        sessionKey: `group:${message.groupId}`,
        senderQq: message.senderQq,
        senderName: message.senderName,
        text: message.text || "（在群里 @ 了你）",
        groupId: message.groupId,
        send: (text) => options.onebot.sendGroupMsg(message.groupId, text),
      });
    },

    async onPrivateMessage(message: NormalizedPrivateMessage): Promise<void> {
      options.mirrorPrivate?.({
        role: "user",
        text: message.text,
        qq: message.senderQq,
        at: new Date().toISOString(),
      });
      await chat.handle({
        sessionKey: `private:${message.senderQq}`,
        senderQq: message.senderQq,
        senderName: message.senderName,
        text: message.text,
        send: async (text) => {
          await options.onebot.sendPrivateMsg(message.senderQq, text);
          options.mirrorPrivate?.({
            role: "assistant",
            text,
            qq: message.senderQq,
            at: new Date().toISOString(),
          });
        },
      });
    },
  };
}
