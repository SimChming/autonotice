import type { FastifyInstance } from "fastify";
import { count, desc, eq } from "drizzle-orm";
import {
  adminLoginRequestSchema,
  adminLoginResponseSchema,
  adminMemoryUpdateSchema,
  adminOverviewResponseSchema,
  adminPromptResponseSchema,
  adminPromptUpdateSchema,
  adminSettingsResponseSchema,
  adminSettingsUpdateSchema,
  adminUserListResponseSchema,
  createSkillRequestSchema,
  skillListResponseSchema,
  skillManifestSchema,
  updateSkillRequestSchema,
} from "@autonotice/shared";
import { OWNER_QQ, SERVICE_VERSION, qqAvatarUrl } from "@autonotice/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { bindings, memories, messages, scheduleItems, skills, users } from "../db/schema.js";
import type { OneBotClient } from "../onebot/client.js";
import { fail, requireAdmin } from "../auth/guard.js";
import { getRuntimeLlm, maskKey } from "../llm/runtime.js";
import { getActivePersona, getSetting, listSkills, setSetting, toManifest } from "../skills/registry.js";
import { SUPPORTED_HANDLERS } from "../skills/handlers.js";
import { embedText, memorySourceLabel } from "../bot/memory.js";
import { verifyAdmin } from "../services/admin.js";

interface AdminRouteOptions {
  db: Db;
  config: Config;
  onebot: OneBotClient;
}

const PROMPT_OVERRIDE_KEY = "prompt.persona_override";

function toMemoryItem(db: Db, row: typeof memories.$inferSelect) {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags) as string[];
  } catch {
    tags = row.tags ? row.tags.split(",").filter(Boolean) : [];
  }
  return {
    id: row.id,
    sessionKey: row.sessionKey,
    senderQq: row.senderQq,
    content: row.content,
    tags,
    kind: row.kind,
    scope: row.scope,
    createdAt: new Date(row.createdAt).toISOString(),
    source: memorySourceLabel(db, row),
  };
}

/** 后台「提示词」页数据：当前人格默认 prompt + 覆盖值 + 最近记忆。 */
function buildPromptPayload(db: Db) {
  const active = getActivePersona(db);
  const override = getSetting(db, PROMPT_OVERRIDE_KEY) ?? "";
  const rows = db.select().from(memories).orderBy(desc(memories.id)).limit(100).all();
  return adminPromptResponseSchema.parse({
    personaId: active.id,
    personaName: active.name,
    defaultPrompt: active.prompt,
    overridePrompt: override,
    effectivePrompt: override.trim() || active.prompt,
    memoryCount: db.select({ value: count() }).from(memories).get()?.value ?? 0,
    items: rows.map((row) => toMemoryItem(db, row)),
  });
}

