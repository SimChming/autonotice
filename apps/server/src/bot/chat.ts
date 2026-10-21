import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { OWNER_QQ } from "@autonotice/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { alerts, bindings, scheduleItems } from "../db/schema.js";
import type { LlmClient, LlmMessage } from "../llm/client.js";
import type { NotifyHub } from "../notify/hub.js";
import type { OneBotClient } from "../onebot/client.js";
import { buildSystemPrompt } from "./persona.js";
import { appendHistory, loadRecentHistory, loadSummary, maybeSummarize } from "./history.js";
import { recallMemories, saveMemory } from "./memory.js";
import { runShell } from "./shell.js";

const MAX_ROUNDS = 6;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT = 3;

const contractSchema = z.object({
  reply: z.string().default(""),
  command: z.string().nullable().optional(),
  api: z
    .object({ action: z.string(), params: z.record(z.unknown()).default({}) })
    .nullable()
    .optional(),
  autonotice: z
    .object({ action: z.string(), params: z.record(z.unknown()).default({}) })
    .nullable()
    .optional(),
  memory: z
    .object({ content: z.string(), tags: z.array(z.string()).default([]) })
    .nullable()
    .optional(),
  followups: z.array(z.string()).nullable().optional(),
});

export type BotContract = z.infer<typeof contractSchema>;

export interface ChatInput {
  sessionKey: string;
  senderQq: string;
  senderName: string;
  text: string;
  groupId?: string;
  send: (text: string) => Promise<void>;
}

export interface ChatDeps {
  db: Db;
  config: Config;
  llm: LlmClient;
  hub: NotifyHub;
  onebot: OneBotClient;
  logger: FastifyBaseLogger;
}

const FALLBACK_REPLY = "🐋 呜…主人的鲸鱼脑有点晕，等下再试喵~";
const RATE_LIMIT_REPLY = "呜…你问得太快啦，让鲸鱼娘歇 5 分钟再回答你喵～";

