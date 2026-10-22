import { z } from "zod";

/** 用户绑定的群聊；name/avatar 由服务端从 OneBot 群信息或群号头像地址填充。 */
export const groupItemSchema = z.object({
  groupId: z.string(),
  name: z.string(),
  avatar: z.string(),
  boundAt: z.string().optional(),
});

export type GroupItem = z.infer<typeof groupItemSchema>;

export const groupListResponseSchema = z.object({
  items: z.array(groupItemSchema),
});

export const bindGroupRequestSchema = z.object({
  groupId: z
    .string()
    .trim()
    .regex(/^\d{5,12}$/, "群号格式不正确"),
});

export type BindGroupRequest = z.infer<typeof bindGroupRequestSchema>;

export const bindGroupResponseSchema = z.object({
  group: groupItemSchema,
});

export type BindGroupResponse = z.infer<typeof bindGroupResponseSchema>;
