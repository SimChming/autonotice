import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { OWNER_QQ } from "@autonotice/shared";
import type { Db } from "../db/client.js";
import { botHistory } from "../db/schema.js";
import { fail, requireAdmin } from "../auth/guard.js";
import type { OneBotClient } from "../onebot/client.js";
import type { AdminChatHub } from "./chat-hub.js";
import type { createBotHandlers } from "../bot/handle.js";

interface AdminChatOptions {
  db: Db;
  onebot: OneBotClient;
  hub: AdminChatHub;
  bot: ReturnType<typeof createBotHandlers>;
}

const SESSION_KEY = `private:${OWNER_QQ}`;

export function registerAdminChatRoutes(app: FastifyInstance, options: AdminChatOptions): void {
  const { db, onebot, hub, bot } = options;

  app.get("/api/v1/admin/chat/history", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const limit = Math.min(Number((request.query as { limit?: string }).limit) || 100, 200);
    const rows = db
      .select()
      .from(botHistory)
      .where(eq(botHistory.sessionKey, SESSION_KEY))
      .orderBy(desc(botHistory.id))
      .limit(limit)
      .all()
      .reverse();

    return {
      items: rows.map((row) => ({
        role: row.role === "assistant" ? "assistant" : "user",
        text: row.text,
        qq: row.senderQq ?? OWNER_QQ,
        at: new Date(row.createdAt).toISOString(),
      })),
    };
  });

  app.post("/api/v1/admin/chat/send", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const text = String((request.body as { text?: string } | undefined)?.text ?? "").trim();
    if (!text) {
      return fail(reply, 400, "invalid_request", "消息不能为空");
    }

    void bot.chat.handle({
      sessionKey: SESSION_KEY,
      senderQq: OWNER_QQ,
      senderName: "主人",
      text,
      send: async (replyText) => {
        hub.push({ role: "assistant", text: replyText, qq: OWNER_QQ, at: new Date().toISOString() });
        if (onebot.connected) {
          try {
            await onebot.sendPrivateMsg(OWNER_QQ, replyText);
          } catch {
            // QQ 不可用时仅保留后台通道
          }
        }
      },
    });

    return reply.code(202).send({ ok: true });
  });
}
