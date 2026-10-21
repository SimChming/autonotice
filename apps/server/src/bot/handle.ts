import type { FastifyBaseLogger } from "fastify";
import type { OneBotClient } from "../onebot/client.js";
import type { NormalizedMessage } from "../onebot/normalize.js";

const PLACEHOLDER_REPLY = "🐋 鲸鱼娘在呢～日程功能正在装配中喵，稍等就好！";

/** Phase 3 最小回复：验证 @ 触发链路，Phase 6 换成人格对话。 */
export function createAtBotHandler(opts: { botQq: string; client: OneBotClient; logger: FastifyBaseLogger }) {
  return async (message: NormalizedMessage): Promise<void> => {
    if (message.senderQq === opts.botQq) {
      return;
    }
    try {
      await opts.client.sendGroupMsg(message.groupId, PLACEHOLDER_REPLY);
    } catch (error) {
      opts.logger.warn({ err: error, groupId: message.groupId }, "@ 回复失败");
    }
  };
}
