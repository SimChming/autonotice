import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { healthResponseSchema, SERVICE_VERSION } from "@autonotice/shared";
import type { Config } from "./config.js";

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
