import type { FastifyBaseLogger } from "fastify";
import { eq } from "drizzle-orm";
import { OWNER_QQ, type SkillManifest } from "@autonotice/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { NotifyHub } from "../notify/hub.js";
import { triggers } from "../db/schema.js";
import type { OneBotClient } from "../onebot/client.js";
import { fetchBinary } from "../pipeline/fetcher.js";
import { searchWeb } from "../services/websearch.js";
import { getActivePersona, listSkills, setActivePersona } from "./registry.js";
import { skills as skillsTable } from "../db/schema.js";
import { runShell } from "../bot/shell.js";

export interface SkillContext {
  db: Db;
  config: Config;
  onebot: OneBotClient;
  hub: NotifyHub;
  logger: FastifyBaseLogger;
  qq: string;
  userId: number | null;
  groupId?: string;
  sessionKey: string;
}

export const SUPPORTED_HANDLERS = [
  { id: "image.send", description: "发送图片（params.url）" },
  { id: "image.describe", description: "视觉模型识图（params.url）" },
  { id: "persona.switch", description: "切换人格（params.id，仅主人）" },
  { id: "persona.current", description: "查看当前人格（仅主人）" },
  { id: "trigger.create", description: "创建定时/事件触发器（params.kind/at/event/say/action）" },
  { id: "trigger.list", description: "列出自己的触发器" },
  { id: "trigger.cancel", description: "取消触发器（params.id）" },
  { id: "skill.manage", description: "技能自迭代：list/update/create/delete（仅主人）" },
  { id: "web.search", description: "联网搜索（params.query 关键词，params.limit 可选）" },
  { id: "tools.install", description: "安装并持久化命令行工具（params.package，仅主人）" },
] as const;

export class SkillDeniedError extends Error {}

function checkPermission(skill: SkillManifest, context: SkillContext): void {
  if (skill.permissions === "owner" && context.qq !== OWNER_QQ) {
    throw new SkillDeniedError("该技能仅主人可用");
  }
  if (skill.permissions === "bound" && !context.userId) {
    throw new SkillDeniedError("请先绑定 Autonotice 账号");
  }
}

interface VisionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

