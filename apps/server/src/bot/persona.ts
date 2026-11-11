import { OUTPUT_CONTRACT, SOUL_PERSONA } from "../soul/persona.js";

/**
 * V4.4.4：默认人格改为「赛博女儿」。
 * 保留 PERSONA 这个导出名，避免 skills/registry.ts 等调用点大改。
 */
export const PERSONA = SOUL_PERSONA;

export { OUTPUT_CONTRACT };

export interface PromptContext {
  identity: string;
  capabilities: string;
  memoryFragments: string[];
  history: Array<{ role: string; text: string; senderLabel: string; replied: boolean }>;
  /** 群聊中最近的消息（含未 @ 机器人的消息），仅群聊场景提供。 */
  groupContext?: Array<{ senderLabel: string; text: string; at: string }>;
  summary: string | null;
  nowIso: string;
  /** 自定义人格（不含输出契约）；未提供时使用鲸鱼娘。 */
  personaPrompt?: string;
  skills?: string;
  instructions?: string;
  /** 当前心情 / 精力 / 人格向量。 */
  soulBlock?: string;
  /** 今天看到的东西、日记摘要、主人访问痕迹。 */
  soulNotes?: string;
}

export function buildSystemPrompt(context: PromptContext): string {
  const memory = context.memoryFragments.length
    ? context.memoryFragments.map((item) => `- ${item}`).join("\n")
    : "（暂无）";
  const history = context.history.length
    ? context.history
        .map((item) => {
          const status =
            item.role === "user" ? (item.replied ? "·已回复" : "·未回复") : "";
          return `[${item.senderLabel}${status}] ${item.text}`;
        })
        .join("\n")
    : "（暂无）";
  const groupHistory = context.groupContext?.length
    ? context.groupContext
        .map((item) => `- [${item.at.slice(11, 19)}] ${item.senderLabel}: ${item.text}`)
        .join("\n")
    : "（暂无）";

  return `${context.personaPrompt ?? PERSONA}
${context.personaPrompt ? OUTPUT_CONTRACT : ""}

【当前对话对象】${context.identity}
【当前时间】${context.nowIso}（Asia/Shanghai）
${context.soulBlock ?? ""}
${context.soulNotes ?? ""}
【能力开关】${context.capabilities}
【可用技能】
${context.skills ?? "（无额外技能）"}${context.instructions ?? ""}
【会话摘要】
${context.summary ?? "（暂无）"}
【相关记忆（含来源）】
${memory}
【近期群聊上下文（含未@你的消息）】
${groupHistory}
【最近对话】
${history}`;
}
