import type { FastifyInstance } from "fastify";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { fail, requireAdmin } from "../auth/guard.js";
import type { LlmClient } from "../llm/client.js";
import { writeDailyJournal, evolvePersona } from "./journal.js";
import type { SoulLoop } from "./idle.js";
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
  logger: FastifyBaseLogger;
}

export function registerSoulRoutes(app: FastifyInstance, options: SoulRouteOptions): void {
  const { db, config, llm, loop, logger } = options;

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
      enabled: config.soul.enabled,
    };
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
}
