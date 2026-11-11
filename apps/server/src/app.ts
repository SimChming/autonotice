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
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAdminOpsRoutes } from "./routes/admin-ops.js";
import { seedSkills } from "./skills/registry.js";
import { OneBotClient } from "./onebot/client.js";
import { registerOneBotWs } from "./onebot/ws.js";
import { createBotHandlers } from "./bot/handle.js";
import type { IngestDeps } from "./pipeline/ingest.js";
import { createLlmClient } from "./llm/client.js";
import { getRuntimeLlm } from "./llm/runtime.js";
import { NotifyHub } from "./notify/hub.js";
import { startOneBotWatchdog } from "./notify/onebot-watchdog.js";
import { fireEventTriggers, startTriggerScheduler } from "./triggers/executor.js";
import { AdminChatHub } from "./admin/chat-hub.js";
import { registerAdminChatRoutes } from "./admin/chat-routes.js";
import { ensureGroup, refreshGroupInfo } from "./services/groups.js";
import { ensureAdmin } from "./services/admin.js";
import { warnIfLeakedKey } from "./security/leaked-key.js";
import { createSoulLoop } from "./soul/idle.js";
import { registerSoulRoutes } from "./soul/routes.js";
import { SOUL_PAGE_HTML } from "./soul/page.js";

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
  // 密钥一旦泄露就应视为已泄露：启动时提醒轮换（只比对指纹，不打印密钥）。
  warnIfLeakedKey([config.llm.apiKey, getRuntimeLlm(db, config).apiKey], app.log);
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
    // V4.4.4 不再做日程抽取，普通群消息只入库供上下文与触发器使用。
    onBoundUserMessage: () => undefined,
    onGroupMessageEvent: (sessionKey, text) => {
      void fireEventTriggers(triggerContext, sessionKey, text).catch((error: unknown) => {
        app.log.warn({ err: error }, "事件触发器处理失败");
      });
    },
    onGroupSeen: (groupId) => {
      ensureGroup(db, groupId);
      void refreshGroupInfo(onebot, db, groupId, app.log).catch((error: unknown) => {
        app.log.warn({ err: error, groupId }, "补全群信息失败");
      });
    },
    onBindConfirmed: () => undefined,
    logger: app.log,
  };

  const triggerTask = startTriggerScheduler(triggerContext);
  const onebotWatchdog = startOneBotWatchdog({ db, hub, onebot, logger: app.log });
  const soulLoop = createSoulLoop({ db, config, llm, onebot, logger: app.log });
  soulLoop.start();
  app.addHook("onClose", async () => {
    triggerTask.stop();
    onebotWatchdog.stop();
    soulLoop.stop();
  });

  registerAdminRoutes(app, { db, config, onebot, hub, llm });
  registerAdminOpsRoutes(app, { db, config, onebot });
  adminChatHub.registerRoute(app);
  registerAdminChatRoutes(app, { db, onebot, hub: adminChatHub, bot });
  registerSoulRoutes(app, { db, config, llm, loop: soulLoop, logger: app.log });
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

  // V4.4.4：用户端下线，根路径直接进主人的「她的房间」。
  app.get("/soul", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(SOUL_PAGE_HTML);
  });
  // 用 onRequest 抢先处理根路径：@fastify/static 会占用 GET /，不能再注册同名路由。
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" && request.url.split("?")[0] === "/") {
      return reply.redirect("/soul");
    }
    return undefined;
  });

  // 同源托管客户端构建产物（容器内 /repo/apps/client/dist）；SPA 路由回退 index.html
  const clientDist = resolve(process.cwd(), "../client/dist");
  if (existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !request.url.startsWith("/api/") &&
        !request.url.startsWith("/onebot/") &&
        !request.url.startsWith("/downloads/")
      ) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ code: "not_found", message: "资源不存在" });
    });
  }

  // 安装包直链：客户端更新按钮从这里下载（不依赖 GitHub 可达性）。
  if (existsSync(config.downloadDir)) {
    await app.register(fastifyStatic, {
      root: config.downloadDir,
      prefix: "/downloads/",
      decorateReply: false,
    });
  }

  return app;
}
