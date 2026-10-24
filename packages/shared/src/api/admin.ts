import { z } from "zod";

export const adminLlmSettingsSchema = z.object({
  model: z.string(),
  visionModel: z.string(),
  embeddingModel: z.string(),
  baseUrl: z.string(),
  apiKeyMasked: z.string(),
});

/** 消息额度：群聊固定上限、主人私聊不限（0=不限）、普通用户私聊上限。 */
export const adminReplySettingsSchema = z.object({
  groupLimit: z.number().int().min(1).max(50),
  ownerPrivateLimit: z.number().int().min(0).max(200),
  userPrivateLimit: z.number().int().min(1).max(50),
});

export const adminSettingsResponseSchema = z.object({
  llm: adminLlmSettingsSchema,
  reply: adminReplySettingsSchema,
});

export const adminSettingsUpdateSchema = z.object({
  model: z.string().trim().min(1).max(120).optional(),
  visionModel: z.string().trim().min(1).max(120).optional(),
  embeddingModel: z.string().trim().min(1).max(120).optional(),
  baseUrl: z.string().trim().url().optional(),
  apiKey: z.string().trim().min(1).optional(),
  groupLimit: z.number().int().min(1).max(50).optional(),
  ownerPrivateLimit: z.number().int().min(0).max(200).optional(),
  userPrivateLimit: z.number().int().min(1).max(50).optional(),
});

export type AdminSettingsUpdate = z.infer<typeof adminSettingsUpdateSchema>;

/** 客户端在线状态：同一账号可在多端并列显示。 */
export const adminPresenceSchema = z.object({
  platform: z.enum(["web", "desktop", "android"]),
  version: z.string(),
  shellVersion: z.string().nullable(),
  connectedAt: z.number(),
  lastSeen: z.number(),
});

export type AdminPresence = z.infer<typeof adminPresenceSchema>;

export const adminUserSchema = z.object({
  id: z.number().int().positive(),
  username: z.string(),
  qq: z.string().nullable(),
  role: z.enum(["owner", "user"]),
  verifiedAt: z.string().nullable(),
  createdAt: z.string(),
  /** 已绑定 QQ 的头像地址（来自 QQ 头像 CDN）。 */
  avatarUrl: z.string().nullable().optional(),
  /** 当前在线客户端列表；空数组表示离线。 */
  presence: z.array(adminPresenceSchema).default([]),
  /** 日程总数与未完成数。 */
  scheduleTotal: z.number().int().default(0),
  schedulePending: z.number().int().default(0),
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
  /** 记忆来源：群聊/私聊、对象与时间。 */
  source: z.string().optional(),
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
    /** 机器人离线时返回当前登录二维码（base64 PNG），在线时为 null。 */
    qrImage: z.string().nullable(),
    qrUpdatedAt: z.number().nullable(),
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

/** 后台用户详情：日程明细（含完成状态）与绑定群聊。 */
export const adminUserScheduleSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.string(),
  type: z.string(),
  priority: z.string(),
  groupId: z.string().nullable(),
  groupName: z.string().nullable(),
  dueAt: z.string().nullable(),
  remindAt: z.string().nullable(),
  notes: z.string(),
  updatedAt: z.string(),
});

export type AdminUserSchedule = z.infer<typeof adminUserScheduleSchema>;

export const adminUserGroupSchema = z.object({
  groupId: z.string(),
  name: z.string(),
  avatar: z.string(),
});

export const adminUserDetailResponseSchema = z.object({
  user: adminUserSchema,
  presence: z.array(adminPresenceSchema),
  schedules: z.array(adminUserScheduleSchema),
  groups: z.array(adminUserGroupSchema),
});

export type AdminUserDetailResponse = z.infer<typeof adminUserDetailResponseSchema>;

/** AI 视角：某个用户与机器人私聊的完整往来。 */
export const adminUserChatResponseSchema = z.object({
  items: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      text: z.string(),
      at: z.string(),
    }),
  ),
});

export type AdminUserChatResponse = z.infer<typeof adminUserChatResponseSchema>;

/** 管理员精准通知：指定用户或全体，可让 AI 按人格组织措辞后私聊发送。 */
export const adminNotifyRequestSchema = z.object({
  userIds: z.array(z.number().int().positive()).min(1).max(200).optional(),
  all: z.boolean().optional(),
  text: z.string().trim().min(1, "请输入要通知的内容").max(2000, "内容过长"),
  useAi: z.boolean().default(false),
});

export type AdminNotifyRequest = z.infer<typeof adminNotifyRequestSchema>;

export const adminNotifyResponseSchema = z.object({
  sent: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  failures: z.array(z.object({ userId: z.number().int(), reason: z.string() })).default([]),
});

export type AdminNotifyResponse = z.infer<typeof adminNotifyResponseSchema>;
