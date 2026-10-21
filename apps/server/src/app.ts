import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import { BOT_QQ, healthResponseSchema, SERVICE_VERSION } from "@autonotice/shared";
import type { Config } from "./config.js";
import { createDatabase } from "./db/client.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBindRoutes } from "./routes/bind.js";
import { OneBotClient } from "./onebot/client.js";
import { registerOneBotWs } from "./onebot/ws.js";
import { createAtBotHandler } from "./bot/handle.js";
import type { IngestDeps } from "./pipeline/ingest.js";

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
  const ingest: IngestDeps = {
    db,
    bindGroupId: config.bind.groupId,
    onAtBot: createAtBotHandler({ botQq: BOT_QQ, client: onebot, logger: app.log }),
    logger: app.log,
  };

  registerAuthRoutes(app, { db, config });
  registerBindRoutes(app, { db, config });
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

  return app;
}
