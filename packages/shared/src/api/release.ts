import { z } from "zod";

/** 客户端更新信息：服务端版本 + 各平台安装包直链。 */
export const releaseResponseSchema = z.object({
  version: z.string(),
  notes: z.string().nullable(),
  downloads: z.object({
    android: z.string().nullable(),
    windowsExe: z.string().nullable(),
    windowsMsi: z.string().nullable(),
  }),
});

export type ReleaseResponse = z.infer<typeof releaseResponseSchema>;
