import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../db/client.js";
import { getSoulSnapshot } from "../store.js";
import { eventPayload, recentEventsText } from "./store.js";
import type {
  AgentActivationRow,
  AgentEventRow,
  AgentTriggerRow,
  ClassifierDecision,
  ClassifierResult,
} from "./types.js";

/**
 * Jev 风格的「决策模型」客户端。
 *
 * Jev 本身是闭源托管 API；开源复刻（Laya / Julia-1 / Kev 等）在 llama.cpp 里
 * 通过 /v1/systemone 暴露。它们不生成自然语言，只做一次前向：
 *   choice → 从选项里选；score → 在有序档位上打分；noul → 是/否概率。
 *
 * 这里只用「一次 choice + 候选触发器的 noul」，输出 token 恒为 0。
 * 实测 Laya multilingual（322M）在 P100 上单次约 20-50ms。
 */

export interface DecisionThresholds {
  /** respond+interrupt 的概率和达到这里，就值得进入她的意识。 */
  wake: number;
  /** 有正在进行的工作时，interrupt 达到这里才打断。 */
  interrupt: number;
  /** 命中候选触发器的概率阈值。 */
  trigger: number;
}

export interface DecisionClassifier {
  decide(input: {
    event: AgentEventRow;
    candidates: AgentTriggerRow[];
    active: AgentActivationRow | null;
    quiet: boolean;
  }): Promise<ClassifierResult | null>;
}

export interface DecisionClassifierDeps {
  db: Db;
  baseUrl: string;
  model?: string;
  timeoutMs?: number;
  thresholds?: Partial<DecisionThresholds>;
  logger: FastifyBaseLogger;
}

interface SystemOneAnswer {
  type?: string;
  choice?: string;
  noul?: number;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function textOf(event: AgentEventRow): string {
  const payload = eventPayload(event);
  return String(payload.text ?? payload.note ?? payload.reason ?? "").trim();
}

function conditionText(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return raw;
  }
}

function activeText(active: AgentActivationRow | null): string {
  return active
    ? `她正在做：#${active.id}「${active.task}」（状态 ${active.status}，已续跑 ${active.continueCount} 次）。`
    : "她现在没有明确的工作。";
}

function buildState(
  db: Db,
  input: {
    event: AgentEventRow;
    active: AgentActivationRow | null;
    quiet: boolean;
  },
): string {
  const soul = getSoulSnapshot(db);
  const text = textOf(input.event).slice(0, 1200);
  return `她此刻：心情 ${soul.mood}（${soul.moodIntensity}/100），精力 ${soul.energy}/100，${
    input.quiet ? "安静时段" : "清醒时段"
  }。
${activeText(input.active)}
刚发生的环境变化：来源 ${input.event.source}，类型 ${input.event.type}，会话 ${
    input.event.sessionKey ?? "无"
  }，${input.event.addressed ? "直接对她说话" : "不是直接对她说话"}。
内容：${text || "（没有文字内容）"}
她最近经历：
${recentEventsText(db, 6)}`;
}

function validDecision(value: unknown): value is ClassifierDecision {
  return value === "ignore" || value === "wake" || value === "interrupt" || value === "stop";
}

function urgencyOf(decision: ClassifierDecision, action: string | undefined): number {
  if (decision === "interrupt") {
    return 92;
  }
  if (decision === "wake") {
    return action === "respond" ? 76 : 65;
  }
  return 10;
}

/**
 * 用 decision model 做一次「注意力过滤」。
 * 返回 null 表示端点不可用/超时，调用方退回聊天模型或启发式。
 */
export function createDecisionClassifier(deps: DecisionClassifierDeps): DecisionClassifier {
  const baseUrl = deps.baseUrl.replace(/\/+$/, "");
  const timeoutMs = deps.timeoutMs ?? 2500;
  const thresholds: DecisionThresholds = {
    wake: deps.thresholds?.wake ?? 0.45,
    interrupt: deps.thresholds?.interrupt ?? 0.6,
    trigger: deps.thresholds?.trigger ?? 0.6,
  };

  async function ask(
    state: string,
    questions: Record<string, unknown>,
  ): Promise<Record<string, SystemOneAnswer> | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(deps.model ? { model: deps.model } : {}),
          state,
          questions,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        deps.logger.debug(
          { status: response.status, body: (await response.text()).slice(0, 300) },
          "决策模型返回错误",
        );
        return null;
      }
      const payload = (await response.json()) as { answers?: Record<string, SystemOneAnswer> };
      return payload.answers ?? null;
    } catch (error) {
      deps.logger.debug({ err: error }, "决策模型不可用");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async decide(input) {
      if (!baseUrl) {
        return null;
      }
      const text = textOf(input.event).slice(0, 800);
      const candidates = input.candidates.slice(0, 5);

      // 触发器只在「刚发生的这条环境变化」上判断，避免被她自己的任务和最近的经历干扰。
      const triggerAnswers =
        candidates.length && text
          ? await ask(
              `刚发生的环境变化：${text}`,
              Object.fromEntries(
                candidates.map((trigger) => [
                  `trigger_${trigger.id}`,
                  {
                    type: "noul",
                    instructions: `这条环境变化命中触发器「${trigger.name}」吗？它关注：${
                      trigger.prompt || conditionText(trigger.condition)
                    }`,
                  },
                ]),
              ),
            )
          : null;

      const answers = await ask(buildState(deps.db, input), {
        action: {
          type: "choice",
          instructions: "面对这条环境变化，她下一步应该怎么做？",
          criteria: {
            ignore: "ignore: 与她无关，不需要进入她的意识",
            note: "note: 值得她知道，但不需要回应，先记下",
            respond: "respond: 需要她回应或采取行动",
            interrupt: "interrupt: 很紧急，应打断她当前的工作",
          },
        },
      });
      const action = answers?.action;
      if (!answers || !action) {
        return null;
      }

      const probs = action.probabilities ?? {};
      const pIgnore = clamp(Number(probs.ignore ?? 0), 0, 1);
      const pNote = clamp(Number(probs.note ?? 0), 0, 1);
      const pRespond = clamp(Number(probs.respond ?? 0), 0, 1);
      const pInterrupt = clamp(Number(probs.interrupt ?? 0), 0, 1);
      const act = String(action.choice ?? "");
      const triggerIds = candidates
        .filter((row) => Number(triggerAnswers?.[`trigger_${row.id}`]?.noul ?? 0) >= thresholds.trigger)
        .map((row) => row.id);

      const engaged = pRespond + pInterrupt;
      let decision: ClassifierDecision = "ignore";
      if (input.active && pInterrupt >= thresholds.interrupt && pInterrupt >= pRespond) {
        decision = "interrupt";
      } else if (
        engaged >= thresholds.wake ||
        triggerIds.length ||
        (pNote >= 0.6 && pIgnore < 0.5)
      ) {
        decision = "wake";
      }

      return {
        decision,
        triggerIds,
        carry: text,
        reason: `decision-model act=${act || "?"} p=[i${pIgnore.toFixed(2)} n${pNote.toFixed(
          2,
        )} r${pRespond.toFixed(2)} x${pInterrupt.toFixed(2)}]`,
        urgency: urgencyOf(decision, act),
      };
    },
  };
}

export { validDecision };
