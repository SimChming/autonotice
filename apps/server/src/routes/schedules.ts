import type { FastifyInstance } from "fastify";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import {
  alertListResponseSchema,
  createScheduleRequestSchema,
  scheduleItemSchema,
  scheduleListResponseSchema,
  updateScheduleRequestSchema,
  type ScheduleItem,
} from "@autonotice/shared";
import type { Db } from "../db/client.js";
import { alerts, scheduleItems } from "../db/schema.js";
import { fail, requireUser } from "../auth/guard.js";

interface ScheduleRouteOptions {
  db: Db;
}

type ScheduleRow = typeof scheduleItems.$inferSelect;

function toItem(row: ScheduleRow): ScheduleItem {
  return scheduleItemSchema.parse({
    id: row.id,
    title: row.title,
    type: row.type,
    priority: row.priority,
    status: row.status,
    dueAt: row.dueAt === null ? null : new Date(row.dueAt).toISOString(),
    remindAt: row.remindAt === null ? null : new Date(row.remindAt).toISOString(),
    notes: row.notes,
    groupId: row.groupId,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  });
}

function refreshAlert(db: Db, userId: number, scheduleId: number, at: number | null, title: string, notes: string) {
  db.delete(alerts).where(and(eq(alerts.scheduleId, scheduleId), isNull(alerts.sentAt))).run();
  if (at === null) {
    return;
  }
  db.insert(alerts).values({ userId, scheduleId, level: "normal", title, body: notes, route: "ws", at }).run();
}

export function registerScheduleRoutes(app: FastifyInstance, { db }: ScheduleRouteOptions): void {
  app.get("/api/v1/schedules", async (request, reply) => {
    const claims = await requireUser(request, reply);
    if (!claims) {
      return;
    }
    const rows = db
      .select()
      .from(scheduleItems)
      .where(eq(scheduleItems.userId, claims.sub))
      .orderBy(scheduleItems.dueAt, desc(scheduleItems.createdAt))
      .all();
    return scheduleListResponseSchema.parse({ items: rows.map(toItem) });
  });

  app.post("/api/v1/schedules", async (request, reply) => {
    const claims = await requireUser(request, reply);
    if (!claims) {
      return;
    }
    const parsed = createScheduleRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, "invalid_request", parsed.error.issues[0]?.message ?? "参数不合法");
    }

    const now = Date.now();
    const dueAt = parsed.data.dueAt ? Date.parse(parsed.data.dueAt) : null;
    const remindAt = parsed.data.remindAt
      ? Date.parse(parsed.data.remindAt)
      : dueAt === null
        ? null
        : dueAt - 30 * 60 * 1000;

    const row = db
      .insert(scheduleItems)
      .values({
        userId: claims.sub,
        groupId: parsed.data.groupId ?? null,
        title: parsed.data.title,
        type: parsed.data.type,
        priority: parsed.data.priority,
        status: "pending",
        dueAt,
        remindAt,
        notes: parsed.data.notes,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    refreshAlert(db, claims.sub, row.id, remindAt ?? dueAt, row.title, row.notes);
    return reply.code(201).send(toItem(row));
  });

  app.patch("/api/v1/schedules/:id", async (request, reply) => {
    const claims = await requireUser(request, reply);
    if (!claims) {
      return;
    }
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return fail(reply, 400, "invalid_request", "日程 id 不合法");
    }
    const parsed = updateScheduleRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, "invalid_request", parsed.error.issues[0]?.message ?? "参数不合法");
    }

    const existing = db
      .select()
      .from(scheduleItems)
      .where(and(eq(scheduleItems.id, id), eq(scheduleItems.userId, claims.sub)))
      .get();
    if (!existing) {
      return fail(reply, 404, "not_found", "日程不存在");
    }

    const dueAt =
      parsed.data.dueAt === undefined
        ? existing.dueAt
        : parsed.data.dueAt === null
          ? null
          : Date.parse(parsed.data.dueAt);
    const remindAt =
      parsed.data.remindAt === undefined
        ? dueAt === null
          ? null
          : dueAt - 30 * 60 * 1000
        : parsed.data.remindAt === null
          ? null
          : Date.parse(parsed.data.remindAt);

    const row = db
      .update(scheduleItems)
      .set({
        title: parsed.data.title ?? existing.title,
        type: parsed.data.type ?? existing.type,
        priority: parsed.data.priority ?? existing.priority,
        status: parsed.data.status ?? existing.status,
        notes: parsed.data.notes ?? existing.notes,
        dueAt,
        remindAt,
        updatedAt: Date.now(),
      })
      .where(eq(scheduleItems.id, id))
      .returning()
      .get();

    refreshAlert(db, claims.sub, id, remindAt ?? dueAt, row.title, row.notes);
    return toItem(row);
  });

  app.delete("/api/v1/schedules/:id", async (request, reply) => {
    const claims = await requireUser(request, reply);
    if (!claims) {
      return;
    }
    const id = Number((request.params as { id: string }).id);
    const existing = db
      .select()
      .from(scheduleItems)
      .where(and(eq(scheduleItems.id, id), eq(scheduleItems.userId, claims.sub)))
      .get();
    if (!existing) {
      return fail(reply, 404, "not_found", "日程不存在");
    }
    db.delete(alerts).where(eq(alerts.scheduleId, id)).run();
    db.delete(scheduleItems).where(eq(scheduleItems.id, id)).run();
    return reply.code(204).send();
  });

  app.get("/api/v1/alerts", async (request, reply) => {
    const claims = await requireUser(request, reply);
    if (!claims) {
      return;
    }
    const rows = db
      .select()
      .from(alerts)
      .where(and(eq(alerts.userId, claims.sub), lte(alerts.at, Date.now() + 7 * 24 * 3600 * 1000)))
      .orderBy(desc(alerts.at))
      .limit(100)
      .all();

    return alertListResponseSchema.parse({
      items: rows.map((row) => ({
        id: row.id,
        scheduleId: row.scheduleId,
        level: row.level,
        title: row.title,
        body: row.body,
        at: new Date(row.at).toISOString(),
        sentAt: row.sentAt === null ? null : new Date(row.sentAt).toISOString(),
      })),
    });
  });
}
