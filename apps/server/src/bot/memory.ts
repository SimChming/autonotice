import { desc, eq, or } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { memories } from "../db/schema.js";

const CANDIDATE_LIMIT = 200;
const TOP_K = 5;
const MIN_SCORE = 0.35;

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

async function embed(config: Config, text: string): Promise<number[] | null> {
  try {
    const response = await fetch(`${config.llm.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({ model: config.llm.embeddingModel, input: text }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as EmbeddingResponse;
    return data.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function saveMemory(
  db: Db,
  config: Config,
  sessionKey: string,
  senderQq: string,
  content: string,
  tags: string[],
): Promise<void> {
  const vector = await embed(config, content);
  db.insert(memories)
    .values({
      sessionKey,
      senderQq,
      content: content.slice(0, 120),
      tags: tags.slice(0, 3).join(","),
      embedding: JSON.stringify(vector ?? []),
      kind: "chat",
      scope: "peer",
      createdAt: Date.now(),
    })
    .run();
}

/** 同会话或同发送者的候选里暴力余弦 top5，低于阈值不注入（§4.5）。 */
export async function recallMemories(
  db: Db,
  config: Config,
  sessionKey: string,
  senderQq: string,
  query: string,
): Promise<string[]> {
  const rows = db
    .select()
    .from(memories)
    .where(or(eq(memories.sessionKey, sessionKey), eq(memories.senderQq, senderQq)))
    .orderBy(desc(memories.id))
    .limit(CANDIDATE_LIMIT)
    .all();
  if (!rows.length) {
    return [];
  }

  const queryVector = await embed(config, query);
  if (!queryVector) {
    return [];
  }

  const scored = rows
    .map((row) => {
      let vector: number[] = [];
      try {
        vector = JSON.parse(row.embedding) as number[];
      } catch {
        vector = [];
      }
      return { content: row.content, score: cosine(queryVector, vector) };
    })
    .filter((item) => item.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  return scored.map((item) => item.content);
}
