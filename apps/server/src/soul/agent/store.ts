import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { agentActivations, agentCycles, agentEvents, agentTriggers } from "../../db/schema.js";
import type {
  AgentActivationRow,
  AgentCondition,
  AgentCycleRow,
  AgentEventInput,
  AgentEventRow,
  AgentTriggerRow,
  AgentTriggerSpec,
} from "./types.js";

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function parseCondition(raw: string): AgentCondition | null {
  const value = parseJson<AgentCondition | null>(raw, null);
  if (!value || typeof value !== "object" || typeof value.type !== "string") {
    return null;
  }
  return value;
}

/* ------------------------------------------------------------------ 事件 */

export function emitEvent(db: Db, input: AgentEventInput): AgentEventRow {
  return db
    .insert(agentEvents)
    .values({
      source: input.source,
      type: input.type,
      sessionKey: input.sessionKey ?? null,
      addressed: input.addressed ? 1 : 0,
      payload: JSON.stringify(input.payload ?? {}),
      importance: input.importance ?? 50,
      createdAt: Date.now(),
    })
    .returning()
    .get();
}

export function markEventConsumed(db: Db, id: number): void {
  db.update(agentEvents).set({ consumedAt: Date.now() }).where(eq(agentEvents.id, id)).run();
}

export function listEvents(
  db: Db,
  options: { limit?: number; sessionKey?: string; since?: number } = {},
): AgentEventRow[] {
  const limit = Math.min(options.limit ?? 30, 200);
  let rows = db.select().from(agentEvents).orderBy(desc(agentEvents.id)).limit(limit * 2).all();
  if (options.sessionKey) {
    rows = rows.filter((row) => row.sessionKey === options.sessionKey);
  }
  if (options.since) {
    rows = rows.filter((row) => row.createdAt >= options.since!);
  }
  return rows.slice(0, limit);
}

export function recentEventsText(db: Db, limit = 8): string {
  const rows = listEvents(db, { limit });
  if (!rows.length) {
    return "（环境里还没有新动静）";
  }
  return rows
    .slice()
    .reverse()
    .map((row) => {
      const payload = parseJson<Record<string, unknown>>(row.payload, {});
      const text = String(payload.text ?? payload.note ?? payload.reason ?? "").slice(0, 160);
      const where = row.sessionKey ? ` @${row.sessionKey}` : "";
      return `- [${row.source}/${row.type}${where}] ${text}`;
    })
    .join("\n");
}

/* ---------------------------------------------------------------- 触发器 */

export function listTriggers(db: Db, enabledOnly = false): AgentTriggerRow[] {
  const rows = enabledOnly
    ? db.select().from(agentTriggers).where(eq(agentTriggers.enabled, 1)).all()
    : db.select().from(agentTriggers).all();
  return rows.sort((a, b) => b.priority - a.priority || b.id - a.id);
}

export function getTrigger(db: Db, id: number): AgentTriggerRow | null {
  return db.select().from(agentTriggers).where(eq(agentTriggers.id, id)).get() ?? null;
}

