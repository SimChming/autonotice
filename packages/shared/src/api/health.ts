import { z } from "zod";

/**
 * 健康检查响应（GET /api/v1/healthz）。
 * 部署链路（CI → 容器 → deploy.sh）依赖该契约做存活判定，改动需同步 §10 决策日志。
 */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
  uptime: z.number(),
  time: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
