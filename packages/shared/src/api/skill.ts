import { z } from "zod";

export const skillTypeSchema = z.enum(["persona", "tool", "instruction"]);
export type SkillType = z.infer<typeof skillTypeSchema>;

export const skillPermissionSchema = z.enum(["all", "bound", "owner"]);
export type SkillPermission = z.infer<typeof skillPermissionSchema>;

/** 技能清单（管理后台读写的唯一契约）。 */
export const skillManifestSchema = z.object({
  id: z
    .string()
    .trim()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9_.-]+$/, "id 只能包含小写字母、数字、下划线、点、短横线"),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(300),
  type: skillTypeSchema,
  enabled: z.boolean(),
  prompt: z.string().max(4000).default(""),
  handler: z.string().nullable().default(null),
  permissions: skillPermissionSchema.default("all"),
  paramsSchema: z.record(z.unknown()).default({}),
  version: z.string().default("1.0.0"),
  builtin: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SkillManifest = z.infer<typeof skillManifestSchema>;

export const createSkillRequestSchema = skillManifestSchema.omit({
  builtin: true,
  createdAt: true,
  updatedAt: true,
});

export type CreateSkillRequest = z.infer<typeof createSkillRequestSchema>;

export const updateSkillRequestSchema = createSkillRequestSchema.partial();

export type UpdateSkillRequest = z.infer<typeof updateSkillRequestSchema>;

export const skillListResponseSchema = z.object({
  items: z.array(skillManifestSchema),
});

export const adminLoginRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});

export const adminLoginResponseSchema = z.object({
  token: z.string(),
});

export type AdminLoginRequest = z.infer<typeof adminLoginRequestSchema>;
export type AdminLoginResponse = z.infer<typeof adminLoginResponseSchema>;
