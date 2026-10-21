import { z } from "zod";

/**
 * 环境变量唯一入口：zod 解析后导出类型安全的 Config。
 * 注意：Phase 7 起运行时配置以 DB settings 表为准（DB > .env），本文件只提供启动默认值。
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().max(65535).default(8080),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  LLM_BASE_URL: z.string().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().default("deepseek-v4.1-flash"),
});

export interface Config {
  port: number;
  logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`环境变量校验失败 -> ${detail}`);
  }

  const value = parsed.data;
  return {
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    llm: {
      baseUrl: value.LLM_BASE_URL,
      apiKey: value.LLM_API_KEY,
      model: value.LLM_MODEL,
    },
  };
}
