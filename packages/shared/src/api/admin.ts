import { z } from "zod";

export const adminLlmSettingsSchema = z.object({
  model: z.string(),
  visionModel: z.string(),
  embeddingModel: z.string(),
  baseUrl: z.string(),
  apiKeyMasked: z.string(),
});

export const adminSettingsResponseSchema = z.object({
  llm: adminLlmSettingsSchema,
});

export const adminSettingsUpdateSchema = z.object({
  model: z.string().trim().min(1).max(120).optional(),
  visionModel: z.string().trim().min(1).max(120).optional(),
  embeddingModel: z.string().trim().min(1).max(120).optional(),
  baseUrl: z.string().trim().url().optional(),
  apiKey: z.string().trim().min(1).optional(),
});

export type AdminSettingsUpdate = z.infer<typeof adminSettingsUpdateSchema>;

export const adminUserSchema = z.object({
  id: z.number().int().positive(),
  username: z.string(),
  qq: z.string().nullable(),
  role: z.enum(["owner", "user"]),
  verifiedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const adminUserListResponseSchema = z.object({
  items: z.array(adminUserSchema),
});

export const adminOverviewResponseSchema = z.object({
  users: z.number().int(),
  bindings: z.number().int(),
  schedules: z.number().int(),
  messages: z.number().int(),
  skills: z.number().int(),
  onebotConnected: z.boolean(),
  uptime: z.number(),
  version: z.string(),
});

export type AdminOverviewResponse = z.infer<typeof adminOverviewResponseSchema>;
