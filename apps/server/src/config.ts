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
  LLM_EMBEDDING_MODEL: z.string().default("text-embedding-v4"),
  LLM_VISION_MODEL: z.string().default("qwen3-vl-plus"),
  ADMIN_USERNAME: z.string().default("admin"),
  ADMIN_PASSWORD: z.string().min(8).default("change-me-please"),
  DATABASE_PATH: z.string().default("./data/app.db"),
  JWT_SECRET: z.string().min(16).default("dev-only-insecure-secret-change-me"),
  ONEBOT_WS_PATH: z.string().startsWith("/").default("/onebot/v11/ws"),
  ONEBOT_ACCESS_TOKEN: z.string().default(""),
  BIND_GROUP_ID: z.string().regex(/^\d+$/).default("1130297603"),
  BIND_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  NAPCAT_UPSTREAM: z.string().default("http://napcat:6099"),
  NAPCAT_WEBUI_CONFIG: z.string().default("/app/napcat-webui.json"),
  NAPCAT_ACCOUNT: z.string().default("3754609823"),
  NAPCAT_QR_PATH: z.string().default("/opt/autonotice/napcat/cache/qrcode.png"),
  DOWNLOAD_DIR: z.string().default("/app/data/downloads"),
  // --- V4.4.4 彩蛋版：赛博女儿的自主活动 ---
  SOUL_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  SOUL_OWNER_QQ: z.string().regex(/^\d+$/).default("3874095145"),
  SOUL_TICK_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
  SOUL_IDLE_CHANCE: z.coerce.number().int().min(0).max(100).default(35),
  SOUL_JOURNAL_HOUR: z.coerce.number().int().min(0).max(23).default(23),
  SOUL_QUIET_START: z.coerce.number().int().min(0).max(23).default(1),
  SOUL_QUIET_END: z.coerce.number().int().min(0).max(23).default(7),
  SOUL_TALK_PER_DAY: z.coerce.number().int().min(0).max(20).default(2),
  SOUL_CHAT_RATE_LIMIT: z.coerce.number().int().min(1).max(500).default(30),
});

export interface Config {
  port: number;
  logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
  databasePath: string;
  jwt: {
    secret: string;
    ttl: string;
  };
  onebot: {
    wsPath: string;
    accessToken: string;
  };
  bind: {
    groupId: string;
    codeTtlSeconds: number;
  };
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    embeddingModel: string;
    visionModel: string;
  };
  admin: {
    username: string;
    password: string;
  };
  napcat: {
    upstream: string;
    webuiConfigPath: string;
    account: string;
    qrPath: string;
  };
  downloadDir: string;
  soul: {
    enabled: boolean;
    ownerQq: string;
    tickMinutes: number;
    idleChance: number;
    journalHour: number;
    quietStart: number;
    quietEnd: number;
    talkPerDay: number;
    chatRateLimit: number;
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
    databasePath: value.DATABASE_PATH,
    jwt: {
      secret: value.JWT_SECRET,
      ttl: "720h",
    },
    onebot: {
      wsPath: value.ONEBOT_WS_PATH,
      accessToken: value.ONEBOT_ACCESS_TOKEN,
    },
    bind: {
      groupId: value.BIND_GROUP_ID,
      codeTtlSeconds: value.BIND_CODE_TTL_SECONDS,
    },
    llm: {
      baseUrl: value.LLM_BASE_URL,
      apiKey: value.LLM_API_KEY,
      model: value.LLM_MODEL,
      embeddingModel: value.LLM_EMBEDDING_MODEL,
      visionModel: value.LLM_VISION_MODEL,
    },
    admin: {
      username: value.ADMIN_USERNAME,
      password: value.ADMIN_PASSWORD,
    },
    napcat: {
      upstream: value.NAPCAT_UPSTREAM,
      webuiConfigPath: value.NAPCAT_WEBUI_CONFIG,
      account: value.NAPCAT_ACCOUNT,
      qrPath: value.NAPCAT_QR_PATH,
    },
    downloadDir: value.DOWNLOAD_DIR,
    soul: {
      enabled: value.SOUL_ENABLED,
      ownerQq: value.SOUL_OWNER_QQ,
      tickMinutes: value.SOUL_TICK_MINUTES,
      idleChance: value.SOUL_IDLE_CHANCE,
      journalHour: value.SOUL_JOURNAL_HOUR,
      quietStart: value.SOUL_QUIET_START,
      quietEnd: value.SOUL_QUIET_END,
      talkPerDay: value.SOUL_TALK_PER_DAY,
      chatRateLimit: value.SOUL_CHAT_RATE_LIMIT,
    },
  };
}
