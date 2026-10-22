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

/** 后台展示/编辑的记忆条目。 */
export const adminMemorySchema = z.object({
  id: z.number().int().positive(),
  sessionKey: z.string(),
  senderQq: z.string().nullable(),
  content: z.string(),
  tags: z.array(z.string()),
  kind: z.string(),
  scope: z.string(),
  createdAt: z.string(),
});

export type AdminMemory = z.infer<typeof adminMemorySchema>;

/** 初始 prompt（当前人格默认值 + 覆盖值）与记忆列表。 */
export const adminPromptResponseSchema = z.object({
  personaId: z.string(),
  personaName: z.string(),
  defaultPrompt: z.string(),
  overridePrompt: z.string(),
  effectivePrompt: z.string(),
  memoryCount: z.number().int(),
  items: z.array(adminMemorySchema),
});

export type AdminPromptResponse = z.infer<typeof adminPromptResponseSchema>;

export const adminPromptUpdateSchema = z.object({
  overridePrompt: z.string().max(20000),
});

export type AdminPromptUpdate = z.infer<typeof adminPromptUpdateSchema>;

export const adminMemoryUpdateSchema = z.object({
  content: z.string().trim().min(1).max(500).optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(10).optional(),
});

export type AdminMemoryUpdate = z.infer<typeof adminMemoryUpdateSchema>;

/** 运维页：NapCat 入口、OneBot 实时状态与服务运行信息。 */
export const adminOpsResponseSchema = z.object({
  service: z.object({
    version: z.string(),
    uptime: z.number(),
    onebotConnected: z.boolean(),
  }),
  onebot: z.object({
    selfId: z.string().nullable(),
    nickname: z.string().nullable(),
    appVersion: z.string().nullable(),
    protocolVersion: z.string().nullable(),
  }),
  napcat: z.object({
    webuiPath: z.string(),
    account: z.string(),
    container: z.string(),
    webuiToken: z.string(),
  }),
});

export type AdminOpsResponse = z.infer<typeof adminOpsResponseSchema>;

/** 管理员 Shell：在服务端容器内执行命令。 */
export const adminShellRequestSchema = z.object({
  command: z.string().trim().min(1, "请输入命令").max(2000, "命令过长"),
});

export type AdminShellRequest = z.infer<typeof adminShellRequestSchema>;

export const adminShellResponseSchema = z.object({
  ok: z.boolean(),
  output: z.string(),
});

export type AdminShellResponse = z.infer<typeof adminShellResponseSchema>;
