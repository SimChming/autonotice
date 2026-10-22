import { and, eq, lte } from "drizzle-orm";
import cron from "node-cron";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { triggers } from "../db/schema.js";
import type { NotifyHub } from "../notify/hub.js";
import type { OneBotClient } from "../onebot/client.js";
import { executeSkill, SkillDeniedError } from "../skills/handlers.js";
import type { SkillManifest } from "@autonotice/shared";
import { listSkills } from "../skills/registry.js";
import { runShell } from "../bot/shell.js";

export type TriggerAction =
  | { type: "say"; text: string }
  | { type: "skill"; id: string; params?: Record<string, unknown> }
  | { type: "shell"; command: string }
  | { type: "notify"; title: string; body?: string; level?: string };

export interface TriggerContext {
  db: Db;
  config: Config;
  onebot: OneBotClient;
  hub: NotifyHub;
  logger: FastifyBaseLogger;
}

type TriggerRow = typeof triggers.$inferSelect;

function parseAction(raw: string): TriggerAction | null {
  try {
    const parsed = JSON.parse(raw) as TriggerAction;
    return parsed && typeof parsed.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function sendToSession(onebot: OneBotClient, sessionKey: string, text: string): Promise<void> {
  const [kind, id] = sessionKey.split(":");
  if (kind === "group" && id) {
    await onebot.sendGroupMsg(id, text);
  } else if (kind === "private" && id) {
    await onebot.sendPrivateMsg(id, text);
  }
}

/** 执行触发器动作；shell 仅允许主人创建的触发器。 */
export async function executeTrigger(
  context: TriggerContext,
  trigger: TriggerRow,
  action: TriggerAction,
  skills: SkillManifest[],
): Promise<boolean> {
  const { onebot, logger } = context;

  switch (action.type) {
    case "say":
      await sendToSession(onebot, trigger.sessionKey, action.text.slice(0, 1000));
      return true;

    case "skill": {
      const manifest = skills.find((skill) => skill.id === action.id && skill.type === "tool");
      if (!manifest) {
        logger.warn({ triggerId: trigger.id, skill: action.id }, "触发器技能不存在");
        return false;
      }
      try {
        await executeSkill(manifest, action.params ?? {}, {
          db: context.db,
          config: context.config,
          onebot,
          hub: context.hub,
          logger,
          qq: "",
          userId: trigger.userId,
          groupId: trigger.sessionKey.startsWith("group:")
            ? trigger.sessionKey.split(":")[1]
            : undefined,
          sessionKey: trigger.sessionKey,
        });
        return true;
      } catch (error) {
        if (error instanceof SkillDeniedError) {
          logger.warn({ triggerId: trigger.id }, error.message);
        }
        return false;
      }
    }

    case "shell": {
      // 只有主人（QQ 3874095145）创建的触发器允许 shell
      const { bindings } = await import("../db/schema.js");
      const binding = context.db
        .select()
        .from(bindings)
        .where(eq(bindings.userId, trigger.userId))
        .get();
      if (binding?.qq !== "3874095145") {
        logger.warn({ triggerId: trigger.id }, "非主人触发器拒绝 shell");
        return false;
      }
      const result = await runShell(action.command);
      await sendToSession(onebot, trigger.sessionKey, `[定时任务输出]\n${result.output}`.slice(0, 1500));
      return result.ok;
    }

    case "notify":
      context.hub.push(trigger.userId, {
        type: "alert",
        id: 0,
        scheduleId: null,
        level: action.level ?? "info",
        title: action.title,
        body: action.body ?? "",
        at: new Date().toISOString(),
      });
      return true;

    default:
      return false;
  }
}

/** 扫描到点的 time 触发器；一次性执行后停用。 */
export async function fireDueTriggers(context: TriggerContext): Promise<void> {
  const now = Date.now();
  const due = context.db
    .select()
    .from(triggers)
    .where(and(eq(triggers.kind, "time"), eq(triggers.enabled, 1), lte(triggers.at, now)))
    .limit(20)
    .all();
  if (!due.length) {
    return;
  }
  const skills = listSkills(context.db);

  for (const trigger of due) {
    const action = parseAction(trigger.action);
    if (action) {
      try {
        await executeTrigger(context, trigger, action, skills);
      } catch (error) {
        context.logger.warn({ err: error, triggerId: trigger.id }, "触发器执行失败");
      }
    }
    context.db
      .update(triggers)
      .set({ enabled: 0, lastFiredAt: Date.now() })
      .where(eq(triggers.id, trigger.id))
      .run();
  }
}

/** 每 15 秒扫描一次到点触发器。 */
export function startTriggerScheduler(context: TriggerContext) {
  return cron.schedule("*/15 * * * * *", () => {
    void fireDueTriggers(context).catch((error: unknown) => {
      context.logger.error({ err: error }, "触发器调度失败");
    });
  });
}

/** 群消息事件触发：按关键词（逗号分隔）匹配当前会话。 */
export async function fireEventTriggers(
  context: TriggerContext,
  sessionKey: string,
  text: string,
): Promise<void> {
  const rows = context.db
    .select()
    .from(triggers)
    .where(and(eq(triggers.kind, "event"), eq(triggers.enabled, 1), eq(triggers.sessionKey, sessionKey)))
    .all();
  if (!rows.length) {
    return;
  }
  const skills = listSkills(context.db);

  for (const trigger of rows) {
    const keywords = (trigger.event ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    if (!keywords.some((keyword) => text.includes(keyword))) {
      continue;
    }
    const action = parseAction(trigger.action);
    if (action) {
      try {
        await executeTrigger(context, trigger, action, skills);
      } catch (error) {
        context.logger.warn({ err: error, triggerId: trigger.id }, "事件触发器执行失败");
      }
    }
    context.db
      .update(triggers)
      .set({ enabled: 0, lastFiredAt: Date.now() })
      .where(eq(triggers.id, trigger.id))
      .run();
  }
}
