import type { FastifyBaseLogger } from "fastify";
import { OWNER_QQ, type SkillManifest } from "@autonotice/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { OneBotClient } from "../onebot/client.js";
import { fetchBinary } from "../pipeline/fetcher.js";
import { getActivePersona, setActivePersona } from "./registry.js";

export interface SkillContext {
  db: Db;
  config: Config;
  onebot: OneBotClient;
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

    default:
      return `未知技能处理器 ${handler}`;
  }
}
