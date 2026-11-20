import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";

function read(db: Db, key: string): string | null {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

/** 数据库里没有该项（或为空）时返回 null，避免 Number("") = 0 把参数夹到最小值。 */
function readNumber(db: Db, key: string): number | null {
  const raw = read(db, key);
  if (raw == null || raw.trim() === "") {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export type LlmProvider = "cloud" | "local";

/** 对话模型运行位置；默认云端，只有明确写入 local 才切换。 */
export function getLlmProvider(db: Db): LlmProvider {
  return read(db, "llm.provider") === "local" ? "local" : "cloud";
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** 本地 llama.cpp 的 OpenAI 兼容地址（DB 覆盖 > 环境变量）。 */
export function getLocalLlmBaseUrl(db: Db, config: Config): string {
  return normalizeBaseUrl(read(db, "llm.local_base_url") ?? config.llm.localBaseUrl);
}

/** 本地模型 id 就是 presets.ini 的 section 名，例如 Deepseek-qwen3.5-9B。 */
export function getLocalLlmModel(db: Db, config: Config): string {
  return (read(db, "llm.local_model") ?? "").trim() || config.llm.localModel;
}

/** 云端配置：向量与视觉始终走云端，不受本地模型模式影响。 */
export function getCloudLlm(db: Db, config: Config) {
  const temperature = readNumber(db, "llm.temperature");
  const maxTokens = readNumber(db, "llm.max_tokens");
  return {
    baseUrl: read(db, "llm.base_url") ?? config.llm.baseUrl,
    apiKey: read(db, "llm.api_key") ?? config.llm.apiKey,
    model: read(db, "llm.model") ?? config.llm.model,
    visionModel: read(db, "llm.vision_model") ?? config.llm.visionModel,
    embeddingModel: read(db, "llm.embedding_model") ?? config.llm.embeddingModel,
    // V4.4.4：默认放开采样温度，允许她说话更有起伏；后台可覆盖。
    temperature: temperature === null ? 0.85 : Math.min(1.5, Math.max(0, temperature)),
    maxTokens: maxTokens === null ? 3000 : Math.min(8000, Math.max(128, maxTokens)),
  };
}

/**
 * 对话模型运行时配置：云端或本地二选一。
 * 每次调用都会重新读 DB，所以后台切换后无需重启即可生效。
 */
export function getRuntimeLlm(db: Db, config: Config) {
  const cloud = getCloudLlm(db, config);
  if (getLlmProvider(db) !== "local") {
    return { ...cloud, provider: "cloud" as const };
  }
  return {
    ...cloud,
    provider: "local" as const,
    baseUrl: getLocalLlmBaseUrl(db, config),
    // llama.cpp 不校验密钥，占位即可；避免误把云端 Key 发给本机。
    apiKey: "local",
    model: getLocalLlmModel(db, config),
  };
}

export function maskKey(key: string): string {
  if (!key) {
    return "";
  }
  if (key.length <= 8) {
    return "********";
  }
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}
