import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";

function read(db: Db, key: string): string | null {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

export function getRuntimeLlm(db: Db, config: Config) {
  const temperature = Number(read(db, "llm.temperature") ?? "");
  const maxTokens = Number(read(db, "llm.max_tokens") ?? "");
  return {
    baseUrl: read(db, "llm.base_url") ?? config.llm.baseUrl,
    apiKey: read(db, "llm.api_key") ?? config.llm.apiKey,
    model: read(db, "llm.model") ?? config.llm.model,
    visionModel: read(db, "llm.vision_model") ?? config.llm.visionModel,
    embeddingModel: read(db, "llm.embedding_model") ?? config.llm.embeddingModel,
    // V4.4.4：默认放开采样温度，允许她说话更有起伏；后台可覆盖。
    temperature: Number.isFinite(temperature) ? Math.min(1.5, Math.max(0, temperature)) : 0.85,
    maxTokens: Number.isFinite(maxTokens) ? Math.min(8000, Math.max(128, maxTokens)) : 3000,
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
