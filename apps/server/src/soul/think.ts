import type { Db } from "../db/client.js";
import type { LlmClient } from "../llm/client.js";
import { renderLifeBlock, type IntentionRow } from "./life.js";
import { SOUL_INNER_PERSONA } from "./persona.js";
import { getSoulSnapshot, renderSoulBlock } from "./store.js";

function parseLoose<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export interface ThoughtDeps {
  db: Db;
  llm: LlmClient;
}

/**
 * 一次思考：带上她此刻的状态、驱力、心里的挂念、对自己的认识。
 * 独处、写作、动手前后都用同一套上下文，保证她每次都从「同一个自己」出发。
 */
export async function innerThought(
  deps: ThoughtDeps,
  instruction: string,
  intention?: IntentionRow | null,
): Promise<string> {
  const soul = getSoulSnapshot(deps.db);
  const raw = await deps.llm.chatJson([
    { role: "system", content: SOUL_INNER_PERSONA },
    {
      role: "user",
      content: `${renderSoulBlock(soul)}

${renderLifeBlock(deps.db, intention)}

${instruction}
只输出 json：{"text":"你此刻真实的想法，一到两句，口语，不要复述设定"}`,
    },
  ]);
  const parsed = parseLoose<{ text?: string }>(raw);
  return parsed?.text?.trim() ?? "";
}