export function registerAdminRoutes(app: FastifyInstance, { db, config, onebot }: AdminRouteOptions): void {
  app.post("/api/v1/admin/login", async (request, reply) => {
    const parsed = adminLoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, "invalid_request", "用户名或密码格式不正确");
    }
    if (!verifyAdmin(db, parsed.data.username, parsed.data.password)) {
      return fail(reply, 401, "invalid_credentials", "管理员账号或密码错误");
    }

    const token = app.jwt.sign(
      { sub: "admin", scope: "admin", username: parsed.data.username },
      { expiresIn: "12h" },
    );
    return adminLoginResponseSchema.parse({ token });
  });

  app.get("/api/v1/admin/overview", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const countOf = (table: typeof users | typeof bindings | typeof scheduleItems | typeof messages | typeof skills) =>
      db.select({ value: count() }).from(table).get()?.value ?? 0;

    return adminOverviewResponseSchema.parse({
      users: countOf(users),
      bindings: countOf(bindings),
      schedules: countOf(scheduleItems),
      messages: countOf(messages),
      skills: countOf(skills),
      onebotConnected: onebot.connected,
      uptime: process.uptime(),
      version: SERVICE_VERSION,
    });
  });

  app.get("/api/v1/admin/settings", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const runtime = getRuntimeLlm(db, config);
    return adminSettingsResponseSchema.parse({
      llm: {
        model: runtime.model,
        visionModel: runtime.visionModel,
        embeddingModel: runtime.embeddingModel,
        baseUrl: runtime.baseUrl,
        apiKeyMasked: maskKey(runtime.apiKey),
      },
    });
  });

  app.put("/api/v1/admin/settings", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const parsed = adminSettingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, "invalid_request", parsed.error.issues[0]?.message ?? "参数不合法");
    }

    if (parsed.data.model) {
      setSetting(db, "llm.model", parsed.data.model);
    }
    if (parsed.data.visionModel) {
      setSetting(db, "llm.vision_model", parsed.data.visionModel);
    }
    if (parsed.data.embeddingModel) {
      setSetting(db, "llm.embedding_model", parsed.data.embeddingModel);
    }
    if (parsed.data.baseUrl) {
      setSetting(db, "llm.base_url", parsed.data.baseUrl);
    }
    if (parsed.data.apiKey && !parsed.data.apiKey.includes("*")) {
      setSetting(db, "llm.api_key", parsed.data.apiKey);
    }

    const runtime = getRuntimeLlm(db, config);
    return adminSettingsResponseSchema.parse({
      llm: {
        model: runtime.model,
        visionModel: runtime.visionModel,
        embeddingModel: runtime.embeddingModel,
        baseUrl: runtime.baseUrl,
        apiKeyMasked: maskKey(runtime.apiKey),
      },
    });
  });

  app.get("/api/v1/admin/prompt", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    return buildPromptPayload(db);
  });

  app.put("/api/v1/admin/prompt", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const parsed = adminPromptUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, "invalid_request", parsed.error.issues[0]?.message ?? "参数不合法");
    }
    setSetting(db, PROMPT_OVERRIDE_KEY, parsed.data.overridePrompt.trim());
    return buildPromptPayload(db);
  });

  app.patch("/api/v1/admin/memories/:id", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const id = Number((request.params as { id: string }).id);
    const existing = db.select().from(memories).where(eq(memories.id, id)).get();
    if (!existing) {
      return fail(reply, 404, "not_found", "记忆不存在");
    }
    const parsed = adminMemoryUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, "invalid_request", parsed.error.issues[0]?.message ?? "参数不合法");
    }

    const content = parsed.data.content ?? existing.content;
    const tags = parsed.data.tags ?? toMemoryItem(db, existing).tags;
    let embedding = existing.embedding;
    if (content !== existing.content) {
      const runtime = getRuntimeLlm(db, config);
      const vector = await embedText(
        {
          ...config,
          llm: {
            ...config.llm,
            baseUrl: runtime.baseUrl,
            apiKey: runtime.apiKey,
            embeddingModel: runtime.embeddingModel,
          },
        },
        content,
      );
      if (vector) {
        embedding = JSON.stringify(vector);
      }
    }

    const row = db
      .update(memories)
      .set({ content, tags: tags.join(","), embedding })
      .where(eq(memories.id, id))
      .returning()
      .get();
    return toMemoryItem(db, row);
  });

  app.delete("/api/v1/admin/memories/:id", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const id = Number((request.params as { id: string }).id);
    const existing = db.select().from(memories).where(eq(memories.id, id)).get();
    if (!existing) {
      return fail(reply, 404, "not_found", "记忆不存在");
    }
    db.delete(memories).where(eq(memories.id, id)).run();
    return reply.code(204).send();
  });

  app.get("/api/v1/admin/users", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const rows = db
      .select({
        id: users.id,
        username: users.username,
        createdAt: users.createdAt,
        qq: bindings.qq,
        verifiedAt: bindings.verifiedAt,
      })
      .from(users)
      .leftJoin(bindings, eq(bindings.userId, users.id))
      .all();

    return adminUserListResponseSchema.parse({
      items: rows.map((row) => ({
        id: row.id,
        username: row.username,
        qq: row.qq,
        role: row.qq === OWNER_QQ ? "owner" : "user",
        verifiedAt: row.verifiedAt === null ? null : new Date(row.verifiedAt).toISOString(),
        createdAt: new Date(row.createdAt).toISOString(),
        avatarUrl: row.qq ? qqAvatarUrl(row.qq) : null,
      })),
    });
  });

  app.delete("/api/v1/admin/users/:id", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const id = Number((request.params as { id: string }).id);
    const existing = db.select().from(users).where(eq(users.id, id)).get();
    if (!existing) {
      return fail(reply, 404, "not_found", "用户不存在");
    }
    db.delete(users).where(eq(users.id, id)).run();
    return reply.code(204).send();
  });

  app.get("/api/v1/admin/skills", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    return skillListResponseSchema.parse({ items: listSkills(db) });
  });

  app.get("/api/v1/admin/skills/handlers", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    return { items: SUPPORTED_HANDLERS };
  });

  app.post("/api/v1/admin/skills", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const parsed = createSkillRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, "invalid_request", parsed.error.issues[0]?.message ?? "参数不合法");
    }

    const existing = db.select().from(skills).where(eq(skills.id, parsed.data.id)).get();
    if (existing) {
      return fail(reply, 409, "skill_exists", "技能 id 已存在");
    }
    if (parsed.data.handler && !SUPPORTED_HANDLERS.some((item) => item.id === parsed.data.handler)) {
      return fail(reply, 400, "invalid_handler", "handler 不在受支持列表内");
    }

    const now = Date.now();
    const row = db
      .insert(skills)
      .values({
        id: parsed.data.id,
        name: parsed.data.name,
        description: parsed.data.description,
        type: parsed.data.type,
        enabled: parsed.data.enabled ? 1 : 0,
        prompt: parsed.data.prompt,
        handler: parsed.data.handler,
        permissions: parsed.data.permissions,
        paramsSchema: JSON.stringify(parsed.data.paramsSchema),
        version: parsed.data.version,
        builtin: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    return reply.code(201).send(skillManifestSchema.parse(toManifest(row)));
  });

  app.patch("/api/v1/admin/skills/:id", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const id = (request.params as { id: string }).id;
    const existing = db.select().from(skills).where(eq(skills.id, id)).get();
    if (!existing) {
      return fail(reply, 404, "not_found", "技能不存在");
    }

    const parsed = updateSkillRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, "invalid_request", parsed.error.issues[0]?.message ?? "参数不合法");
    }
    if (
      existing.builtin === 1 &&
      (parsed.data.type !== undefined || parsed.data.handler !== undefined)
    ) {
      return fail(reply, 400, "builtin_locked", "内置技能不允许修改类型或 handler");
    }
    if (
      parsed.data.handler &&
      !SUPPORTED_HANDLERS.some((item) => item.id === parsed.data.handler)
    ) {
      return fail(reply, 400, "invalid_handler", "handler 不在受支持列表内");
    }

    const row = db
      .update(skills)
      .set({
        name: parsed.data.name ?? existing.name,
        description: parsed.data.description ?? existing.description,
        type: parsed.data.type ?? existing.type,
        enabled: parsed.data.enabled === undefined ? existing.enabled : parsed.data.enabled ? 1 : 0,
        prompt: parsed.data.prompt ?? existing.prompt,
        handler: parsed.data.handler === undefined ? existing.handler : parsed.data.handler,
        permissions: parsed.data.permissions ?? existing.permissions,
        paramsSchema:
          parsed.data.paramsSchema === undefined
            ? existing.paramsSchema
            : JSON.stringify(parsed.data.paramsSchema),
        version: parsed.data.version ?? existing.version,
        updatedAt: Date.now(),
      })
      .where(eq(skills.id, id))
      .returning()
      .get();

    return skillManifestSchema.parse(toManifest(row));
  });

  app.delete("/api/v1/admin/skills/:id", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const id = (request.params as { id: string }).id;
    const existing = db.select().from(skills).where(eq(skills.id, id)).get();
    if (!existing) {
      return fail(reply, 404, "not_found", "技能不存在");
    }
    if (existing.builtin === 1) {
      return fail(reply, 400, "builtin_locked", "内置技能不能删除，只能停用");
    }
    db.delete(skills).where(eq(skills.id, id)).run();
    return reply.code(204).send();
  });
}
