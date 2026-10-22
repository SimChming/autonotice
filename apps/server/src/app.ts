import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import httpProxy from "@fastify/http-proxy";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { BOT_QQ, healthResponseSchema, SERVICE_VERSION } from "@autonotice/shared";
import type { Config } from "./config.js";
import { createDatabase } from "./db/client.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBindRoutes } from "./routes/bind.js";
import { registerScheduleRoutes } from "./routes/schedules.js";
import { registerGroupRoutes } from "./routes/groups.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAdminOpsRoutes } from "./routes/admin-ops.js";
import { seedSkills } from "./skills/registry.js";
import { OneBotClient } from "./onebot/client.js";
import { registerOneBotWs } from "./onebot/ws.js";
import { createBotHandlers } from "./bot/handle.js";
import type { IngestDeps } from "./pipeline/ingest.js";
import { createLlmClient } from "./llm/client.js";
import { getRuntimeLlm } from "./llm/runtime.js";
import { extractSchedules } from "./pipeline/extract.js";
import { mergeAndSave } from "./pipeline/merge.js";
import { NotifyHub } from "./notify/hub.js";
import { startReminderScheduler } from "./scheduler/reminders.js";
import { fireEventTriggers, startTriggerScheduler } from "./triggers/executor.js";
import { AdminChatHub } from "./admin/chat-hub.js";
import { registerAdminChatRoutes } from "./admin/chat-routes.js";
import { ensureGroup, linkUserGroup, refreshGroupInfo } from "./services/groups.js";
import { ensureAdmin } from "./services/admin.js";

/**
 * 装配 Fastify 实例。路由层只做：鉴权 → zod 校验 → 调服务 → 返回（§4.4）。
 */
export async function buildServer(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
  });

  // CORS：放行 Authorization/Content-Type，预检由插件返回 204（§9-坑5）
  await app.register(cors, {
    origin: true,
    credentials: true,
    allowedHeaders: ["Authorization", "Content-Type"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86_400,
  });
  await app.register(jwt, { secret: config.jwt.secret });
  await app.register(websocket);

  const { db, sqlite } = createDatabase(config.databasePath);
  seedSkills(db);
  ensureAdmin(db, config.admin.username, config.admin.password);
  app.addHook("onClose", async () => {
    sqlite.close();
  });

  const onebot = new OneBotClient();
  const llm = createLlmClient(() => getRuntimeLlm(db, config));
  const hub = new NotifyHub(app.log);
  const adminChatHub = new AdminChatHub();
  const bot = createBotHandlers({
    db,
    config,
    llm,
    hub,
    onebot,
    logger: app.log,
    mirrorPrivate: (message) => adminChatHub.push(message),
  });
  const triggerContext = { db, config, onebot, hub, logger: app.log };

  const ingest: IngestDeps = {
    db,
    bindGroupId: config.bind.groupId,
    onAtBot: bot.onGroupAt,
    onBoundUserMessage: (userId, message, msgId) => {
      // 已绑定用户在任何群发言，都自动把该群加入他的多群聊列表。
      ensureGroup(db, message.groupId);
      linkUserGroup(db, userId, message.groupId);
      void (async () => {
        try {
          const items = await extractSchedules(llm, message.text);
          if (!items.length) {
            return;
          }
          const created = await mergeAndSave(
            { db, llm, logger: app.log },
            userId,
            message.groupId,
            msgId,
            items,
          );
          app.log.info({ userId, msgId, created }, "日程抽取完成");
        } catch (error) {
          app.log.warn({ err: error, userId, msgId }, "日程抽取失败");
        }
      })();
    },
    onGroupMessageEvent: (sessionKey, text) => {
      void fireEventTriggers(triggerContext, sessionKey, text).catch((error: unknown) => {
        app.log.warn({ err: error }, "事件触发器处理失败");
      });
    },
    onGroupSeen: (groupId) => {
      void refreshGroupInfo(onebot, db, groupId, app.log).catch((error: unknown) => {
        app.log.warn({ err: error, groupId }, "补全群信息失败");
      });
    },
    onBindConfirmed: (userId, groupId) => {
      linkUserGroup(db, userId, groupId);
      void refreshGroupInfo(onebot, db, groupId, app.log).catch(() => undefined);
    },
    logger: app.log,
  };

  const reminderTask = startReminderScheduler({ db, hub, onebot, logger: app.log });
  const triggerTask = startTriggerScheduler(triggerContext);
  app.addHook("onClose", async () => {
    reminderTask.stop();
    triggerTask.stop();
  });

  registerAuthRoutes(app, { db, config });
  registerBindRoutes(app, { db, config, onebot });
  registerGroupRoutes(app, { db, onebot });
  registerScheduleRoutes(app, { db });
  registerAdminRoutes(app, { db, config, onebot });
  registerAdminOpsRoutes(app, { db, config, onebot });
  adminChatHub.registerRoute(app);
  registerAdminChatRoutes(app, { db, onebot, hub: adminChatHub, bot });
  hub.registerRoute(app);
  registerOneBotWs(app, {
    config,
    client: onebot,
    ingest,
    botQq: BOT_QQ,
    logger: app.log,
    onPrivateMessage: bot.onPrivateMessage,
  });

  // NapCat WebUI 反向代理：云安全组只放行 8080，这里把 /webui 与 NapCat 的 /api、/auth
  // 透明转发到 napcat:6099，管理员即可在后台直接打开 NapCat 面板处理 QQ 风控/重登。
  // /api/v1/* 的静态路由优先级高于该通配代理，不会受影响。
  // 注意：不要开启 http-proxy 的 websocket 选项——它会接管全局 upgrade 事件，
  // 与 @fastify/websocket 的 /api/v1/ws 冲突并导致 ERR_HTTP_SOCKET_ASSIGNED。
  for (const prefix of ["/webui", "/api", "/auth"]) {
    await app.register(httpProxy, {
      upstream: config.napcat.upstream,
      prefix,
      rewritePrefix: prefix,
    });
  }

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error({ err: error }, "请求处理失败");
    return reply.code(error.statusCode ?? 500).send({
      code: "internal_error",
      message: "服务器内部错误",
    });
  });

  app.get("/api/v1/healthz", async () => {
    return healthResponseSchema.parse({
      status: "ok",
      version: SERVICE_VERSION,
      uptime: process.uptime(),
      time: new Date().toISOString(),
    });
  });

  // 同源托管客户端构建产物（容器内 /repo/apps/client/dist）；SPA 路由回退 index.html
  const clientDist = resolve(process.cwd(), "../client/dist");
  if (existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !request.url.startsWith("/api/") &&
        !request.url.startsWith("/onebot/")
      ) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ code: "not_found", message: "资源不存在" });
    });
  }

  return app;
}
