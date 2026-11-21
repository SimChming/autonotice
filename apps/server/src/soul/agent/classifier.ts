import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import type { LlmClient } from "../../llm/client.js";
import { getSoulSnapshot } from "../store.js";
import { eventPayload, recentEventsText } from "./store.js";
import type {
  AgentActivationRow,
  AgentEventRow,
  AgentTriggerRow,
  ClassifierDecision,
  ClassifierResult,
} from "./types.js";

export interface ClassifierDeps {
  db: Db;
  config: Config;
  /** 本地小模型：默认的注意力过滤器。 */
  classifier: LlmClient;
  /** 本地不可用时的云端兜底。 */
  fallback?: LlmClient;
  logger: FastifyBaseLogger;
}

export interface ClassifyInput {
  event: AgentEventRow;
  candidates: AgentTriggerRow[];
  active: AgentActivationRow | null;
  quiet: boolean;
}

function parseLoose<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function textOf(event: AgentEventRow): string {
  const payload = eventPayload(event);
  return String(payload.text ?? payload.note ?? payload.reason ?? "").trim();
}

function candidateText(candidates: AgentTriggerRow[]): string {
  if (!candidates.length) {
    return "（没有候选触发器）";
  }
  return candidates
    .map((row) => {
      let condition = row.condition;
      try {
        condition = JSON.stringify(JSON.parse(row.condition));
      } catch {
        // 保留原样，分类器仍能看到大意。
      }
      return `- #${row.id}「${row.name}」条件=${condition}｜提示=${row.prompt.slice(0, 80)}`;
    })
    .join("\n");
}

/** 不调用模型也能做出的判断：直接消息、明确关键词、任务相关词。 */
function heuristic(input: ClassifyInput): ClassifierResult {
  const text = textOf(input.event);
  if (input.event.addressed) {
    return {
      decision: "wake",
      triggerIds: [],
      carry: text.slice(0, 300),
      reason: "直接对她说的话",
      urgency: 100,
    };
  }

  const matched = input.candidates.filter((row) => {
    try {
      const condition = JSON.parse(row.condition) as { type?: string; keywords?: unknown };
      if (condition.type !== "keyword" || !Array.isArray(condition.keywords)) {
        return false;
      }
      return condition.keywords.some(
        (keyword) => typeof keyword === "string" && keyword.trim() && text.includes(keyword.trim()),
      );
    } catch {
      return false;
    }
  });
  if (matched.length) {
    return {
      decision: "wake",
      triggerIds: matched.map((row) => row.id),
      carry: text.slice(0, 300),
      reason: "命中了关键词触发器",
      urgency: 85,
    };
  }

  if (input.active) {
    const taskWords = input.active.task
      .split(/[\s，。！？、：；,.;!?]+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 2);
    const related = taskWords.some((word) => text.includes(word));
    if (related) {
      return {
        decision: "wake",
        triggerIds: [],
        carry: text.slice(0, 300),
        reason: "和她正在做的事有关",
        urgency: 65,
      };
    }
  }

  return {
    decision: "ignore",
    triggerIds: [],
    carry: "",
    reason: "和当前的事无关",
    urgency: 10,
  };
}

function sanitize(raw: unknown, input: ClassifyInput): ClassifierResult | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const decision = ["ignore", "wake", "interrupt", "stop"].includes(String(value.decision))
    ? (String(value.decision) as ClassifierDecision)
    : "ignore";
  const allowed = new Set(input.candidates.map((row) => row.id));
  const triggerIds = Array.isArray(value.triggerIds)
    ? value.triggerIds
        .map((item) => Number(item))
        .filter((id) => Number.isFinite(id) && allowed.has(id))
    : [];
  const urgency = Math.min(100, Math.max(0, Math.round(Number(value.urgency) || 0)));
  return {
    decision,
    triggerIds,
    carry: String(value.carry ?? "").slice(0, 800),
    reason: String(value.reason ?? "").slice(0, 300),
    urgency,
  };
}

/**
 * 注意力过滤器：环境变化先到这里，决定「忽略 / 带信息唤醒 / 打断 / 收尾」。
 * 本地小模型优先；不可用时按配置回退云端，再不行就只用启发式。
 */
export async function classifyAttention(
  deps: ClassifierDeps,
  input: ClassifyInput,
): Promise<ClassifierResult> {
  const fast = heuristic(input);
  // 直接消息和明确关键词不需要再花一次模型调用。
  if (fast.urgency >= 85) {
    return fast;
  }
  if (!deps.config.soul.classifierEnabled) {
    return fast;
  }
  if (!input.candidates.length && !input.active) {
    return fast;
  }

  const soul = getSoulSnapshot(deps.db);
  const text = textOf(input.event).slice(0, 800);
  const messages = [
    {
      role: "system" as const,
      content:
        "你是她大脑里的注意力过滤器。你不说话，只判断一条环境变化是否值得进入她的意识。只输出 json。",
    },
    {
      role: "user" as const,
      content: `【她此刻】心情 ${soul.mood}（${soul.moodIntensity}/100），精力 ${soul.energy}/100，${input.quiet ? "现在是安静时段" : "现在是清醒时段"}。
【她正在做的事】${input.active ? `#${input.active.id} ${input.active.task}（状态 ${input.active.status}，已续跑 ${input.active.continueCount} 次）` : "（现在没有在进行的工作）"}
【刚发生的环境变化】source=${input.event.source} type=${input.event.type} session=${input.event.sessionKey ?? "无"} addressed=${input.event.addressed === 1 ? "是" : "否"}
内容：${text || "（没有文字内容）"}
【候选触发器】
${candidateText(input.candidates)}
【她最近经历】
${recentEventsText(deps.db, 6)}

判断：
- ignore：与她无关，不要叫醒她；
- wake：值得她知道，但不用打断当前工作；
- interrupt：比当前工作更重要，应该停下当前工作；
- stop：当前工作可以收尾了。
只选择真正相关的候选触发器 id；carry 写一句你替她带进思考的关键信息；urgency 0-100。
输出 json：{"decision":"ignore","triggerIds":[],"carry":"","reason":"","urgency":0}`,
    },
  ];

  const local = deps.config.soul.classifierEnabled;
  try {
    if (local) {
      const raw = await deps.classifier.chatJson(messages);
      const parsed = sanitize(parseLoose<Record<string, unknown>>(raw), input);
      if (parsed) {
        return parsed;
      }
    }
  } catch (error) {
    deps.logger.debug({ err: error }, "本地分类模型不可用");
  }

  if (deps.config.soul.classifierFallbackCloud && deps.fallback) {
    try {
      const raw = await deps.fallback.chatJson(messages);
      const parsed = sanitize(parseLoose<Record<string, unknown>>(raw), input);
      if (parsed) {
        return parsed;
      }
    } catch (error) {
      deps.logger.debug({ err: error }, "云端分类兜底失败");
    }
  }

  return fast;
}
