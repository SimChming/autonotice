import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import { runOnHost } from "../../host/exec.js";
import type { LlmClient } from "../../llm/client.js";
import type { OneBotClient } from "../../onebot/client.js";
import { DRIVE_LABELS, getDrives, topDrives, type DriveName } from "../life.js";
import { addEvent, getSoulSnapshot, hourKey, patchSoulSnapshot } from "../store.js";
import { classifyAttention } from "./classifier.js";
import { groupIdOf, sendToSession } from "./channel.js";
import { executeActions, parseActions, parseTriggerSpecs, parseLoose } from "./effectors.js";
import { buildAgentPrompt } from "./prompt.js";
import {
  cancelActivation as cancelActivationRow,
  cancelOpenActivations,
  countActivationsSince,
  createActivation,
  createTrigger,
  disableTrigger,
  emitEvent,
  eventPayload,
  findOpenActivation,
  getActivation,
  lastActivationAt,
  listActivations,
  listCycles,
  listEvents,
  listOpenActivations,
  listReadyActivations,
  listTriggers,
  logCycle,
  markEventConsumed,
  markTriggerFired,
  parseCondition,
  recoverActivations,
  touchTriggerChecked,
  updateActivation,
  updateTrigger,
} from "./store.js";
import type {
  AgentActivationRow,
  AgentChatBridge,
  AgentChatHooks,
  AgentEventInput,
  AgentEventRow,
  AgentKernel,
  AgentPlan,
  AgentTriggerRow,
  AgentTriggerSpec,
  ChatRunResult,
} from "./types.js";

export interface AgentKernelDeps {
  db: Db;
  config: Config;
  llm: LlmClient;
  classifier: LlmClient;
  companion: LlmClient;
  onebot: OneBotClient;
  logger: FastifyBaseLogger;
  onAssistant?: (sessionKey: string, text: string) => void;
}

