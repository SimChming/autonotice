import type { FastifyInstance } from "fastify";
import { and, count, desc, eq } from "drizzle-orm";
import {
  adminLoginRequestSchema,
  adminLoginResponseSchema,
  adminMemoryUpdateSchema,
  adminNotifyRequestSchema,
  adminNotifyResponseSchema,
  adminOverviewResponseSchema,
  adminPromptResponseSchema,
  adminPromptUpdateSchema,
  adminSettingsResponseSchema,
  adminSettingsUpdateSchema,
  adminUserChatResponseSchema,
  adminUserDetailResponseSchema,
  adminUserListResponseSchema,
  createSkillRequestSchema,
  skillListResponseSchema,
  skillManifestSchema,
  updateSkillRequestSchema,
} from "@autonotice/shared";
import { OWNER_QQ, SERVICE_VERSION, qqAvatarUrl } from "@autonotice/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { bindings, botHistory, groups, memories, messages, scheduleItems, skills, userGroups, users } from "../db/schema.js";
import type { OneBotClient } from "../onebot/client.js";
import type { NotifyHub } from "../notify/hub.js";
import type { LlmClient } from "../llm/client.js";
import { fail, requireAdmin } from "../auth/guard.js";
import { getRuntimeLlm, maskKey } from "../llm/runtime.js";
import { getActivePersona, getSetting, listSkills, setSetting, toManifest } from "../skills/registry.js";
import { SUPPORTED_HANDLERS } from "../skills/handlers.js";
import { embedText, memorySourceLabel } from "../bot/memory.js";
import { appendHistory } from "../bot/history.js";
import { getReplyQuota } from "../services/reply-quota.js";
import { verifyAdmin } from "../services/admin.js";

interface AdminRouteOptions {
  db: Db;
  config: Config;
  onebot: OneBotClient;
  hub: NotifyHub;
  llm: LlmClient;
}

const PROMPT_OVERRIDE_KEY = "prompt.persona_override";

/** 模型设置 + 消息额度，读写共用同一结构。 */
function settingsPayload(db: Db, config: Config) {
  const runtime = getRuntimeLlm(db, config);
  return adminSettingsResponseSchema.parse({
    llm: {
      model: runtime.model,
      visionModel: runtime.visionModel,
      embeddingModel: runtime.embeddingModel,
      baseUrl: runtime.baseUrl,
      apiKeyMasked: maskKey(runtime.apiKey),
    },
    reply: getReplyQuota(db),
  });
}

