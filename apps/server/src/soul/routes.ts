import type { FastifyInstance } from "fastify";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { fail, requireAdmin } from "../auth/guard.js";
import type { LlmClient } from "../llm/client.js";
import { writeDailyJournal, evolvePersona } from "./journal.js";
import { listCommands, runOwnerInstruction } from "./hands.js";
import type { SoulLoop } from "./idle.js";
import type { AgentKernel, AgentTriggerSpec } from "./agent/types.js";
import {
  DRIVE_LABELS,
  KIND_LABELS,
  addIntention,
  listIntentions,
  listReflections,
  progressIntention,
  topDrives,
  type IntentionKind,
} from "./life.js";
import {
  dayKey,
  getJournal,
  getSoulSnapshot,
  listEvents,
  listJournals,
  listReadings,
  listReadingsAll,
  recordVisit,
  TRAIT_LABELS,
  type SoulTraits,
} from "./store.js";

interface SoulRouteOptions {
  db: Db;
  config: Config;
  llm: LlmClient;
  loop: SoulLoop;
  agent: AgentKernel;
  logger: FastifyBaseLogger;
}

export function registerSoulRoutes(app: FastifyInstance, options: SoulRouteOptions): void {
  const { db, config, llm, loop, agent, logger } = options;

  app.get("/api/v1/admin/soul/state", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const snapshot = getSoulSnapshot(db);
    return {
      ...snapshot,
      day: dayKey(),
      traitLabels: TRAIT_LABELS,
      traitsList: (Object.keys(TRAIT_LABELS) as Array<keyof SoulTraits>).map((key) => ({
        key,
        label: TRAIT_LABELS[key],
        value: snapshot.traits[key],
      })),
      drives: topDrives(db, 5).map((item) => ({
        name: item.name,
        label: DRIVE_LABELS[item.name],
        level: item.level,
      })),
      intentions: listIntentions(db, "active", 8).map((row) => ({
        id: row.id,
        text: row.text,
        kind: row.kind,
        kindLabel: KIND_LABELS[row.kind as IntentionKind] ?? row.kind,
        progress: row.progress,
        priority: row.priority,
        day: row.day,
        updatedAt: new Date(row.updatedAt).toISOString(),
      })),
      reflections: listReflections(db, 6).map((row) => ({
        id: row.id,
        content: row.content,
        importance: row.importance,
        day: row.day,
      })),
      enabled: config.soul.enabled,
    };
  });

  // 主人给她种一个念头：她会真的把它当成自己的事去惦记。
  app.post("/api/v1/admin/soul/intention", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const body = (request.body ?? {}) as { text?: string; kind?: string; priority?: number };
    const text = String(body.text ?? "").trim();
    if (text.length < 2) {
      return fail(reply, 400, "invalid_request", "想让她惦记的事太短了");
    }
    const kinds = ["goal", "question", "worry", "promise"];
    const kind = (kinds.includes(String(body.kind)) ? body.kind : "goal") as IntentionKind;
    const id = addIntention(db, text, kind, Number(body.priority) || 70);
    return { ok: true, id };
  });

  app.post("/api/v1/admin/soul/intention/:id/done", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isFinite(id)) {
      return fail(reply, 400, "invalid_request", "id 不合法");
    }
    progressIntention(db, id, "主人说这件事可以放下了。", true);
    return { ok: true };
  });

  app.get("/api/v1/admin/soul/commands", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const limit = Math.min(Number((request.query as { limit?: string }).limit) || 20, 200);
    return {
      items: listCommands(db, limit).map((row) => ({
        id: row.id,
        command: row.command,
        output: row.output,
        ok: row.ok === 1,
        durationMs: row.durationMs,
        trigger: row.trigger,
        reason: row.reason,
        day: row.day,
        at: new Date(row.createdAt).toISOString(),
      })),
    };
  });

  // 主人用一句话让她去服务器上做事，她把这句话翻译成命令并当场执行。
  app.post("/api/v1/admin/soul/command", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const instruction = String(
      (request.body as { instruction?: string } | undefined)?.instruction ?? "",
    ).trim();
    if (instruction.length < 2) {
      return fail(reply, 400, "invalid_request", "想让她做的事太短了");
    }
    try {
      const result = await runOwnerInstruction({ db, config, llm, logger }, instruction);
      return { ...result };
    } catch (error) {
      logger.warn({ err: error }, "主人下发的命令执行失败");
      return fail(reply, 500, "internal_error", "执行失败");
    }
  });

  app.get("/api/v1/admin/soul/journals", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const limit = Math.min(Number((request.query as { limit?: string }).limit) || 30, 200);
    return {
      items: listJournals(db, limit).map((row) => ({
        day: row.day,
        title: row.title,
        body: row.body,
        mood: row.mood,
        createdAt: new Date(row.createdAt).toISOString(),
      })),
    };
  });

  app.get("/api/v1/admin/soul/journals/:day", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const day = String((request.params as { day?: string }).day ?? "");
    const row = getJournal(db, day);
    if (!row) {
      return fail(reply, 404, "not_found", "那天没有日记");
    }
    return {
      day: row.day,
      title: row.title,
      body: row.body,
      mood: row.mood,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  });

  app.get("/api/v1/admin/soul/readings", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const query = request.query as { day?: string; limit?: string };
    const limit = Math.min(Number(query.limit) || 40, 200);
    const rows = query.day ? listReadings(db, query.day, limit) : listReadingsAll(db, limit);
    return {
      items: rows.map((row) => ({
        id: row.id,
        source: row.source,
        title: row.title,
        url: row.url,
        summary: row.summary,
        day: row.day,
        at: new Date(row.createdAt).toISOString(),
      })),
    };
  });

  app.get("/api/v1/admin/soul/events", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const query = request.query as { day?: string; limit?: string };
    const limit = Math.min(Number(query.limit) || 60, 200);
    return {
      items: listEvents(db, limit, query.day).map((row) => ({
        id: row.id,
        kind: row.kind,
        content: row.content,
        day: row.day,
        at: new Date(row.createdAt).toISOString(),
      })),
    };
  });

  app.post("/api/v1/admin/soul/visit", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const body = (request.body ?? {}) as { day?: string; tell?: boolean };
    const day = body.day || dayKey();
    if (!getJournal(db, day)) {
      return fail(reply, 404, "not_found", "那天没有日记");
    }
    const tell = body.tell === true;
    recordVisit(db, day, config.soul.ownerQq, tell);
    return { ok: true, day, tell };
  });

  app.post("/api/v1/admin/soul/tick", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    void loop.tick();
    return reply.code(202).send({ ok: true, message: "已让她去活动一下" });
  });

  app.post("/api/v1/admin/soul/journal", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const force = (request.body as { force?: boolean } | undefined)?.force === true;
    try {
      const wrote = await writeDailyJournal(db, config, llm, logger, force);
      if (wrote && !listEvents(db, 5, dayKey()).some((row) => row.kind === "evolve")) {
        await evolvePersona(db, config, llm, logger);
      }
      return { ok: true, wrote };
    } catch (error) {
      logger.warn({ err: error }, "手动写日记失败");
      return fail(reply, 500, "internal_error", "写日记失败");
    }
  });

  /* ------------------------------------------------ 5.4.0 仿人闭环 */

  const parseMaybeJson = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  };
  const iso = (value: number | null): string | null => (value ? new Date(value).toISOString() : null);

  app.get("/api/v1/admin/soul/agent", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const snap = agent.snapshot();
    return {
      activations: snap.activations.map((row) => ({
        id: row.id,
        sessionKey: row.sessionKey,
        mode: row.mode,
        kind: row.kind,
        status: row.status,
        task: row.task,
        context: row.context,
        nextRunAt: iso(row.nextRunAt),
        leaseUntil: iso(row.leaseUntil),
        continueCount: row.continueCount,
        maxContinues: row.maxContinues,
        startedAt: iso(row.startedAt),
        updatedAt: iso(row.updatedAt),
        finishedAt: iso(row.finishedAt),
        lastError: row.lastError,
      })),
      triggers: snap.triggers.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        sessionKey: row.sessionKey,
        condition: parseMaybeJson(row.condition),
        prompt: row.prompt,
        enabled: row.enabled === 1,
        oneShot: row.oneShot === 1,
        cooldownMs: row.cooldownMs,
        priority: row.priority,
        lastFiredAt: iso(row.lastFiredAt),
        fireCount: row.fireCount,
      })),
      cycles: snap.cycles.map((row) => ({
        id: row.id,
        activationId: row.activationId,
        eventId: row.eventId,
        classifier: parseMaybeJson(row.classifier),
        thought: row.thought,
        actions: parseMaybeJson(row.actions),
        result: row.result,
        at: iso(row.createdAt),
      })),
      events: snap.events.map((row) => ({
        id: row.id,
        source: row.source,
        type: row.type,
        sessionKey: row.sessionKey,
        addressed: row.addressed === 1,
        payload: parseMaybeJson(row.payload),
        importance: row.importance,
        at: iso(row.createdAt),
      })),
      config: {
        agentLoop: config.soul.agentLoop,
        classifierEnabled: config.soul.classifierEnabled,
        ambientWakeThreshold: config.soul.ambientWakeThreshold,
        selfMaxContinues: config.soul.selfMaxContinues,
        selfMaxLeaseHours: config.soul.selfMaxLeaseHours,
        freeMaxPerHour: config.soul.freeMaxPerHour,
      },
    };
  });

  app.post("/api/v1/admin/soul/agent/trigger", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const body = (request.body ?? {}) as Partial<AgentTriggerSpec>;
    const condition = body.condition as Record<string, unknown> | undefined;
    if (!body.name?.trim() || !condition || typeof condition.type !== "string") {
      return fail(reply, 400, "invalid_request", "触发器需要名字和条件类型");
    }
    const row = agent.addTrigger({
      name: body.name.trim(),
      condition: body.condition as AgentTriggerSpec["condition"],
      prompt: body.prompt ?? "",
      sessionKey: body.sessionKey ?? null,
      oneShot: body.oneShot === true,
      cooldownMs: Number(body.cooldownMs) || undefined,
      priority: Number(body.priority) || undefined,
    });
    return { ok: true, id: row.id };
  });

  app.post("/api/v1/admin/soul/agent/activation/:id/cancel", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isFinite(id)) {
      return fail(reply, 400, "invalid_request", "id 不合法");
    }
    agent.cancelActivation(id);
    return { ok: true };
  });

  app.post("/api/v1/admin/soul/agent/wake", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const body = (request.body ?? {}) as { prompt?: string; sessionKey?: string };
    agent.wake(body.prompt ?? "", body.sessionKey ?? null);
    return { ok: true };
  });
}
