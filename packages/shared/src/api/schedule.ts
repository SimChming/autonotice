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
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ScheduleItem = z.infer<typeof scheduleItemSchema>;