export function createTrigger(db: Db, spec: AgentTriggerSpec, kind = "condition"): AgentTriggerRow {
  const now = Date.now();
  return db
    .insert(agentTriggers)
    .values({
      name: spec.name.slice(0, 120) || "未命名触发器",
      kind,
      sessionKey: spec.sessionKey ?? null,
      condition: JSON.stringify(spec.condition),
      prompt: (spec.prompt ?? "").slice(0, 1200),
      enabled: 1,
      oneShot: spec.oneShot ? 1 : 0,
      cooldownMs: Math.max(10_000, spec.cooldownMs ?? 300_000),
      priority: Math.min(100, Math.max(1, spec.priority ?? 50)),
      expiresAt: null,
      lastCheckedAt: null,
      lastFiredAt: null,
      fireCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function updateTrigger(
  db: Db,
  id: number,
  patch: Partial<{
    name: string;
    sessionKey: string | null;
    condition: string;
    prompt: string;
    enabled: number;
    oneShot: number;
    cooldownMs: number;
    priority: number;
    expiresAt: number | null;
    lastCheckedAt: number | null;
    lastFiredAt: number | null;
    fireCount: number;
  }>,
): void {
  db.update(agentTriggers)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(agentTriggers.id, id))
    .run();
}

export function disableTrigger(db: Db, id: number): void {
  updateTrigger(db, id, { enabled: 0 });
}

export function removeTrigger(db: Db, id: number): void {
  db.delete(agentTriggers).where(eq(agentTriggers.id, id)).run();
}

export function markTriggerFired(db: Db, trigger: AgentTriggerRow): void {
  updateTrigger(db, trigger.id, {
    lastFiredAt: Date.now(),
    lastCheckedAt: Date.now(),
    fireCount: trigger.fireCount + 1,
    enabled: trigger.oneShot ? 0 : trigger.enabled,
  });
}

export function touchTriggerChecked(db: Db, id: number): void {
  updateTrigger(db, id, { lastCheckedAt: Date.now() });
}

/* ---------------------------------------------------------------- 激活 */

export interface CreateActivationInput {
  sessionKey?: string | null;
  mode: "chat" | "free";
  kind: "user" | "self" | "condition" | "event" | "tick";
  triggerId?: number | null;
  eventId?: number | null;
  task?: string;
  context?: string;
  nextRunAt?: number | null;
  leaseUntil?: number | null;
  maxContinues?: number;
}

export function createActivation(db: Db, input: CreateActivationInput): AgentActivationRow {
  const now = Date.now();
  return db
    .insert(agentActivations)
    .values({
      sessionKey: input.sessionKey ?? null,
      mode: input.mode,
      kind: input.kind,
      triggerId: input.triggerId ?? null,
      eventId: input.eventId ?? null,
      status: input.nextRunAt && input.nextRunAt > now ? "sleeping" : "active",
      task: (input.task ?? "").slice(0, 1200),
      context: (input.context ?? "").slice(0, 6000),
      nextRunAt: input.nextRunAt ?? null,
      leaseUntil: input.leaseUntil ?? null,
      continueCount: 0,
      maxContinues: input.maxContinues ?? 40,
      startedAt: now,
      updatedAt: now,
      lastError: "",
    })
    .returning()
    .get();
}

export function getActivation(db: Db, id: number): AgentActivationRow | null {
  return db.select().from(agentActivations).where(eq(agentActivations.id, id)).get() ?? null;
}

export function updateActivation(
  db: Db,
  id: number,
  patch: Partial<{
    status: string;
    task: string;
    context: string;
    nextRunAt: number | null;
    leaseUntil: number | null;
    continueCount: number;
    finishedAt: number | null;
    lastError: string;
  }>,
): void {
  db.update(agentActivations)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(agentActivations.id, id))
    .run();
}

export function findOpenActivation(db: Db, sessionKey: string): AgentActivationRow | null {
  return (
    db
      .select()
      .from(agentActivations)
      .where(
        and(
          eq(agentActivations.sessionKey, sessionKey),
          inArray(agentActivations.status, ["active", "sleeping"]),
        ),
      )
      .orderBy(desc(agentActivations.id))
      .get() ?? null
  );
}

export function listOpenActivations(db: Db): AgentActivationRow[] {
  return db
    .select()
    .from(agentActivations)
    .where(inArray(agentActivations.status, ["active", "sleeping"]))
    .orderBy(desc(agentActivations.id))
    .all();
}

export function listReadyActivations(db: Db, now = Date.now()): AgentActivationRow[] {
  return db
    .select()
    .from(agentActivations)
    .where(
      and(
        inArray(agentActivations.status, ["active", "sleeping"]),
        or(isNull(agentActivations.nextRunAt), lte(agentActivations.nextRunAt, now)),
        or(isNull(agentActivations.leaseUntil), gte(agentActivations.leaseUntil, now)),
      ),
    )
    .orderBy(desc(agentActivations.id))
    .all();
}

export function cancelOpenActivations(db: Db, sessionKey: string, reason: string): number {
  const rows = db
    .select()
    .from(agentActivations)
    .where(
      and(
        eq(agentActivations.sessionKey, sessionKey),
        inArray(agentActivations.status, ["active", "sleeping"]),
      ),
    )
    .all();
  for (const row of rows) {
    updateActivation(db, row.id, {
      status: "cancelled",
      finishedAt: Date.now(),
      lastError: reason.slice(0, 300),
    });
  }
  return rows.length;
}

export function cancelActivation(db: Db, id: number, reason: string): void {
  updateActivation(db, id, {
    status: "cancelled",
    finishedAt: Date.now(),
    lastError: reason.slice(0, 300),
  });
}

export function listActivations(db: Db, limit = 20): AgentActivationRow[] {
  return db
    .select()
    .from(agentActivations)
    .orderBy(desc(agentActivations.id))
    .limit(Math.min(limit, 200))
    .all();
}

/** 最近一次激活的时间；用于 idle 条件。 */
export function lastActivationAt(db: Db, sessionKey?: string): number | null {
  const rows = sessionKey
    ? db
        .select()
        .from(agentActivations)
        .where(eq(agentActivations.sessionKey, sessionKey))
        .orderBy(desc(agentActivations.id))
        .limit(1)
        .all()
    : db.select().from(agentActivations).orderBy(desc(agentActivations.id)).limit(1).all();
  return rows[0]?.updatedAt ?? null;
}

export function countActivationsSince(db: Db, since: number, kinds: string[]): number {
  return db
    .select()
    .from(agentActivations)
    .where(and(gte(agentActivations.startedAt, since), inArray(agentActivations.kind, kinds)))
    .all().length;
}

/** 服务重启后，把「正在想」的激活恢复成「马上继续」，避免它们永远卡在 active。 */
export function recoverActivations(db: Db): void {
  const rows = db
    .select()
    .from(agentActivations)
    .where(eq(agentActivations.status, "active"))
    .all();
  for (const row of rows) {
    // user 回合由 BotChat 内存队列负责，重启后无法恢复，直接收尾。
    updateActivation(db, row.id, {
      status: row.kind === "user" ? "done" : "sleeping",
      nextRunAt: Date.now(),
      finishedAt: row.kind === "user" ? Date.now() : null,
    });
  }
}

/* ---------------------------------------------------------------- 审计 */

export function logCycle(
  db: Db,
  input: {
    activationId?: number | null;
    eventId?: number | null;
    classifier?: unknown;
    thought?: string;
    actions?: unknown;
    result?: string;
  },
): void {
  db.insert(agentCycles)
    .values({
      activationId: input.activationId ?? null,
      eventId: input.eventId ?? null,
      classifier: JSON.stringify(input.classifier ?? {}),
      thought: (input.thought ?? "").slice(0, 2000),
      actions: JSON.stringify(input.actions ?? []),
      result: (input.result ?? "").slice(0, 4000),
      createdAt: Date.now(),
    })
    .run();
}

export function listCycles(db: Db, limit = 20): AgentCycleRow[] {
  return db
    .select()
    .from(agentCycles)
    .orderBy(desc(agentCycles.id))
    .limit(Math.min(limit, 200))
    .all();
}

export function eventPayload(event: AgentEventRow): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(event.payload, {});
}
