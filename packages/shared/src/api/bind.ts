import { z } from "zod";

/** 发起绑定：填写待绑定的大号 QQ。 */
export const bindStartRequestSchema = z.object({
  qq: z
    .string()
    .trim()
    .regex(/^\d{5,12}$/, "QQ 号格式不正确"),
});

export type BindStartRequest = z.infer<typeof bindStartRequestSchema>;

export const bindStartResponseSchema = z.object({
  code: z.string().length(6),
  qq: z.string(),
  expiresAt: z.string(),
  groupId: z.string(),
  instruction: z.string(),
});

export type BindStartResponse = z.infer<typeof bindStartResponseSchema>;

/** 网页端手动确认绑定码（群内大号发码后自动确认，此接口用于兜底）。 */
export const bindConfirmRequestSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "绑定码应为 6 位数字"),
});

export type BindConfirmRequest = z.infer<typeof bindConfirmRequestSchema>;

export const bindConfirmResponseSchema = z.object({
  qq: z.string(),
  verifiedAt: z.string(),
});

export type BindConfirmResponse = z.infer<typeof bindConfirmResponseSchema>;