const TICK_MS = 15_000;
const MAX_PUMP_ITERATIONS = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function inQuietHour(hour: number, start: number, end: number): boolean {
  if (start === end) {
    return false;
  }
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function parsePlan(raw: string): AgentPlan {
  const value = parseLoose<Record<string, unknown>>(raw) ?? {};
  const self = (value.self ?? {}) as Record<string, unknown>;
  return {
    thought: String(value.thought ?? "").slice(0, 2000),
    actions: parseActions(value.actions),
    triggers: parseTriggerSpecs(value.triggers),
    self: {
      continue: self.continue === true,
      nextInSeconds: clamp(Number(self.nextInSeconds) || 45, 20, 300),
      task: String(self.task ?? "").slice(0, 600),
      context: String(self.context ?? "").slice(0, 2000),
    },
    done: value.done !== false,
  };
}

function triggerMatchesEvent(trigger: AgentTriggerRow, event: AgentEventRow, text: string): boolean {
  const condition = parseCondition(trigger.condition);
  if (!condition) {
    return false;
  }
  if (condition.type === "keyword") {
    if (condition.sessionKey && condition.sessionKey !== event.sessionKey) {
      return false;
    }
    return condition.keywords.some(
      (keyword) => typeof keyword === "string" && keyword.trim() && text.includes(keyword.trim()),
    );
  }
  if (condition.type === "event") {
    return (
      (!condition.source || condition.source === event.source) &&
      (!condition.eventType || condition.eventType === event.type) &&
      (!condition.sessionKey || condition.sessionKey === event.sessionKey)
    );
  }
  return false;
}

export function createAgentKernel(deps: AgentKernelDeps): AgentKernel {
  const { db, config, llm, logger } = deps;
  let bridge: AgentChatBridge | null = null;
  let interval: NodeJS.Timeout | null = null;
  let pumpTimer: NodeJS.Timeout | null = null;
  let startupTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();
  let pumping = false;
  let ticking = false;
  let lastLifePulseAt = 0;
  const runningSessions = new Set<string>();

  function sessionLabel(activation: AgentActivationRow): string {
    return activation.sessionKey ?? `free:${activation.id}`;
  }

  function schedulePump(delay = 0): void {
    if (stopped || pumpTimer) {
      return;
    }
    pumpTimer = setTimeout(() => {
      pumpTimer = null;
      void pump();
    }, delay);
  }

  function noteForActivation(activation: AgentActivationRow): string {
    const context = activation.context ? `\n你带进来的上下文：${activation.context}` : "";
    if (activation.kind === "self") {
      return `【自激续跑·第 ${activation.continueCount + 1} 次】这是你自己决定接着做/接着说，不是用户发来的新消息。
你之前挂着的事：${activation.task}${context}
现在是大约 ${Math.max(1, Math.round((Date.now() - activation.updatedAt) / 1000))} 秒后。接着往下走，不要重新开始。`;
    }
    if (activation.kind === "condition") {
      return `【条件触发】${activation.task}${context}
这个条件刚刚满足了。你可以回应、继续手头的事，或者判断现在不需要做任何事。`;
    }
    return `【环境变化】${activation.task}${context}`;
  }

  async function runChatActivation(activation: AgentActivationRow): Promise<void> {
    if (!bridge) {
      updateActivation(db, activation.id, {
        status: "failed",
        finishedAt: Date.now(),
        lastError: "对话通道还没接上",
      });
      return;
    }
    const sessionKey = activation.sessionKey;
    if (!sessionKey) {
      updateActivation(db, activation.id, {
        status: "failed",
        finishedAt: Date.now(),
        lastError: "chat 激活缺少 sessionKey",
      });
      return;
    }
    const send = async (text: string) => {
      await sendToSession(
        {
          db,
          onebot: deps.onebot,
          logger,
          onAssistant: deps.onAssistant,
        },
        sessionKey,
        text,
      );
    };
    // BotChat 在回合结束时会回调 hooks.endTurn，这里不再重复处理结果。
    await bridge.resume({
      sessionKey,
      groupId: groupIdOf(sessionKey),
      note: noteForActivation(activation),
      send,
      activationId: activation.id,
    });
    // 兜底：如果对话层因为异常没有回调 endTurn，别让这条激活永远占着会话。
    const after = getActivation(db, activation.id);
    if (after && after.status === "active") {
      updateActivation(db, activation.id, {
        status: "done",
        finishedAt: Date.now(),
        lastError: "对话回合结束但未收到回调",
      });
    }
  }

  async function runFreeActivation(activation: AgentActivationRow): Promise<void> {
    if (countActivationsSince(db, Date.now() - 3_600_000, ["condition", "event", "tick"]) >=
      config.soul.freeMaxPerHour) {
      updateActivation(db, activation.id, {
        status: "done",
        finishedAt: Date.now(),
        lastError: "这一小时自由活动太多，先歇着",
      });
      return;
    }

    const messages = buildAgentPrompt(db, {
      activation,
      carry: activation.context,
      triggerNote: activation.task,
    });
    const raw = await llm.chatJson(messages);
    const plan = parsePlan(raw);

    const outcomes = await executeActions(
      {
        db,
        config,
        llm,
        companion: deps.companion,
        onebot: deps.onebot,
        logger,
        onAssistant: deps.onAssistant,
      },
      activation,
      plan.actions,
    );

    for (const spec of plan.triggers) {
      createTrigger(db, {
        ...spec,
        sessionKey: spec.sessionKey ?? activation.sessionKey,
      });
    }

    const resultText = outcomes.map((item) => `${item.ok ? "✓" : "✗"} ${item.text}`).join("\n");
    logCycle(db, {
      activationId: activation.id,
      eventId: activation.eventId,
      thought: plan.thought,
      actions: plan.actions,
      result: resultText,
    });

    if (plan.thought) {
      addEvent(db, "agent", plan.thought.slice(0, 600));
    }

    if (plan.self.continue && !plan.done && activation.continueCount + 1 < activation.maxContinues) {
      const nextRunAt = Date.now() + plan.self.nextInSeconds * 1000;
      const leaseUntil = activation.leaseUntil ?? Date.now() + config.soul.selfMaxLeaseHours * 3_600_000;
      if (Date.now() < leaseUntil) {
        updateActivation(db, activation.id, {
          status: "sleeping",
          task: plan.self.task || activation.task,
          context: plan.self.context || activation.context,
          nextRunAt,
          leaseUntil,
          continueCount: activation.continueCount + 1,
          finishedAt: null,
          lastError: "",
        });
        addEvent(
          db,
          "self",
          `决定 ${plan.self.nextInSeconds} 秒后继续：${(plan.self.task || activation.task).slice(0, 120)}`,
        );
        return;
      }
    }

    updateActivation(db, activation.id, {
      status: "done",
      finishedAt: Date.now(),
      lastError: "",
    });
  }

  async function runActivation(activation: AgentActivationRow): Promise<void> {
    const fresh = getActivation(db, activation.id);
    if (!fresh || !["active", "sleeping"].includes(fresh.status)) {
      return;
    }
    if (fresh.leaseUntil && Date.now() > fresh.leaseUntil) {
      updateActivation(db, fresh.id, {
        status: "done",
        finishedAt: Date.now(),
        lastError: "自激租约到期",
      });
      return;
    }

    if (fresh.mode === "chat" && fresh.sessionKey && bridge?.isRunning(fresh.sessionKey)) {
      // 对话层正在说话，等她说完再续跑，避免两轮回复交叉。
      updateActivation(db, fresh.id, { status: "sleeping", nextRunAt: Date.now() + 5_000 });
      return;
    }

    const key = sessionLabel(fresh);
    if (runningSessions.has(key)) {
      return;
    }
    runningSessions.add(key);
    try {
      if (fresh.mode === "chat") {
        await runChatActivation(fresh);
      } else {
        await runFreeActivation(fresh);
      }
      patchSoulSnapshot(db, { lastWakeAt: Date.now() });
    } catch (error) {
      logger.warn({ err: error, activationId: fresh.id }, "这次意识活动失败");
      updateActivation(db, fresh.id, {
        status: "failed",
        finishedAt: Date.now(),
        lastError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    } finally {
      runningSessions.delete(key);
    }
  }

  async function pump(): Promise<void> {
    if (stopped || pumping) {
      return;
    }
    pumping = true;
    const attempted = new Set<number>();
    try {
      for (let index = 0; index < MAX_PUMP_ITERATIONS; index += 1) {
        const ready = listReadyActivations(db).filter(
          (row) => row.kind !== "user" && !attempted.has(row.id),
        );
        const next = ready.find((row) => !runningSessions.has(sessionLabel(row)));
        if (!next) {
          break;
        }
        attempted.add(next.id);
        await runActivation(next);
      }
    } finally {
      pumping = false;
    }
    if (
      listReadyActivations(db).some((row) => row.kind !== "user" && !attempted.has(row.id))
    ) {
      schedulePump(800);
    }
  }

  function scheduleSelf(input: {
    sessionKey: string;
    activationId?: number;
    task: string;
    context?: string;
    nextInSeconds: number;
  }): void {
    const existing = input.activationId ? getActivation(db, input.activationId) : null;
    if (existing && existing.status === "cancelled") {
      return;
    }
    const continueCount = (existing?.continueCount ?? 0) + 1;
    const maxContinues = config.soul.selfMaxContinues;
    if (continueCount > maxContinues) {
      if (existing) {
        updateActivation(db, existing.id, {
          status: "done",
          finishedAt: Date.now(),
          lastError: "自激续跑到达上限",
        });
      }
      return;
    }
    const now = Date.now();
    const leaseUntil = existing?.leaseUntil ?? now + config.soul.selfMaxLeaseHours * 3_600_000;
    if (now > leaseUntil) {
      if (existing) {
        updateActivation(db, existing.id, {
          status: "done",
          finishedAt: Date.now(),
          lastError: "自激租约到期",
        });
      }
      return;
    }
    const nextRunAt = now + clamp(input.nextInSeconds, 20, 300) * 1000;
    if (existing) {
      updateActivation(db, existing.id, {
        status: "sleeping",
        task: input.task,
        context: input.context ?? existing.context,
        nextRunAt,
        leaseUntil,
        continueCount,
        finishedAt: null,
        lastError: "",
      });
    } else {
      createActivation(db, {
        sessionKey: input.sessionKey,
        mode: "chat",
        kind: "self",
        task: input.task,
        context: input.context ?? "",
        nextRunAt,
        leaseUntil,
        maxContinues,
      });
    }
    addEvent(db, "self", `决定 ${input.nextInSeconds} 秒后接着说：${input.task.slice(0, 120)}`);
    schedulePump();
  }

  function applyTurnResult(result: ChatRunResult, internal: boolean): void {
    const sessionKey = result.sessionKey;
    const activation = result.activationId ? getActivation(db, result.activationId) : null;

    for (const spec of parseTriggerSpecs(result.triggers ?? [])) {
      createTrigger(db, {
        ...spec,
        sessionKey: spec.sessionKey ?? sessionKey ?? null,
      });
    }

    logCycle(db, {
      activationId: result.activationId ?? null,
      thought: result.thought ?? "",
      actions: [],
      result: `chat: sent=${result.sent}${result.pending ? `，决定 ${result.pending.nextInSeconds} 秒后继续` : ""}`,
    });

    if (result.pending && !result.preempted && sessionKey && activation?.status !== "cancelled") {
      scheduleSelf({
        sessionKey,
        activationId: internal ? activation?.id : undefined,
        task: result.pending.task || activation?.task || "接着刚才的话说",
        context: result.pending.context,
        nextInSeconds: result.pending.nextInSeconds,
      });
      if (activation && !internal) {
        updateActivation(db, activation.id, {
          status: "done",
          finishedAt: Date.now(),
          lastError: "",
        });
      }
      return;
    }

    if (activation) {
      updateActivation(db, activation.id, {
        status: activation.status === "cancelled" ? "cancelled" : "done",
        finishedAt: Date.now(),
        lastError: activation.status === "cancelled" ? activation.lastError : "",
      });
    }
  }

  async function fireTrigger(
    trigger: AgentTriggerRow,
    event?: AgentEventRow | null,
    carry = "",
  ): Promise<void> {
    const now = Date.now();
    if (!trigger.enabled) {
      return;
    }
    if (trigger.expiresAt && now > trigger.expiresAt) {
      disableTrigger(db, trigger.id);
      return;
    }
    if (trigger.lastFiredAt && now - trigger.lastFiredAt < trigger.cooldownMs) {
      return;
    }
    // 同一个触发器已经有一个没结束的激活，就不要再叠一层。
    if (
      listOpenActivations(db).some(
        (row) => row.triggerId === trigger.id && ["active", "sleeping"].includes(row.status),
      )
    ) {
      return;
    }

    const condition = parseCondition(trigger.condition);
    const sessionKey = trigger.sessionKey ?? event?.sessionKey ?? null;
    const task = trigger.prompt || `「${trigger.name}」的条件满足了，你想一下要做什么。`;
    const context = [
      carry,
      condition ? `条件：${JSON.stringify(condition)}` : "",
      event ? `触发事件：${event.source}/${event.type}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const activation = createActivation(db, {
      sessionKey,
      mode: sessionKey ? "chat" : "free",
      kind: "condition",
      triggerId: trigger.id,
      eventId: event?.id ?? null,
      task,
      context,
      nextRunAt: now,
      maxContinues: config.soul.selfMaxContinues,
    });
    markTriggerFired(db, trigger);
    if (condition?.type === "time" && !condition.repeatSeconds) {
      disableTrigger(db, trigger.id);
    }
    addEvent(db, "trigger", `条件触发器「${trigger.name}」叫醒了她。`);
    logCycle(db, {
      activationId: activation.id,
      eventId: event?.id ?? null,
      classifier: { decision: "wake", triggerId: trigger.id, reason: trigger.name },
      thought: "",
      actions: [],
      result: "条件触发器激活",
    });
    schedulePump();
  }

  async function evaluateConditions(): Promise<void> {
    const triggers = listTriggers(db, true).filter((row) => {
      const condition = parseCondition(row.condition);
      return condition && ["time", "drive", "idle", "shell"].includes(condition.type);
    });
    const now = Date.now();
    for (const trigger of triggers) {
      const condition = parseCondition(trigger.condition);
      if (!condition) {
        continue;
      }
      if (trigger.expiresAt && now > trigger.expiresAt) {
        disableTrigger(db, trigger.id);
        continue;
      }
      if (trigger.lastFiredAt && now - trigger.lastFiredAt < trigger.cooldownMs) {
        continue;
      }

      if (condition.type === "time") {
        const dueAt = condition.at ?? trigger.createdAt + (condition.afterSeconds ?? 0) * 1000;
        if (now < dueAt) {
          continue;
        }
        await fireTrigger(trigger);
        if (condition.repeatSeconds) {
          updateTrigger(db, trigger.id, {
            condition: JSON.stringify({ ...condition, at: now + condition.repeatSeconds * 1000 }),
            enabled: 1,
          });
        }
        continue;
      }

      if (condition.type === "drive") {
        const drives = getDrives(db);
        const level = drives[condition.name as DriveName] ?? 0;
        if (level >= condition.gte) {
          await fireTrigger(trigger);
        }
        continue;
      }

      if (condition.type === "idle") {
        const last =
          lastActivationAt(db, condition.sessionKey) ??
          getSoulSnapshot(db).lastWakeAt ??
          trigger.createdAt;
        if (now - last >= condition.minutes * 60_000) {
          await fireTrigger(trigger);
        }
        continue;
      }

      if (condition.type === "shell") {
        const interval = Math.max(15, condition.intervalSeconds ?? 60) * 1000;
        if (trigger.lastCheckedAt && now - trigger.lastCheckedAt < interval) {
          continue;
        }
        const result = await runOnHost(condition.command);
        touchTriggerChecked(db, trigger.id);
        let hit = false;
        if (condition.expectContains) {
          hit = result.output.includes(condition.expectContains);
        } else if (condition.expectRegex) {
          try {
            hit = new RegExp(condition.expectRegex).test(result.output);
          } catch {
            hit = false;
          }
        } else {
          hit = result.ok;
        }
        if (hit) {
          await fireTrigger(trigger, null, result.output.slice(0, 800));
        }
      }
    }
  }

  function lifePulse(): void {
    const now = Date.now();
    if (now - lastLifePulseAt < 10 * 60_000) {
      return;
    }
    lastLifePulseAt = now;
    if (listOpenActivations(db).some((row) => row.kind !== "user")) {
      return;
    }
    if (
      countActivationsSince(db, now - 3_600_000, ["condition", "event", "tick"]) >=
      config.soul.freeMaxPerHour
    ) {
      return;
    }
    const soul = getSoulSnapshot(db);
    const quiet = inQuietHour(hourKey(), config.soul.quietStart, config.soul.quietEnd);
    const top = topDrives(db, 1)[0];
    if (!top || quiet || soul.energy < 20) {
      return;
    }
    const bored = top.level < 22;
    if (!bored && top.level < 65) {
      return;
    }
    if (bored && Math.random() > 0.35) {
      return;
    }
    const task = bored
      ? "你有点无聊，没什么事发生。想决定要不要做点什么。"
      : `你醒着，没有人叫你。最渴的是「${DRIVE_LABELS[top.name]}」（${top.level}/100）。想决定接下来做什么。`;
    createActivation(db, {
      sessionKey: null,
      mode: "free",
      kind: "tick",
      task,
      context: `精力 ${soul.energy}/100，心情 ${soul.mood}`,
      nextRunAt: now,
      maxContinues: config.soul.selfMaxContinues,
    });
    schedulePump();
  }

  async function routeEvent(event: AgentEventRow): Promise<void> {
    if (event.type === "tick") {
      lifePulse();
      return;
    }
    if (event.addressed || event.type === "private_message" || event.type === "admin_message") {
      markEventConsumed(db, event.id);
      return;
    }
    if (event.source !== "qq" && event.source !== "admin") {
      return;
    }

    const payload = eventPayload(event);
    const text = String(payload.text ?? payload.note ?? "").trim();
    const candidates = listTriggers(db, true).filter((trigger) => triggerMatchesEvent(trigger, event, text));
    const open = event.sessionKey ? findOpenActivation(db, event.sessionKey) : null;
    // 用户回合由 BotChat 自己负责，不被群里的环境声改状态。
    const active = open && open.kind !== "user" ? open : null;
    if (!candidates.length && !active) {
      return;
    }

    const soul = getSoulSnapshot(db);
    const quiet = inQuietHour(hourKey(), config.soul.quietStart, config.soul.quietEnd);
    const classified = await classifyAttention(
      {
        db,
        config,
        classifier: deps.classifier,
        fallback: llm,
        logger,
      },
      { event, candidates, active, quiet },
    );
    logCycle(db, {
      activationId: active?.id ?? null,
      eventId: event.id,
      classifier: classified,
      thought: "",
      actions: [],
      result: "注意力分类",
    });

    if (classified.decision === "ignore") {
      return;
    }
    if (classified.decision === "stop") {
      if (active && active.sessionKey) {
        cancelOpenActivations(db, active.sessionKey, "分类器判断当前工作可以收尾");
      }
      markEventConsumed(db, event.id);
      return;
    }

    if (active) {
      const extra = [classified.carry, `环境更新：${text.slice(0, 200)}`].filter(Boolean).join("\n");
      updateActivation(db, active.id, {
        status: "sleeping",
        nextRunAt: Date.now(),
        context: [active.context, extra].filter(Boolean).join("\n").slice(-4000),
      });
      schedulePump();
      markEventConsumed(db, event.id);
      return;
    }

    const selected = candidates.filter((trigger) => classified.triggerIds.includes(trigger.id));
    if (selected.length) {
      for (const trigger of selected.slice(0, 2)) {
        await fireTrigger(trigger, event, classified.carry);
      }
      markEventConsumed(db, event.id);
      return;
    }

    if (classified.urgency >= config.soul.ambientWakeThreshold) {
      createActivation(db, {
        sessionKey: event.sessionKey,
        mode: event.sessionKey ? "chat" : "free",
        kind: "event",
        eventId: event.id,
        task: classified.carry || `群里刚才在说：${text.slice(0, 200)}`,
        context: classified.reason,
        nextRunAt: Date.now(),
        maxContinues: config.soul.selfMaxContinues,
      });
      markEventConsumed(db, event.id);
      schedulePump();
    }
  }

  const hooks: AgentChatHooks = {
    noteUserMessage(input) {
      try {
        // 直接消息也留一条环境事件，后台能看到她是怎么被叫醒的。
        emitEvent(db, {
          source: "qq",
          type: input.groupId ? "group_message" : "private_message",
          sessionKey: input.sessionKey,
          addressed: true,
          payload: { text: input.text, senderQq: input.senderQq },
          importance: 100,
        });
        cancelOpenActivations(db, input.sessionKey, "用户插话，切换任务");
      } catch (error) {
        logger.debug({ err: error }, "记录用户消息失败");
      }
    },

    beginUserTurn(input) {
      try {
        cancelOpenActivations(db, input.sessionKey, "用户插话，切换任务");
        const activation = createActivation(db, {
          sessionKey: input.sessionKey,
          mode: "chat",
          kind: "user",
          task: input.text.slice(0, 600),
          context: `来自 QQ${input.senderQq}`,
          nextRunAt: Date.now(),
          maxContinues: config.soul.selfMaxContinues,
        });
        return activation.id;
      } catch (error) {
        logger.debug({ err: error }, "记录用户回合失败");
        return undefined;
      }
    },

    endTurn(result, internal) {
      try {
        applyTurnResult(result, internal);
      } catch (error) {
        logger.warn({ err: error }, "处理对话回合结束失败");
      }
    },
  };

  return {
    hooks,
    attachChat(next) {
      bridge = next;
    },
    emit(input: AgentEventInput) {
      // 同步落库，异步路由；事件之间串行，避免同一句话被两个触发器同时消费。
      let event: AgentEventRow;
      try {
        event = emitEvent(db, input);
      } catch (error) {
        logger.warn({ err: error }, "写入环境事件失败");
        return;
      }
      chain = chain
        .then(() => routeEvent(event))
        .catch((error: unknown) => {
          logger.warn({ err: error, eventId: event.id }, "环境事件处理失败");
        })
        .then(() => {
          schedulePump(0);
        });
    },
    addTrigger(spec: AgentTriggerSpec) {
      return createTrigger(db, spec);
    },
    wake(prompt?: string, sessionKey?: string | null) {
      createActivation(db, {
        sessionKey: sessionKey ?? null,
        mode: sessionKey ? "chat" : "free",
        kind: "event",
        task: prompt?.trim() || "主人叫你看看现在的环境，想一下要做什么。",
        nextRunAt: Date.now(),
        maxContinues: config.soul.selfMaxContinues,
      });
      schedulePump();
    },
    cancelActivation(id: number) {
      cancelActivationRow(db, id, "主人手动取消");
    },
    start() {
      stopped = false;
      recoverActivations(db);
      interval = setInterval(() => {
        if (ticking) {
          return;
        }
        if (!config.soul.agentLoop) {
          schedulePump(0);
          return;
        }
        ticking = true;
        void evaluateConditions()
          .catch((error: unknown) => logger.warn({ err: error }, "条件触发器扫描失败"))
          .finally(() => {
            ticking = false;
            schedulePump(0);
          });
      }, TICK_MS);
      startupTimer = setTimeout(() => {
        if (stopped) {
          return;
        }
        void evaluateConditions()
          .catch((error: unknown) => logger.warn({ err: error }, "启动时扫描条件触发器失败"))
          .finally(() => schedulePump(0));
      }, 5_000);
      logger.info("仿人闭环内核已启动（环境 → 触发器/分类器 → 思考 → 效应器）");
    },
    stop() {
      stopped = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (pumpTimer) {
        clearTimeout(pumpTimer);
        pumpTimer = null;
      }
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
    },
    isRunning(sessionKey?: string) {
      if (!sessionKey) {
        return pumping || runningSessions.size > 0;
      }
      return runningSessions.has(sessionKey);
    },
    snapshot() {
      return {
        activations: listActivations(db, 30),
        triggers: listTriggers(db),
        cycles: listCycles(db, 30),
        events: listEvents(db, { limit: 30 }),
      };
    },
  };
}
