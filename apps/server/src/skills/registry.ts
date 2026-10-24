import { eq } from "drizzle-orm";
import type { CreateSkillRequest, SkillManifest } from "@autonotice/shared";
import type { Db } from "../db/client.js";
import { settings, skills } from "../db/schema.js";
import { PERSONA } from "../bot/persona.js";

type SkillRow = typeof skills.$inferSelect;

export type SkillRowType = SkillRow;

const PERSONA_SETTING_KEY = "persona.active";

/** 内置技能（随镜像发布，不允许删除，只能启停/改提示词）。 */
const BUILTIN_SKILLS: Array<Omit<CreateSkillRequest, "version"> & { version?: string }> = [
  {
    id: "persona.whale",
    name: "鲸鱼娘顽皮女仆",
    description: "默认人格：撒娇粘人、偶尔颜文字，对同学调皮有分寸。",
    type: "persona",
    enabled: true,
    prompt: "",
    handler: "persona.whale",
    permissions: "all",
    paramsSchema: {},
  },
  {
    id: "persona.strict",
    name: "严谨助理",
    description: "备选人格：语气克制、先给结论、不撒娇，适合正式场合。",
    type: "persona",
    enabled: false,
    prompt:
      "你是一个严谨、克制的中文助理。回答先给结论，再给必要细节；不使用颜文字与撒娇语气；称呼对方为「你」，除非身份明确是主人。",
    handler: null,
    permissions: "all",
    paramsSchema: {},
  },
  {
    id: "tool.image.send",
    name: "发送图片",
    description: "向当前群聊/私聊发送一张图片，参数 url 为公网图片地址。",
    type: "tool",
    enabled: true,
    prompt: "",
    handler: "image.send",
    permissions: "bound",
    paramsSchema: {
      type: "object",
      required: ["url"],
      properties: { url: { type: "string", description: "公网可访问的图片地址" } },
    },
  },
  {
    id: "tool.image.describe",
    name: "识图",
    description: "让视觉模型描述一张图片，参数 url 为公网图片地址。",
    type: "tool",
    enabled: true,
    prompt: "",
    handler: "image.describe",
    permissions: "bound",
    paramsSchema: {
      type: "object",
      required: ["url"],
      properties: { url: { type: "string" } },
    },
  },
  {
    id: "tool.persona.switch",
    name: "切换人格",
    description: "切换机器人当前使用的人格技能，参数 id 为 persona 技能 id（仅主人）。",
    type: "tool",
    enabled: true,
    prompt: "",
    handler: "persona.switch",
    permissions: "owner",
    paramsSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    id: "tool.persona.current",
    name: "查看当前人格",
    description: "返回机器人当前启用的人格技能。",
    type: "tool",
    enabled: true,
    prompt: "",
    handler: "persona.current",
    permissions: "owner",
    paramsSchema: {},
  },
  {
    id: "tool.trigger.create",
    name: "创建触发器",
    description:
      "给自己安排定时或事件触发的工作。params: kind=time|event，at=ISO 时间（time 必填），event=关键词（event 必填），say=到点要发的话，action={type:say|skill|shell|notify,...}。",
    type: "tool",
    enabled: true,
    prompt: "",
    handler: "trigger.create",
    permissions: "bound",
    paramsSchema: {
      type: "object",
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["time", "event"] },
        at: { type: "string", description: "ISO8601 时间" },
        event: { type: "string", description: "事件关键词，逗号分隔" },
        say: { type: "string", description: "到点发送的文本" },
        action: { type: "object", description: "更复杂的动作，如 {type:'skill',id,params}" },
      },
    },
  },
  {
    id: "tool.trigger.list",
    name: "列出触发器",
    description: "列出当前账号尚未执行的触发器。",
    type: "tool",
    enabled: true,
    prompt: "",
    handler: "trigger.list",
    permissions: "bound",
    paramsSchema: {},
  },
  {
    id: "tool.trigger.cancel",
    name: "取消触发器",
    description: "取消一个触发器，参数 id。",
    type: "tool",
    enabled: true,
    prompt: "",
    handler: "trigger.cancel",
    permissions: "bound",
    paramsSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "number" } },
    },
  },
  {
    id: "tool.web.search",
    name: "联网搜索",
    description:
      "遇到不认识的名词、作品、人物、新闻或不确定的事实时，先联网搜索再回答。params: query=搜索关键词，limit=结果数（1-8，默认 5）。",
    type: "tool",
    enabled: true,
    prompt: "",
    handler: "web.search",
    permissions: "all",
    paramsSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "搜索关键词" },
        limit: { type: "number", description: "返回结果数量，默认 5" },
      },
    },
  },
  {
    id: "tool.tools.install",
    name: "安装命令行工具",
    description:
      "主人专用：镜像已内置 wget/curl/jq/unzip 等常用工具，优先直接用。确实缺少时才安装（提供 package 与 confirm=true），只允许白名单内的常见命令行工具；action=list 可查看额外持久化清单。",
    type: "tool",
    enabled: true,
    prompt: "",
    handler: "tools.install",
    permissions: "owner",
    paramsSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["install", "list"], description: "默认 install" },
        package: { type: "string", description: "apt 包名，例如 sqlite3" },
        confirm: { type: "boolean", description: "主人明确要求安装时设为 true" },
      },
    },
  },
  {
    id: "tool.skill.manage",
    name: "技能自迭代",
    description:
      "主人专用：读取/修改/新增/删除技能清单。params.action=list|update|create|delete；update 传 id+patch，create 传 skill 对象。结合 /repo/AI-WORKFLOW.md 判断如何调整。",
    type: "tool",
    enabled: true,
    prompt: "",
    handler: "skill.manage",
    permissions: "owner",
    paramsSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["list", "update", "create", "delete"] },
        id: { type: "string" },
        patch: { type: "object" },
        skill: { type: "object" },
      },
    },
  },
];

