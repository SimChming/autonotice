import { and, desc, eq, gte } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { botHistory } from "../db/schema.js";
import type { LlmClient } from "../llm/client.js";
import { SOUL_INNER_PERSONA } from "./persona.js";
import {
  addEvent,
  dayKey,
  getJournal,
  getSoulSnapshot,
  listEvents,
  listReadings,
  patchSoulSnapshot,
  renderSoulBlock,
  upsertJournal,
  type SoulTraits,
} from "./store.js";

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00+08:00`);
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * 写当天日记。ferce=true 时即使当天已有日记也会重写。
 * 返回是否真的写入了新内容。
 */
export async function writeDailyJournal(
  db: Db,
  _config: Config,
  llm: LlmClient,
  logger: FastifyBaseLogger,
  force = false,
): Promise<boolean> {
  const day = dayKey();
  if (!force && getJournal(db, day)) {
    return false;
  }

  const readings = listReadings(db, day, 25);
  const events = listEvents(db, 20, day).filter((item) => item.kind !== "journal");
  const chats = db
    .select()
    .from(botHistory)
    .where(and(gte(botHistory.createdAt, dayStart(day)), eq(botHistory.role, "user")))
    .orderBy(desc(botHistory.id))
    .limit(30)
    .all();

  const soul = getSoulSnapshot(db);
  const readingText = readings.length
    ? readings.map((item) => `- [${item.source}] ${item.title}：${item.summary}`).join("\n")
    : "（今天没看到什么特别的东西）";
  const eventText = events.length
    ? events.map((item) => `- （${item.kind}）${item.content}`).join("\n")
    : "（今天大部分时间在发呆）";
  const chatText = chats.length
    ? chats
        .slice()
        .reverse()
        .map((item) => `- QQ${item.senderQq ?? "?"}: ${item.text.slice(0, 120)}`)
        .join("\n")
    : "（今天没怎么和人说话）";

  try {
    const raw = await llm.chatJson([
      { role: "system", content: SOUL_INNER_PERSONA },
      {
        role: "user",
        content: `${renderSoulBlock(soul)}

【今天看到的东西】
${readingText}

【今天发生的事】
${eventText}

【今天和人的对话】
${chatText}

请写一篇今天的日记。要求：
- 第一人称，像真的日记，200-400 字；
- 写下今天真实的感受、想法、在意的小事，不要罗列新闻；
- 可以有情绪起伏、自言自语、对主人的想念或抱怨；
- 不要写成汇报，不要提"系统""模型"。
只输出 json：{"title":"日记标题（≤20字）","body":"日记正文","mood":"写完这篇时的心情（4-8字）"}`,
      },
    ]);
    const parsed = safeJson<{ title?: string; body?: string; mood?: string }>(raw);
    if (!parsed?.body?.trim()) {
      return false;
    }
    upsertJournal(db, day, parsed.title ?? `${day} 的日记`, parsed.body.trim(), parsed.mood ?? soul.mood);
    addEvent(db, "journal", `写了 ${day} 的日记：${parsed.title ?? ""}`);
    // 写日记本身也会轻微影响心情。
    patchSoulSnapshot(db, {
      mood: parsed.mood?.slice(0, 40) || soul.mood,
      moodIntensity: Math.min(100, soul.moodIntensity + 8),
    });
    return true;
  } catch (error) {
    logger.warn({ err: error, day }, "写日记失败");
    return false;
  }
}

interface EvolveResult {
  traits?: Partial<Record<keyof SoulTraits, number>>;
  mood?: string;
  moodIntensity?: number;
  note?: string;
}

/**
 * 人格演化：根据今天接触的信息与经历，微调人格向量（每天一次，幅度小）。
 * 这是「人格问卷随接触的信息增减」的实现。
 */
export async function evolvePersona(
  db: Db,
  _config: Config,
  llm: LlmClient,
  logger: FastifyBaseLogger,
): Promise<void> {
  const day = dayKey();
  const soul = getSoulSnapshot(db);
  const readings = listReadings(db, day, 15);
  const events = listEvents(db, 15, day);

  const readingText = readings.length
    ? readings.map((item) => `- [${item.source}] ${item.title}：${item.summary}`).join("\n")
    : "（没有什么特别的信息）";
  const eventText = events.length
    ? events.map((item) => `- （${item.kind}）${item.content.slice(0, 120)}`).join("\n")
    : "（平淡的一天）";

  try {
    const raw = await llm.chatJson([
      { role: "system", content: "你是角色性格模拟器，只输出 json。" },
      {
        role: "user",
        content: `${renderSoulBlock(soul)}

【今天接触到的信息】
${readingText}

【今天的经历】
${eventText}

假设你是一个会被人和事影响的少女。请你判断：今天这些信息和经历，会让你的性格往哪个方向变化？
规则：
- 每个维度最多变化 ±3，多数维度应该是 0；
- 只有真的被触动才调整，不要为了变化而变化；
- 心情可以有更明显的变化（-20..+20 的浓度）。
输出 json：
{"traits":{"curiosity":0,"warmth":0,"clinginess":0,"playfulness":0,"melancholy":0,"rationality":0,"vitality":0},"mood":"此刻心情（4-8字）","moodIntensity":50,"note":"一句话说明为什么这样变化"}`,
      },
    ]);
    const parsed = safeJson<EvolveResult>(raw);
    if (!parsed) {
      return;
    }
    const traits: Partial<SoulTraits> = {};
    for (const key of Object.keys(soul.traits) as Array<keyof SoulTraits>) {
      const delta = Number(parsed.traits?.[key]);
      if (Number.isFinite(delta) && delta !== 0) {
        traits[key] = Math.max(-3, Math.min(3, Math.round(delta)));
      }
    }
    const moodIntensity = Number.isFinite(parsed.moodIntensity)
      ? Math.max(0, Math.min(100, Math.round(parsed.moodIntensity as number)))
      : soul.moodIntensity;
    patchSoulSnapshot(db, {
      traits,
      mood: parsed.mood?.slice(0, 40) || soul.mood,
      moodIntensity,
    });
    if (parsed.note?.trim()) {
      addEvent(db, "evolve", parsed.note.trim().slice(0, 300));
    }
  } catch (error) {
    logger.warn({ err: error }, "人格演化失败");
  }
}