async function describeImage(config: Config, dataUrl: string): Promise<string> {
  const response = await fetch(`${config.llm.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: config.llm.visionModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "用不超过 200 字的中文描述这张图片的关键内容。" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 500,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`视觉模型调用失败 ${response.status}`);
  }
  const data = (await response.json()) as VisionResponse;
  return data.choices?.[0]?.message?.content?.trim() ?? "（模型未返回内容）";
}

/** 技能执行器：内置 handler 白名单，绝不执行用户自定义代码。 */
export async function executeSkill(
  skill: SkillManifest,
  params: Record<string, unknown>,
  context: SkillContext,
): Promise<string> {
  checkPermission(skill, context);
  const handler = skill.handler;
  if (!handler) {
    return "该技能没有可执行动作";
  }

  switch (handler) {
    case "image.send": {
      const url = String(params.url ?? "").trim();
      if (!/^https?:\/\//.test(url)) {
        return "缺少合法的图片 url";
      }
      const cq = `[CQ:image,file=${url}]`;
      if (context.groupId) {
        await context.onebot.sendGroupCq(context.groupId, cq);
      } else {
        await context.onebot.sendPrivateCq(context.qq, cq);
      }
      return "图片已发送";
    }

    case "image.describe": {
      const url = String(params.url ?? "").trim();
      if (!/^https?:\/\//.test(url)) {
        return "缺少合法的图片 url";
      }
      const image = await fetchBinary(url);
      const dataUrl = `data:${image.contentType};base64,${image.data.toString("base64")}`;
      return describeImage(context.config, dataUrl);
    }

    case "persona.switch": {
      const id = String(params.id ?? "").trim();
      if (!setActivePersona(context.db, id)) {
        return `没有找到已启用的人格技能 ${id}`;
      }
      return `已切换到人格 ${id}`;
    }

    case "persona.current": {
      const persona = getActivePersona(context.db);
      return `当前人格：${persona.name}（${persona.id}）`;
    }

    case "trigger.create": {
      if (!context.userId) {
        return "请先绑定账号后再创建触发器";
      }
      const kind = String(params.kind ?? "time");
      if (kind !== "time" && kind !== "event") {
        return "kind 只能是 time 或 event";
      }
      const at = kind === "time" ? toTimestamp(params.at) : null;
      if (kind === "time" && !at) {
        return "time 触发器需要合法的 at（ISO8601）";
      }
      const event = kind === "event" ? String(params.event ?? "").trim() : null;
      if (kind === "event" && !event) {
        return "event 触发器需要关键词 event";
      }

      let action: Record<string, unknown> | null = null;
      if (params.action && typeof params.action === "object") {
        action = params.action as Record<string, unknown>;
      } else if (typeof params.say === "string" && params.say.trim()) {
        action = { type: "say", text: params.say.trim() };
      }
      if (!action || typeof action.type !== "string") {
        return "需要 action（say/skill/shell/notify）或 say 文本";
      }
      if (action.type === "shell" && context.qq !== OWNER_QQ) {
        return "只有主人可以创建 shell 触发器";
      }

      const row = context.db
        .insert(triggers)
        .values({
          userId: context.userId,
          sessionKey: context.sessionKey,
          kind,
          at,
          event,
          action: JSON.stringify(action),
          enabled: 1,
          createdAt: Date.now(),
        })
        .returning({ id: triggers.id })
        .get();
      return `触发器已创建 id=${row.id}（${kind}）`;
    }

    case "trigger.list": {
      if (!context.userId) {
        return "请先绑定账号";
      }
      const rows = context.db
        .select()
        .from(triggers)
        .where(eq(triggers.userId, context.userId))
        .all()
        .filter((row) => row.enabled === 1);
      return JSON.stringify(
        rows.map((row) => ({ id: row.id, kind: row.kind, at: row.at, event: row.event, action: row.action })),
      );
    }

    case "trigger.cancel": {
      if (!context.userId) {
        return "请先绑定账号";
      }
      const id = Number(params.id);
      const row = context.db.select().from(triggers).where(eq(triggers.id, id)).get();
      if (!row || row.userId !== context.userId) {
        return "触发器不存在";
      }
      context.db.update(triggers).set({ enabled: 0 }).where(eq(triggers.id, id)).run();
      return `已取消触发器 id=${id}`;
    }

    case "skill.manage": {
      if (context.qq !== OWNER_QQ) {
        throw new SkillDeniedError("技能自迭代仅主人可用");
      }
      const action = String(params.action ?? "list");

      if (action === "list") {
        return JSON.stringify(listSkills(context.db));
      }

      if (action === "update") {
        const id = String(params.id ?? "");
        const existing = context.db.select().from(skillsTable).where(eq(skillsTable.id, id)).get();
        if (!existing) {
          return `技能 ${id} 不存在`;
        }
        const patch = (params.patch ?? {}) as Record<string, unknown>;
        if (existing.builtin === 1 && (patch.type !== undefined || patch.handler !== undefined)) {
          return "内置技能不允许修改 type/handler";
        }
        if (
          context.db
            .update(skillsTable)
            .set({
              name: typeof patch.name === "string" ? patch.name : existing.name,
              description:
                typeof patch.description === "string" ? patch.description : existing.description,
              enabled:
                typeof patch.enabled === "boolean" ? (patch.enabled ? 1 : 0) : existing.enabled,
              prompt: typeof patch.prompt === "string" ? patch.prompt : existing.prompt,
              handler: typeof patch.handler === "string" ? patch.handler : existing.handler,
              permissions:
                typeof patch.permissions === "string" ? patch.permissions : existing.permissions,
              paramsSchema:
                patch.paramsSchema === undefined
                  ? existing.paramsSchema
                  : JSON.stringify(patch.paramsSchema),
              updatedAt: Date.now(),
            })
            .where(eq(skillsTable.id, id))
            .run()
        ) {
          return `技能 ${id} 已更新`;
        }
        return `技能 ${id} 更新失败`;
      }

      if (action === "create") {
        const skill = (params.skill ?? {}) as Record<string, unknown>;
        const id = String(skill.id ?? "").trim();
        if (!/^[a-z0-9_.-]{2,48}$/.test(id)) {
          return "技能 id 非法";
        }
        if (context.db.select().from(skillsTable).where(eq(skillsTable.id, id)).get()) {
          return `技能 ${id} 已存在`;
        }
        const handlerName = typeof skill.handler === "string" ? skill.handler : null;
        if (handlerName && !SUPPORTED_HANDLERS.some((item) => item.id === handlerName)) {
          return `handler ${handlerName} 不在白名单`;
        }
        context.db
          .insert(skillsTable)
          .values({
            id,
            name: String(skill.name ?? id),
            description: String(skill.description ?? ""),
            type: String(skill.type ?? "instruction"),
            enabled: skill.enabled === false ? 0 : 1,
            prompt: String(skill.prompt ?? ""),
            handler: handlerName,
            permissions: String(skill.permissions ?? "all"),
            paramsSchema: JSON.stringify(skill.paramsSchema ?? {}),
            version: String(skill.version ?? "1.0.0"),
            builtin: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          .run();
        return `技能 ${id} 已创建`;
      }

      if (action === "delete") {
        const id = String(params.id ?? "");
        const existing = context.db.select().from(skillsTable).where(eq(skillsTable.id, id)).get();
        if (!existing) {
          return `技能 ${id} 不存在`;
        }
        if (existing.builtin === 1) {
          return "内置技能不能删除，只能停用";
        }
        context.db.delete(skillsTable).where(eq(skillsTable.id, id)).run();
        return `技能 ${id} 已删除`;
      }

      return `未知 skill.manage 动作 ${action}`;
    }

    case "web.search": {
      const query = String(params.query ?? "").trim();
      if (!query) {
        return "缺少搜索关键词 query";
      }
      const limit = Number(params.limit ?? 5);
      return searchWeb(query, Number.isFinite(limit) ? limit : 5);
    }

    case "tools.install": {
      if (context.qq !== OWNER_QQ) {
        return "只有主人可以安装命令行工具";
      }
      const pkg = String(params.package ?? "").trim();
      if (!/^[a-z0-9][a-z0-9+.-]{1,40}$/.test(pkg)) {
        return "包名不合法，只接受小写 apt 包名（例如 wget）";
      }
      const result = await runShell(`autonotice-install-tool ${pkg}`);
      return result.output;
    }

    default:
      return `未知技能处理器 ${handler}`;
  }
}

function toTimestamp(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}
