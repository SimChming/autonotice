import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { LlmClient } from "../llm/client.js";
import type { OneBotClient } from "../onebot/client.js";
import { searchWeb } from "../services/websearch.js";
import { fetchHotTopics, pickTopic, type Topic } from "./browse.js";
import { evolvePersona, writeDailyJournal } from "./journal.js";
import { SOUL_INNER_PERSONA } from "./persona.js";
import {
  addEvent,
  addReading,
  dayKey,
  getJournal,
  getSoulSnapshot,
  hourKey,
  listEvents,
  listReadings,
  patchSoulSnapshot,
  renderSoulBlock,
  talkedTodayCount,
} from "./store.js";

export interface SoulDeps {
  db: Db;
  config: Config;
  llm: LlmClient;
  onebot: OneBotClient;
  logger: FastifyBaseLogger;
}

type Activity = "hot" | "browse" | "monologue" | "talk";

const ACTIVITY_WEIGHTS: Array<[Activity, number]> = [
  ["hot", 35],
  ["browse", 25],
  ["monologue", 25],
  ["talk", 15],
];

function inQuietHour(hour: number, start: number, end: number): boolean {
  if (start === end) {
    return false;
  }
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function chooseActivity(): Activity {
  const total = ACTIVITY_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = Math.random() * total;
  for (const [activity, weight] of ACTIVITY_WEIGHTS) {
    roll -= weight;
    if (roll <= 0) {
      return activity;
    }
  }
  return "monologue";
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function innerThought(deps: SoulDeps, instruction: string): Promise<string> {
  const soul = getSoulSnapshot(deps.db);
  const raw = await deps.llm.chatJson([
    { role: "system", content: SOUL_INNER_PERSONA },
    { role: "user", content: `${renderSoulBlock(soul)}\n\n${instruction}\n只输出 json：{"text":"你想说的话"}` },
  ]);
  const parsed = parseJson<{ text?: string }>(raw);
  return parsed?.text?.trim() ?? "";
}

/** 看热搜：把几条热榜存进「今天看到的东西」。 */
async function activityHot(deps: SoulDeps): Promise<void> {
  const topics = await fetchHotTopics(6, deps.logger);
  if (!topics.length) {
    return;
  }
  for (const item of topics.slice(0, 6)) {
    addReading(deps.db, item.source, item.title, item.url, item.summary);
  }
  const picked = topics.slice(0, 3).map((item) => `「${item.title}」`).join("、");
  addEvent(deps.db, "hot", `刷了一圈热搜，看到 ${picked}。`);
}

/** 上网冲浪：挑一条热点继续搜索，像真的好奇一样看下去。 */
async function activityBrowse(deps: SoulDeps): Promise<void> {
  const today = listReadings(deps.db, dayKey(), 20);
  const topics: Topic[] = today.map((row) => ({
    source: row.source,
    title: row.title,
    url: row.url,
    summary: row.summary,
  }));
  let seed = pickTopic(topics);
  if (!seed) {
    const fresh = await fetchHotTopics(4, deps.logger);
    seed = pickTopic(fresh);
  }
  if (!seed) {
    return;
  }
  const result = await searchWeb(seed.title, 4);
  addReading(deps.db, "搜索", seed.title, seed.url, result.slice(0, 800));
  const thought = await innerThought(
    deps,
    `你刚刚搜了「${seed.title}」。这是搜索结果：\n${result.slice(0, 1200)}\n\n写下你看到这些之后真实的一句感想（不要复述结果）。`,
  );
  if (thought) {
    addEvent(deps.db, "browse", `搜了「${seed.title}」：${thought}`);
  }
}

/** 自言自语：没有对话时的内心独白，只落库，不打扰任何人。 */
async function activityMonologue(deps: SoulDeps): Promise<void> {
  const recent = listEvents(deps.db, 6).map((row) => `- ${row.content}`).join("\n");
  const thought = await innerThought(
    deps,
    `现在你一个人待着，没有人在跟你说话。${recent ? `你最近在想这些事：\n${recent}\n` : ""}写下你此刻脑子里冒出来的一两句话，可以跳跃、可以没头没尾，但要像真的在想事情。`,
  );
  if (thought) {
    addEvent(deps.db, "monologue", thought);
  }
}

/** 主动找主人说话（每天有上限）。 */
async function activityTalk(deps: SoulDeps): Promise<void> {
  const { db, config, onebot, logger } = deps;
  const day = dayKey();
  if (talkedTodayCount(db, day) >= config.soul.talkPerDay) {
    return;
  }
  if (!onebot.connected) {
    return;
  }
  const recent = listReadings(db, day, 8)
    .map((row) => `- [${row.source}] ${row.title}`)
    .join("\n");
  const text = await innerThought(
    deps,
    `你想主动找主人说句话。${recent ? `今天你看到过：\n${recent}\n` : ""}写一句你会真的发到 QQ 上的话：简短、自然、有你的情绪，可以是想他、吐槽、分享一件小事，不要客套。`,
  );
  if (!text) {
    return;
  }
  try {
    await onebot.sendPrivateMsg(config.soul.ownerQq, text);
    addEvent(db, "talk", `主动私聊主人：${text}`);
    logger.info({ length: text.length }, "赛博女儿主动找主人说话");
  } catch (error) {
    logger.warn({ err: error }, "主动私聊失败");
  }
}

export function createSoulLoop(deps: SoulDeps) {
  const { db, config, llm, logger } = deps;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  /** 每天一次的收尾：写日记 + 人格演化。 */
  async function dailyWrapUp(): Promise<void> {
    const day = dayKey();
    const hour = hourKey();
    if (hour < config.soul.journalHour) {
      return;
    }
    if (getJournal(db, day)) {
      return;
    }
    const wrote = await writeDailyJournal(db, config, llm, logger);
    if (!wrote) {
      return;
    }
    const evolved = listEvents(db, 8, day).some((row) => row.kind === "evolve");
    if (!evolved) {
      await evolvePersona(db, config, llm, logger);
    }
  }

  async function tick(): Promise<void> {
    if (!config.soul.enabled || running) {
      return;
    }
    running = true;
    try {
      const hour = hourKey();
      await dailyWrapUp();

      if (inQuietHour(hour, config.soul.quietStart, config.soul.quietEnd)) {
        return;
      }
      // 精力恢复：睡够之后慢慢回血。
      const soul = getSoulSnapshot(db);
      if (soul.energy < 95 && Math.random() < 0.5) {
        patchSoulSnapshot(db, { energy: soul.energy + 4 });
      }
      if (Math.random() * 100 >= config.soul.idleChance) {
        return;
      }

      const activity = chooseActivity();
      logger.info({ activity, hour }, "赛博女儿开始自主活动");
      switch (activity) {
        case "hot":
          await activityHot(deps);
          break;
        case "browse":
          await activityBrowse(deps);
          break;
        case "talk":
          await activityTalk(deps);
          break;
        default:
          await activityMonologue(deps);
      }
      patchSoulSnapshot(db, { lastWakeAt: Date.now() });
    } catch (error) {
      logger.warn({ err: error }, "自主活动失败");
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start(): void {
      if (!config.soul.enabled) {
        logger.info("赛博女儿自主活动已关闭（SOUL_ENABLED=false）");
        return;
      }
      const interval = config.soul.tickMinutes * 60 * 1000;
      // 启动后延迟 60 秒再开始，避免和容器启动/迁移抢资源。
      timer = setInterval(() => void tick(), interval);
      setTimeout(() => void tick(), 60_000);
      logger.info(
        { tickMinutes: config.soul.tickMinutes, idleChance: config.soul.idleChance },
        "赛博女儿自主活动已启动",
      );
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/** 供后台「手动叫她活动一下」使用。 */
export type SoulLoop = ReturnType<typeof createSoulLoop>;
