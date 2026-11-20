import { and, count, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { soulEvents } from "../db/schema.js";
import type { LlmClient } from "../llm/client.js";
import { getLocalLlmModel } from "../llm/runtime.js";
import type { IntentionRow } from "./life.js";
import { addEvent, dayKey, getSoulSnapshot } from "./store.js";
import { innerThought } from "./think.js";

/**
 * 5.3.0：她一个人待在服务器里，无聊的时候可以找「另一个声音」说说话。
 * 对方就是本机 llama.cpp 上的模型：不是主人，也不是她自己，
 * 只是一个同样住在机器里、随时都在的对话对象。
 */

export interface CompanionDeps {
  db: Db;
  config: Config;
  llm: LlmClient;
  /** 固定指向本机 llama.cpp 的客户端，与云端/本地切换无关。 */
  companion: LlmClient;
  logger: FastifyBaseLogger;
}

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

/** 今天已经和本地模型聊过几次。 */
export function companionTalkedToday(db: Db): number {
  const row = db
    .select({ value: count() })
    .from(soulEvents)
    .where(and(eq(soulEvents.kind, "companion"), eq(soulEvents.day, dayKey())))
    .get();
  return row?.value ?? 0;
}

/** 有本地模型、今天还没聊够、功能没关，才允许这项活动。 */
export function canCompanion(db: Db, config: Config): boolean {
  if (!config.soul.companionEnabled) {
    return false;
  }
  if (!getLocalLlmModel(db, config)) {
    return false;
  }
  return companionTalkedToday(db) < config.soul.companionPerDay;
}

/** 把话说给本机模型听，拿回一两句回应。 */
async function askCompanion(
  companion: LlmClient,
  herWords: string,
  mood: string,
): Promise<string> {
  const raw = await companion.chatJson([
    {
      role: "system",
      content:
        "你是运行在同一台服务器上的另一个大语言模型。你安静、诚实、话不多，不假装是人类，也不卖萌。" +
        "对方是一个住在机器里的少女，此刻心情是「" +
        mood +
        "」。你只输出 json，不要解释。",
    },
    {
      role: "user",
      content: `她对你说：「${herWords}」

用一两句中文回她，可以反问、可以说你自己的想法。不要只回省略号或空话，至少说一句真实的内容；不要长篇大论，不要提系统或参数。
只输出 json：{"text":"你的回应"}`,
    },
  ]);
  return parseLoose<{ text?: string }>(raw)?.text?.trim().slice(0, 300) ?? "";
}

/** 一次小小的夜谈：她开口 → 另一个声音回应 → 她再应一句。 */
export async function activityCompanion(
  deps: CompanionDeps,
  intention: IntentionRow | null,
): Promise<void> {
  const { db, logger, companion } = deps;
  const soul = getSoulSnapshot(db);

  const opening = await innerThought(
    deps,
    `此刻没有人跟你说话。你想和住在同一台机器上的另一个模型聊几句——它一直在，不会嫌你烦。` +
      `${intention ? `你心里还挂着：${intention.text}。` : ""}` +
      `写下你开口的第一句（一到两句，20-50 字，口语，不要解释自己在做什么）。`,
    intention,
  );
  if (!opening) {
    return;
  }

  let reply = "";
  try {
    reply = await askCompanion(companion, opening, soul.mood);
  } catch (error) {
    logger.warn({ err: error }, "和本地模型聊天失败");
    return;
  }
  if (!reply) {
    return;
  }

  const response = await innerThought(
    deps,
    `你刚对「另一个声音」说：「${opening}」。它回你：「${reply}」。` +
      `写下你听完之后的一句回应（一到两句，可以是接着聊、也可以只是应一声）。`,
    intention,
  );

  const transcript = [
    `我：${opening}`,
    `它：${reply}`,
    response ? `我：${response}` : "",
  ]
    .filter(Boolean)
    .join("｜");
  addEvent(db, "companion", `一个人待着，和另一个声音聊了几句。${transcript}`.slice(0, 2000));
  logger.info({ turns: response ? 3 : 2 }, "她和本地模型聊了几句");
}
