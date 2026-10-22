import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";

function read(db: Db, key: string): string | null {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

export function getRuntimeLlm(db: Db, config: Config) {
  return {
    baseUrl: read(db, "llm.base_url") ?? config.llm.baseUrl,
    apiKey: read(db, "llm.api_key") ?? config.llm.apiKey,
    model: read(db, "llm.model") ?? config.llm.model,
    visionModel: read(db, "llm.vision_model") ?? config.llm.visionModel,
    embeddingModel: read(db, "llm.embedding_model") ?? config.llm.embeddingModel,
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
