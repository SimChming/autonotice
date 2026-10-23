import { desc, eq, or } from "drizzle-orm";
import { OWNER_QQ } from "@autonotice/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { groups, memories } from "../db/schema.js";

const CANDIDATE_LIMIT = 200;
const TOP_K = 5;
const RECENT_ALWAYS = 3;
const MAX_ITEMS = 8;
const MIN_SCORE = 0.35;

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

export async function embedText(config: Config, text: string): Promise<number[] | null> {
  return embed(config, text);
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

/** 记忆来源：群聊/私聊、对象与时间，注入 prompt 和后台展示共用。 */
export function memorySourceLabel(
  db: Db,
  row: { sessionKey: string; senderQq: string | null; createdAt: number },
): string {
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(row.createdAt));
  const sender =
    row.senderQq === null
      ? ""
      : row.senderQq === OWNER_QQ
        ? ` · 主人(QQ${row.senderQq})`
        : ` · 发言人 QQ${row.senderQq}`;

  const groupMatch = /^group:(\d+)$/.exec(row.sessionKey);
  if (groupMatch) {
    const groupId = groupMatch[1] ?? "";
    const group = db
      .select({ name: groups.name })
      .from(groups)
      .where(eq(groups.groupId, groupId))
      .get();
    const name = group?.name?.trim() ? `「${group.name}」` : "";
    return `群聊${name}(${groupId})${sender} · ${time}`;
  }

  const privateMatch = /^private:(\d+)$/.exec(row.sessionKey);
  if (privateMatch) {
    return `私聊 QQ${privateMatch[1]}${sender} · ${time}`;
  }

  return `${row.sessionKey}${sender} · ${time}`;
}

/** 同会话或同发送者的候选里暴力余弦 top5，低于阈值不注入（§4.5）。 */
export async function recallMemories(
  db: Db,
  config: Config,
  sessionKey: string,
  senderQq: string,
  query: string,
): Promise<string[]> {
  const owner = senderQq === OWNER_QQ;
  // 隐私硬规则：非主人只能召回自己写的记忆，绝不注入群友或主人的记忆。
  const scope = owner
    ? or(eq(memories.sessionKey, sessionKey), eq(memories.senderQq, senderQq))
    : eq(memories.senderQq, senderQq);

  const rows = db
    .select()
    .from(memories)
    .where(scope)
    .orderBy(desc(memories.id))
    .limit(CANDIDATE_LIMIT)
    .all();
  if (!rows.length) {
    return [];
  }

  const selected = new Map<number, (typeof rows)[number]>();
  // 最近几条始终带上，保证模型每次回答前都能看到记忆库，而不是只依赖向量命中。
  for (const row of rows.slice(0, RECENT_ALWAYS)) {
    selected.set(row.id, row);
  }

  const queryVector = await embed(config, query);
  if (queryVector) {
    const scored = rows
      .map((row) => {
        let vector: number[] = [];
        try {
          vector = JSON.parse(row.embedding) as number[];
        } catch {
          vector = [];
        }
        return { row, score: cosine(queryVector, vector) };
      })
      .filter((item) => item.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K);
    for (const item of scored) {
      selected.set(item.row.id, item.row);
    }
  } else {
    // embedding 不可用时退化为最近记忆，避免完全读不到记忆库。
    for (const row of rows.slice(0, TOP_K)) {
      selected.set(row.id, row);
    }
  }

  return [...selected.values()]
    .slice(0, MAX_ITEMS)
    .map((row) => `[${memorySourceLabel(db, row)}] ${row.content}`);
}