export function seedSkills(db: Db): void {
  const now = Date.now();
  for (const item of BUILTIN_SKILLS) {
    db.insert(skills)
      .values({
        id: item.id,
        name: item.name,
        description: item.description,
        type: item.type,
        enabled: item.enabled ? 1 : 0,
        prompt: item.prompt,
        handler: item.handler,
        permissions: item.permissions,
        paramsSchema: JSON.stringify(item.paramsSchema),
        version: item.version ?? "1.0.0",
        builtin: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: skills.id,
        // 内置技能的说明与参数随版本更新；提示词/启停保留管理员的修改。
        set: {
          name: item.name,
          description: item.description,
          paramsSchema: JSON.stringify(item.paramsSchema),
          updatedAt: now,
        },
      })
      .run();
  }
}

export function toManifest(row: SkillRow): SkillManifest {
  let paramsSchema: Record<string, unknown> = {};
  try {
    paramsSchema = JSON.parse(row.paramsSchema) as Record<string, unknown>;
  } catch {
    paramsSchema = {};
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type as SkillManifest["type"],
    enabled: row.enabled === 1,
    prompt: row.prompt,
    handler: row.handler,
    permissions: row.permissions as SkillManifest["permissions"],
    paramsSchema,
    version: row.version,
    builtin: row.builtin === 1,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export function listSkills(db: Db): SkillManifest[] {
  return db.select().from(skills).all().map(toManifest);
}

export function getEnabledSkills(db: Db): SkillManifest[] {
  return db.select().from(skills).where(eq(skills.enabled, 1)).all().map(toManifest);
}

export function getSetting(db: Db, key: string): string | null {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() } })
    .run();
}

export interface ActivePersona {
  id: string;
  name: string;
  prompt: string;
}

/** 当前人格：settings.persona.active 指向的 persona 技能；未设置时用鲸鱼娘。 */
export function getActivePersona(db: Db): ActivePersona {
  const wanted = getSetting(db, PERSONA_SETTING_KEY);
  const rows = db.select().from(skills).where(eq(skills.type, "persona")).all();
  const chosen = rows.find((row) => row.id === wanted && row.enabled === 1) ?? rows.find((row) => row.id === "persona.whale");

  if (!chosen) {
    return { id: "persona.whale", name: "鲸鱼娘顽皮女仆", prompt: PERSONA };
  }
  if (chosen.handler === "persona.whale") {
    return { id: chosen.id, name: chosen.name, prompt: PERSONA };
  }
  return { id: chosen.id, name: chosen.name, prompt: chosen.prompt };
}

export function setActivePersona(db: Db, id: string): boolean {
  const row = db.select().from(skills).where(eq(skills.id, id)).get();
  if (!row || row.type !== "persona" || row.enabled !== 1) {
    return false;
  }
  setSetting(db, PERSONA_SETTING_KEY, id);
  return true;
}

/** 注入 system prompt 的技能说明（只列 tool/instruction）。 */
export function buildSkillsPrompt(enabled: SkillManifest[]): string {
  const usable = enabled.filter((skill) => skill.type !== "persona");
  if (!usable.length) {
    return "（无额外技能）";
  }
  return usable
    .map((skill) => {
      const params = Object.keys(skill.paramsSchema).length
        ? `，参数：${JSON.stringify(skill.paramsSchema)}`
        : "";
      return `- ${skill.id}：${skill.description}${params}`;
    })
    .join("\n");
}

/** instruction 类型技能的附加提示词。 */
export function buildInstructionPrompt(enabled: SkillManifest[]): string {
  const lines = enabled
    .filter((skill) => skill.type === "instruction" && skill.prompt.trim())
    .map((skill) => skill.prompt.trim());
  return lines.length ? `\n【附加指令】\n${lines.join("\n")}` : "";
}