function jsonParse(text: string): BotContract | null {
  try {
    const parsed = contractSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isOwner(qq: string): boolean {
  return qq === OWNER_QQ;
}

function assertNoTarget(params: Record<string, unknown>, owner: boolean): string | null {
  if (owner) {
    return null;
  }
  if ("target_qq" in params || "target_user_id" in params) {
    return "普通用户不能操作其他账号";
  }
  return null;
}

function toIso(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

export class BotChat {
  private readonly rateBuckets = new Map<string, number[]>();

  constructor(private readonly deps: ChatDeps) {}

  private allowed(qq: string): boolean {
    if (isOwner(qq)) {
      return true;
    }
    const now = Date.now();
    const bucket = (this.rateBuckets.get(qq) ?? []).filter((time) => now - time < RATE_WINDOW_MS);
    if (bucket.length >= RATE_LIMIT) {
      this.rateBuckets.set(qq, bucket);
      return false;
    }
    bucket.push(now);
    this.rateBuckets.set(qq, bucket);
    return true;
  }

  async handle(input: ChatInput): Promise<void> {
    const { db, config, llm, logger } = this.deps;

    if (!this.allowed(input.senderQq)) {
      await input.send(RATE_LIMIT_REPLY);
      return;
    }

    const binding = db.select().from(bindings).where(eq(bindings.qq, input.senderQq)).get();
    const identity = isOwner(input.senderQq)
      ? "主人（服务器管理员，唯一指定 QQ 3874095145）"
      : `同学（QQ${input.senderQq}，昵称 ${input.senderName || "未知"}）`;

    appendHistory(db, input.sessionKey, "user", input.senderQq, input.text);

    let memories: string[] = [];
    try {
      memories = await recallMemories(db, config, input.sessionKey, input.senderQq, input.text);
    } catch (error) {
      logger.warn({ err: error }, "记忆召回失败");
    }

    const system = buildSystemPrompt({
      identity,
      capabilities: "图片/表情/语音/视频/文件/撤回/@全体 全部开启",
      memoryFragments: memories,
      history: loadRecentHistory(db, input.sessionKey),
      summary: loadSummary(db, input.sessionKey),
      nowIso: new Date().toISOString(),
    });

    const messages: LlmMessage[] = [
      { role: "system", content: system },
      { role: "user", content: input.text || "（空消息）" },
    ];

    let finalReply = "";
    let followups: string[] = [];
    let memory: BotContract["memory"] = null;

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      let contract: BotContract | null = null;
      try {
        const raw = await llm.chatJson(messages);
        contract = jsonParse(raw);
        if (!contract) {
          const retry = await llm.chatJson([
            messages[0] ?? { role: "system", content: system },
            ...messages.slice(1),
            { role: "user", content: "上一次输出不是合法的 json，请严格按约定只输出 json 对象。" },
          ]);
          contract = jsonParse(retry);
        }
      } catch (error) {
        logger.warn({ err: error, sessionKey: input.sessionKey }, "机器人 LLM 调用失败");
      }

      if (!contract) {
        await input.send(FALLBACK_REPLY);
        return;
      }

      if (contract.reply.trim()) {
        finalReply = contract.reply.trim();
      }
      if (contract.followups?.length) {
        followups = contract.followups.filter((item) => item.trim()).slice(0, 2);
      }
      if (contract.memory?.content) {
        memory = contract.memory;
      }

      let toolResult: string | null = null;

      if (contract.command) {
        if (!isOwner(input.senderQq)) {
          toolResult = "拒绝：普通用户不能执行 shell 命令";
        } else {
          const result = await runShell(contract.command);
          toolResult = `[输出 ${result.ok ? "成功" : "失败"}]\n${result.output}`;
        }
      } else if (contract.api) {
        try {
          const data = await this.deps.onebot.request(contract.api.action, contract.api.params);
          toolResult = `[输出] ${JSON.stringify(data).slice(0, 3000)}`;
        } catch (error) {
          toolResult = `[输出] 调用失败：${error instanceof Error ? error.message : String(error)}`;
        }
      } else if (contract.autonotice) {
        toolResult = await this.runAutonotice(input, binding?.userId ?? null, contract.autonotice);
      }

      if (toolResult === null) {
        break;
      }

      messages.push({ role: "user", content: toolResult });
    }

    const reply = finalReply || "🐋 鲸鱼娘记住啦～";
    appendHistory(db, input.sessionKey, "assistant", null, reply);
    await input.send(reply);

    for (const extra of followups) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await input.send(extra);
    }

    if (memory?.content) {
      try {
        await saveMemory(db, config, input.sessionKey, input.senderQq, memory.content, memory.tags);
      } catch (error) {
        logger.warn({ err: error }, "记忆写入失败");
      }
    }

    void maybeSummarize(db, llm, input.sessionKey, logger);
  }

  private async runAutonotice(
    input: ChatInput,
    userId: number | null,
    action: { action: string; params: Record<string, unknown> },
  ): Promise<string> {
    const { db, hub } = this.deps;
    const owner = isOwner(input.senderQq);
    const denied = assertNoTarget(action.params, owner);
    if (denied) {
      return `[命令结果] ${denied}`;
    }

    if (!userId) {
      return "[命令结果] 你还没有绑定 Autonotice 账号，请先在客户端完成绑定";
    }

    const params = action.params;

    switch (action.action) {
      case "account.whoami":
        return `[命令结果] 已绑定 QQ${input.senderQq}，user_id=${userId}`;

      case "schedule.list": {
        const limit = Math.min(Number(params.limit) || 10, 20);
        const rows = db
          .select()
          .from(scheduleItems)
          .where(and(eq(scheduleItems.userId, userId), eq(scheduleItems.status, "pending")))
          .limit(limit)
          .all();
        return `[命令结果] ${JSON.stringify(rows.map((row) => ({ id: row.id, title: row.title, due_at: row.dueAt })))}`;
      }

      case "schedule.create": {
        const title = String(params.title ?? "").trim();
        if (!title) {
          return "[命令结果] 缺少 title";
        }
        const dueAt = toIso(params.due_at);
        const remindAt = toIso(params.remind_at) ?? (dueAt ? dueAt - 30 * 60 * 1000 : null);
        const now = Date.now();
        const row = db
          .insert(scheduleItems)
          .values({
            userId,
            groupId: input.groupId ?? null,
            title,
            type: String(params.type ?? "task"),
            priority: String(params.priority ?? "normal"),
            status: "pending",
            dueAt,
            remindAt,
            notes: String(params.notes ?? ""),
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: scheduleItems.id })
          .get();
        if (dueAt || remindAt) {
          db.insert(alerts)
            .values({
              userId,
              scheduleId: row.id,
              level: "normal",
              title,
              body: String(params.notes ?? ""),
              route: "ws",
              at: remindAt ?? dueAt!,
            })
            .run();
        }
        return `[命令结果] 已创建日程 id=${row.id}`;
      }

      case "schedule.update": {
        const id = Number(params.id);
        const existing = db
          .select()
          .from(scheduleItems)
          .where(and(eq(scheduleItems.id, id), eq(scheduleItems.userId, userId)))
          .get();
        if (!existing) {
          return "[命令结果] 日程不存在";
        }
        db.update(scheduleItems)
          .set({
            title: String(params.title ?? existing.title),
            status: String(params.status ?? existing.status),
            dueAt: params.due_at === undefined ? existing.dueAt : toIso(params.due_at),
            updatedAt: Date.now(),
          })
          .where(eq(scheduleItems.id, id))
          .run();
        return `[命令结果] 已更新日程 id=${id}`;
      }

      case "schedule.delete": {
        const id = Number(params.id);
        db.delete(scheduleItems)
          .where(and(eq(scheduleItems.id, id), eq(scheduleItems.userId, userId)))
          .run();
        return `[命令结果] 已删除日程 id=${id}`;
      }

      case "notify.send": {
        const title = String(params.title ?? "提醒");
        const body = String(params.body ?? "");
        hub.push(userId, {
          type: "alert",
          id: 0,
          scheduleId: null,
          level: String(params.level ?? "info"),
          title,
          body,
          at: new Date().toISOString(),
        });
        return "[命令结果] 已推送到客户端";
      }

      case "client.alarm": {
        hub.push(userId, {
          type: "alarm",
          title: String(params.title ?? "叫醒啦"),
          body: String(params.body ?? ""),
          mode: String(params.mode ?? "both"),
        });
        return "[命令结果] 已发送闹铃";
      }

      default:
        return `[命令结果] 不支持的动作 ${action.action}`;
    }
  }
}