function toUserPayload(
  db: Db,
  hub: NotifyHub,
  row: { id: number; username: string; createdAt: number; qq: string | null; verifiedAt: number | null },
) {
  const scheduleTotal = db
    .select({ value: count() })
    .from(scheduleItems)
    .where(eq(scheduleItems.userId, row.id))
    .get()?.value ?? 0;
  const schedulePending = db
    .select({ value: count() })
    .from(scheduleItems)
    .where(and(eq(scheduleItems.userId, row.id), eq(scheduleItems.status, "pending")))
    .get()?.value ?? 0;
  return {
    id: row.id,
    username: row.username,
    qq: row.qq,
    role: (row.qq === OWNER_QQ ? "owner" : "user") as "owner" | "user",
    verifiedAt: row.verifiedAt === null ? null : new Date(row.verifiedAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    avatarUrl: row.qq ? qqAvatarUrl(row.qq) : null,
    presence: hub.presenceFor(row.id),
    scheduleTotal,
    schedulePending,
  };
}

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

export function registerAdminRoutes(
  app: FastifyInstance,
  { db, config, onebot, hub, llm }: AdminRouteOptions,
): void {
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
    return settingsPayload(db, config);
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
    // 消息额度：0 表示主人私聊不限条数。
    if (parsed.data.groupLimit !== undefined) {
      setSetting(db, "reply.limit.group", String(parsed.data.groupLimit));
    }
    if (parsed.data.ownerPrivateLimit !== undefined) {
      setSetting(db, "reply.limit.owner_private", String(parsed.data.ownerPrivateLimit));
    }
    if (parsed.data.userPrivateLimit !== undefined) {
      setSetting(db, "reply.limit.user_private", String(parsed.data.userPrivateLimit));
    }

    return settingsPayload(db, config);
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
      items: rows.map((row) => toUserPayload(db, hub, row)),
    });
  });

  // 用户详情：在线端、日程明细（含完成状态）与绑定群聊。
  app.get("/api/v1/admin/users/:id/detail", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const id = Number((request.params as { id: string }).id);
    const row = db
      .select({
        id: users.id,
        username: users.username,
        createdAt: users.createdAt,
        qq: bindings.qq,
        verifiedAt: bindings.verifiedAt,
      })
      .from(users)
      .leftJoin(bindings, eq(bindings.userId, users.id))
      .where(eq(users.id, id))
      .get();
    if (!row) {
      return fail(reply, 404, "not_found", "用户不存在");
    }

    const groupRows = db
      .select({ groupId: userGroups.groupId })
      .from(userGroups)
      .where(eq(userGroups.userId, id))
      .all();
    const groupNames = new Map(
      db
        .select({ groupId: groups.groupId, name: groups.name, avatar: groups.avatar })
        .from(groups)
        .all()
        .map((item) => [item.groupId, item]),
    );

    const schedules = db
      .select()
      .from(scheduleItems)
      .where(eq(scheduleItems.userId, id))
      .orderBy(desc(scheduleItems.updatedAt))
      .limit(200)
      .all();

    return adminUserDetailResponseSchema.parse({
      user: toUserPayload(db, hub, row),
      presence: hub.presenceFor(id),
      schedules: schedules.map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        type: item.type,
        priority: item.priority,
        groupId: item.groupId,
        groupName: item.groupId ? groupNames.get(item.groupId)?.name ?? null : null,
        dueAt: item.dueAt === null ? null : new Date(item.dueAt).toISOString(),
        remindAt: item.remindAt === null ? null : new Date(item.remindAt).toISOString(),
        notes: item.notes,
        updatedAt: new Date(item.updatedAt).toISOString(),
      })),
      groups: groupRows.map((item) => ({
        groupId: item.groupId,
        name: groupNames.get(item.groupId)?.name ?? "",
        avatar: groupNames.get(item.groupId)?.avatar ?? "",
      })),
    });
  });

  // AI 视角：用户与机器人的私聊原文（只读）。
  app.get("/api/v1/admin/users/:id/chat", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const id = Number((request.params as { id: string }).id);
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);
    const binding = db.select().from(bindings).where(eq(bindings.userId, id)).get();
    if (!binding) {
      return adminUserChatResponseSchema.parse({ items: [] });
    }
    const rows = db
      .select()
      .from(botHistory)
      .where(eq(botHistory.sessionKey, `private:${binding.qq}`))
      .orderBy(desc(botHistory.id))
      .limit(limit)
      .all()
      .reverse();
    return adminUserChatResponseSchema.parse({
      items: rows
        .filter((row) => row.role === "user" || row.role === "assistant")
        .map((row) => ({
          role: row.role as "user" | "assistant",
          text: row.text,
          at: new Date(row.createdAt).toISOString(),
        })),
    });
  });

  // 精准通知：管理员让 AI 以鲸鱼娘口吻给指定用户（或全体）发私聊。
  app.post("/api/v1/admin/users/notify", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const parsed = adminNotifyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, "invalid_request", parsed.error.issues[0]?.message ?? "参数不合法");
    }
    if (!parsed.data.all && !parsed.data.userIds?.length) {
      return fail(reply, 400, "invalid_request", "请选择至少一个用户，或勾选全体用户");
    }

    const targetIds = parsed.data.all
      ? db.select({ id: users.id }).from(users).all().map((row) => row.id)
      : parsed.data.userIds ?? [];

    const persona = getActivePersona(db);
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const failures: Array<{ userId: number; reason: string }> = [];

    for (const userId of targetIds) {
      const binding = db.select().from(bindings).where(eq(bindings.userId, userId)).get();
      if (!binding) {
        skipped += 1;
        continue;
      }

      let text = parsed.data.text;
      if (parsed.data.useAi) {
        try {
          const raw = await llm.chatJson([
            {
              role: "system",
              content:
                `你是「${persona.name}」，现在要把管理员的通知转达给用户。` +
                "保持人格语气但信息必须准确、简洁，不要添加通知以外的承诺。只输出 json：{\"text\":\"消息正文\"}。" +
                (persona.prompt ? `\n【人格设定】\n${persona.prompt.slice(0, 1500)}` : ""),
            },
            { role: "user", content: `管理员通知内容：${parsed.data.text}` },
          ]);
          const polished = JSON.parse(raw) as { text?: unknown };
          if (typeof polished.text === "string" && polished.text.trim()) {
            text = polished.text.trim().slice(0, 1000);
          }
        } catch {
          // AI 润色失败时按管理员原文发送。
        }
      }

      try {
        await onebot.sendPrivateMsg(binding.qq, text);
        appendHistory(db, `private:${binding.qq}`, "assistant", null, text);
        sent += 1;
      } catch (error) {
        failed += 1;
        failures.push({
          userId,
          reason: error instanceof Error ? error.message.slice(0, 120) : "发送失败",
        });
      }
    }

    return adminNotifyResponseSchema.parse({ sent, failed, skipped, failures });
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
