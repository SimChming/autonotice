import { z } from "zod";

/** 注册请求：用户名仅字母数字下划线，密码至少 8 位。 */
export const registerRequestSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "用户名至少 3 位")
    .max(32, "用户名最多 32 位")
    .regex(/^[a-zA-Z0-9_]+$/, "用户名只能包含字母、数字、下划线"),
  password: z.string().min(8, "密码至少 8 位").max(72, "密码最多 72 位"),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/** 登录请求。 */
export const loginRequestSchema = z.object({
  username: z.string().trim().min(1).max(32),
  password: z.string().min(1).max(72),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** 登录/注册成功响应。binding 由服务端返回，换端登录无需重新绑定。 */
export const authResponseSchema = z.object({
  token: z.string(),
  user: z.object({
    id: z.number().int().positive(),
    username: z.string(),
  }),
  binding: z
    .object({
      qq: z.string(),
      verifiedAt: z.string(),
    })
    .nullable()
    .optional(),
});

export type AuthResponse = z.infer<typeof authResponseSchema>;
