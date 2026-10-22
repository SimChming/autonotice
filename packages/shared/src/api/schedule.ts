import { z } from "zod";

export const scheduleTypeSchema = z.enum(["task", "exam", "meeting", "other"]);
export type ScheduleType = z.infer<typeof scheduleTypeSchema>;

export const schedulePrioritySchema = z.enum(["high", "normal", "low"]);
export type SchedulePriority = z.infer<typeof schedulePrioritySchema>;

export const scheduleStatusSchema = z.enum(["pending", "done", "cancelled"]);
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

/** 日程条目（GET/POST/PATCH /api/v1/schedules 共用）。时间统一 ISO 字符串。 */
export const scheduleItemSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  type: scheduleTypeSchema,
  priority: schedulePrioritySchema,
  status: scheduleStatusSchema,
  dueAt: z.string().nullable(),
  remindAt: z.string().nullable(),
  notes: z.string(),
  groupId: z.string().nullable(),
  /** 来源群名称（服务端联表 groups 填充）；群名未知时为 null。 */
  groupName: z.string().nullable().optional(),
  /** 来源群头像 URL。 */
  groupAvatar: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ScheduleItem = z.infer<typeof scheduleItemSchema>;

const isoOrNull = z.string().datetime({ offset: true }).nullable();

export const createScheduleRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  type: scheduleTypeSchema.default("task"),
  priority: schedulePrioritySchema.default("normal"),
  dueAt: isoOrNull.optional(),
  remindAt: isoOrNull.optional(),
  notes: z.string().max(1000).default(""),
  groupId: z.string().nullable().optional(),
});

export type CreateScheduleRequest = z.infer<typeof createScheduleRequestSchema>;

export const updateScheduleRequestSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  type: scheduleTypeSchema.optional(),
  priority: schedulePrioritySchema.optional(),
  status: scheduleStatusSchema.optional(),
  dueAt: isoOrNull.optional(),
  remindAt: isoOrNull.optional(),
  notes: z.string().max(1000).optional(),
});

export type UpdateScheduleRequest = z.infer<typeof updateScheduleRequestSchema>;

export const scheduleListResponseSchema = z.object({
  items: z.array(scheduleItemSchema),
});

export const alertItemSchema = z.object({
  id: z.number().int().positive(),
  scheduleId: z.number().int().nullable(),
  level: z.string(),
  title: z.string(),
  body: z.string(),
  at: z.string(),
  sentAt: z.string().nullable(),
});

export const alertListResponseSchema = z.object({
  items: z.array(alertItemSchema),
});

export type AlertItem = z.infer<typeof alertItemSchema>;

