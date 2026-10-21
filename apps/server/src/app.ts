import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { BOT_QQ, healthResponseSchema, SERVICE_VERSION } from "@autonotice/shared";
import type { Config } from "./config.js";
import { createDatabase } from "./db/client.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBindRoutes } from "./routes/bind.js";
import { registerScheduleRoutes } from "./routes/schedules.js";
import { OneBotClient } from "./onebot/client.js";
import { registerOneBotWs } from "./onebot/ws.js";
import { createAtBotHandler } from "./bot/handle.js";
import type { IngestDeps } from "./pipeline/ingest.js";
import { createLlmClient } from "./llm/client.js";
import { extractSchedules } from "./pipeline/extract.js";
import { mergeAndSave } from "./pipeline/merge.js";
import { NotifyHub } from "./notify/hub.js";
import { startReminderScheduler } from "./scheduler/reminders.js";

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
  app.addHook("onClose", async () => {
    sqlite.close();
  });

  const onebot = new OneBotClient();
  const llm = createLlmClient(config);
  const hub = new NotifyHub(app.log);

  const ingest: IngestDeps = {
    db,
    bindGroupId: config.bind.groupId,
    onAtBot: createAtBotHandler({ botQq: BOT_QQ, client: onebot, logger: app.log }),
    onBoundUserMessage: (userId, message, msgId) => {
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
    logger: app.log,
  };

  const reminderTask = startReminderScheduler({ db, hub, onebot, logger: app.log });
  app.addHook("onClose", async () => {
    reminderTask.stop();
  });

  registerAuthRoutes(app, { db, config });
  registerBindRoutes(app, { db, config });
  registerScheduleRoutes(app, { db });
  hub.registerRoute(app);
  registerOneBotWs(app, {
    config,
    client: onebot,
    ingest,
    botQq: BOT_QQ,
    logger: app.log,
  });

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
