import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import type { LlmClient } from "../llm/client.js";
import type { OneBotClient } from "../onebot/client.js";
import { searchWeb } from "../services/websearch.js";
import { fetchHotTopics, pickTopic, type Topic } from "./browse.js";
import { evolvePersona, writeDailyJournal } from "./journal.js";
import {
  didRecently,
  driftDrives,
  ensureIntentions,
  KIND_LABELS,
  maybeReflect,
  pickIntention,
  progressIntention,
  relieveDrive,
  topDrives,
  type DriveName,
  type IntentionKind,
  type IntentionRow,
} from "./life.js";
import { activityHands } from "./hands.js";
import { activityCompanion, canCompanion } from "./companion.js";
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
  relaxMood,
  talkedTodayCount,
} from "./store.js";
import { innerThought } from "./think.js";

export interface SoulDeps {
  db: Db;
  config: Config;
  llm: LlmClient;
  /** 固定连本机 llama.cpp 的客户端，用于无聊时聊天。 */
  companion: LlmClient;
  onebot: OneBotClient;
  logger: FastifyBaseLogger;
  /** 5.4.0：把「她醒了」交给仿人闭环内核，由触发器和分类器决定下一步。 */
  onTick?: (payload: {
    quiet: boolean;
    hour: number;
    topDrive?: string;
    topLevel?: number;
  }) => void;
}

type Activity = "hot" | "browse" | "monologue" | "talk" | "rest" | "hands" | "companion";

function inQuietHour(hour: number, start: number, end: number): boolean {
  if (start === end) {
    return false;
  }
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 最渴的那项驱力决定她大概想干什么。
 * 不是纯随机：好奇高就去冲浪，想说话高就找人，累就去歇着。
 */
function chooseActivity(drive: DriveName, quiet: boolean, canTalk: boolean): Activity {
  if (drive === "rest" && Math.random() < 0.6) {
    return "rest";
  }
  if (drive === "connection") {
    if (canTalk && !quiet && Math.random() < 0.7) {
      return "talk";
    }
    return Math.random() < 0.5 ? "monologue" : "browse";
  }
  if (drive === "expression") {
    return Math.random() < 0.75 ? "monologue" : "hot";
  }
  if (drive === "novelty") {
    return Math.random() < 0.7 ? "browse" : "hot";
  }
  // curiosity
  return Math.random() < 0.55 ? "browse" : "hot";
}

/** 推进挂念：让模型判断这次经历有没有让她更靠近答案。 */
async function advanceIntention(
  deps: SoulDeps,
  intention: IntentionRow | null,
  experience: string,
): Promise<void> {
  if (!intention) {
    return;
  }
  const raw = await deps.llm.chatJson([
    {
      role: "system",
      content: "你在模拟一个人的内心。只输出 json，全部中文。",
    },
    {
      role: "user",
      content: `她心里挂着一件${KIND_LABELS[intention.kind as IntentionKind] ?? "事"}：「${intention.text}」
之前的进展：
${intention.progress || "（还没有进展）"}

刚才她经历了：
${experience.slice(0, 800)}

判断：这件事现在算不算有进展、或者已经想通了？
- 有推进就写一句她新知道的（20-40 字，第一人称）；
- 如果这件事真的了结了，done 填 true；
- 如果毫无关系，progress 留空。
输出 json：{"progress":"……","done":false}`,
    },
  ]);
  const parsed = parseLoose<{ progress?: string; done?: boolean }>(raw);
  const progress = String(parsed?.progress ?? "").trim();
  const done = parsed?.done === true;
  if (progress || done) {
    progressIntention(deps.db, intention.id, progress, done);
    if (done) {
      addEvent(deps.db, "intention", `心里的「${intention.text}」终于有了着落。`);
    }
  }
}

/** 看热搜：优先挑和她正在惦记的事相关的那条。 */
export async function activityHot(deps: SoulDeps, intention: IntentionRow | null): Promise<void> {
  const topics = await fetchHotTopics(6, deps.logger);
  if (!topics.length) {
    return;
  }
  for (const item of topics.slice(0, 6)) {
    addReading(deps.db, item.source, item.title, item.url, item.summary);
  }
  const picked = topics.slice(0, 3).map((item) => `「${item.title}」`).join("、");
  let focus: Topic | null = null;
  if (intention) {
    const keyword = intention.text.replace(/[想弄明白是不是为什么关于的\s]/g, "").slice(0, 6);
    if (keyword) {
      focus = topics.find((item) => item.title.includes(keyword.slice(0, 3))) ?? null;
    }
  }
  const thought = await innerThought(
    deps,
    `你刚刷了一圈热搜，看到 ${picked}。${
      focus ? `其中「${focus.title}」和你心里挂着的事有关。` : ""
    }写下你看到这些之后真实的一句反应（可以联想到自己、想到主人、或只是吐槽）。`,
    intention,
  );
  if (thought) {
    addEvent(deps.db, "hot", thought);
  }
}

/** 上网冲浪：如果心里有没搞懂的问题，就顺着它继续查。 */
export async function activityBrowse(deps: SoulDeps, intention: IntentionRow | null): Promise<void> {
  const today = listReadings(deps.db, dayKey(), 20);
  const topics: Topic[] = today.map((row) => ({
    source: row.source,
    title: row.title,
    url: row.url,
    summary: row.summary,
  }));

  let query = "";
  if (intention && (intention.kind === "question" || intention.kind === "goal")) {
    query = intention.text;
  }
  let seed = pickTopic(topics);
  if (!query && !seed) {
    const fresh = await fetchHotTopics(4, deps.logger);
    seed = pickTopic(fresh);
    query = seed?.title ?? "";
  }
  if (!query) {
    query = seed?.title ?? "";
  }
  if (!query) {
    return;
  }

  const result = await searchWeb(query, 4);
  addReading(deps.db, "搜索", query, seed?.url ?? "", result.slice(0, 800));
  const thought = await innerThought(
    deps,
    `你搜了「${query}」。这是看到的内容：\n${result.slice(0, 1200)}\n\n写下你看到这些之后真实的一句感想，不要复述搜索结果。`,
    intention,
  );
  if (thought) {
    addEvent(deps.db, "browse", thought);
  }
  await advanceIntention(deps, intention, `搜索「${query}」看到：${result.slice(0, 500)}`);
}

/** 自言自语：承接上一次的思绪，而不是每次重新发呆。 */
export async function activityMonologue(deps: SoulDeps, intention: IntentionRow | null): Promise<void> {
  const recent = listEvents(deps.db, 5)
    .filter((row) => row.kind === "monologue" || row.kind === "reflect")
    .map((row) => `- ${row.content.slice(0, 120)}`)
    .join("\n");
  const thought = await innerThought(
    deps,
    `现在没人跟你说话，你一个人待着。${recent ? `你之前的思绪是：\n${recent}\n` : ""}接着往下想，写一两句此刻脑子里冒出来的话。可以跳跃、可以没头没尾，但要是接着刚才的思路，不是重新开始。`,
    intention,
  );
  if (thought) {
    addEvent(deps.db, "monologue", thought);
  }
}

/** 主动找主人说话（每天有上限，且不打扰安静时段）。 */
export async function activityTalk(deps: SoulDeps, intention: IntentionRow | null): Promise<void> {
  const { db, config, onebot, logger } = deps;
  const day = dayKey();
  if (talkedTodayCount(db, day) >= config.soul.talkPerDay) {
    return;
  }
  if (!onebot.connected) {
    return;
  }
  const recent = listReadings(db, day, 6)
    .map((row) => `- [${row.source}] ${row.title}`)
    .join("\n");
  const text = await innerThought(
    deps,
    `你很想找主人说句话。${recent ? `今天你看到过：\n${recent}\n` : ""}${
      intention ? `你心里还挂着：${intention.text}。\n` : ""
    }写一句你会真的发到 QQ 上的话：简短、自然，可以想他、吐槽、分享、或者把心里那件事说给他听。不要客套，不要解释自己在做什么。`,
    intention,
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

/** 累了就歇一会儿：什么都不产出，只是把「累」降下去。 */
export async function activityRest(deps: SoulDeps): Promise<void> {
  const soul = getSoulSnapshot(deps.db);
  patchSoulSnapshot(deps.db, { energy: Math.min(100, soul.energy + 8) });
  addEvent(deps.db, "rest", "什么都没做，就那样待着，发了一会儿呆。");
}

export function createSoulLoop(deps: SoulDeps) {
  const { db, config, llm, logger } = deps;
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  /**
   * 下一次醒来的间隔：由最渴的驱力决定，越渴越勤；再叠加随机抖动，
   * 这样她的作息不是整点的、规律的，而是像人一样忽早忽晚。
   */
  function nextDelayMs(): number {
    const top = topDrives(db, 1)[0]?.level ?? 50;
    const baseMinutes = clamp(52 - top * 0.38, 7, 46);
    const jittered = baseMinutes * (0.55 + Math.random() * 1.0);
    return Math.round(clamp(jittered, 4, 70) * 60_000);
  }

  function scheduleNext(): void {
    if (!config.soul.enabled) {
      return;
    }
    const delay = nextDelayMs();
    timer = setTimeout(() => void tick(), delay);
    logger.debug({ minutes: Math.round(delay / 60_000) }, "安排下一次醒来");
  }

  /**
   * 日记不再固定几点写：白天是表达欲攒够了才写，深夜则兜底写一篇。
   * 这样有时候一天两三点才写，有时候 21 点就写了。
   */
  function shouldJournal(quiet: boolean): boolean {
    const day = dayKey();
    if (getJournal(db, day)) {
      return false;
    }
    const hour = hourKey();
    const drives = topDrives(db, 5);
    const expression = drives.find((item) => item.name === "expression")?.level ?? 0;
    if (hour >= 22 || hour < 2) {
      return true;
    }
    if (hour >= 19 && expression >= 62) {
      return true;
    }
    if (quiet) {
      return false;
    }
    return expression >= 78;
  }

  async function dailyWrapUp(): Promise<void> {
    const day = dayKey();
    if (!getJournal(db, day)) {
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
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      const hour = hourKey();
      const quiet = inQuietHour(hour, config.soul.quietStart, config.soul.quietEnd);

      // 1. 时间流逝：她越久没活动，某些欲望越强；情绪同时缓慢褪色。
      driftDrives(db, quiet);
      relaxMood(db, quiet);

      // 2. 反思与挂念：让她心里始终有连续的东西。
      await maybeReflect(db, llm, logger);
      await ensureIntentions(db, llm, logger);

      // 3. 日记（表达欲驱动，而不是固定时刻）
      if (shouldJournal(quiet)) {
        const wrote = await writeDailyJournal(db, config, llm, logger);
        if (wrote) {
          relieveDrive(db, "journal");
          await dailyWrapUp();
          patchSoulSnapshot(db, { lastWakeAt: Date.now() });
          return;
        }
      }

      // 4. 精力恢复
      const soul = getSoulSnapshot(db);
      if (soul.energy < 95 && Math.random() < 0.5) {
        patchSoulSnapshot(db, { energy: soul.energy + 4 });
      }

      // 5.0：5.4.0 起，她醒来的这一刻不再由这里掷骰子决定做什么，
      // 而是把「环境 + 驱力」交给闭环内核：触发器/分类器 → 思考 → 效应器。
      if (config.soul.agentLoop && deps.onTick) {
        const topNow = topDrives(db, 1)[0];
        deps.onTick({
          quiet,
          hour,
          topDrive: topNow?.name,
          topLevel: topNow?.level,
        });
        patchSoulSnapshot(db, { lastWakeAt: Date.now() });
        return;
      }

      // 5. 决定这次要不要动、动什么（SOUL_AGENT_LOOP=false 的旧路径）
      const top = topDrives(db, 1)[0];
      // 什么都不太想、却也没在休息：无聊本身也是一种要做点什么的理由。
      const bored = (top?.level ?? 0) < 22;
      const chance = bored
        ? quiet
          ? 24
          : 46
        : planetChance(top?.level ?? 50, quiet);
      if (Math.random() * 100 >= chance) {
        logger.debug({ drive: top?.name, level: top?.level }, "她这次什么也不想做");
        return;
      }

      const intention = pickIntention(db);
      const driveName = (top?.name ?? "curiosity") as DriveName;
      const canTalk = talkedTodayCount(db, dayKey()) < config.soul.talkPerDay;
      let activity = chooseActivity(driveName, quiet, canTalk);

      // 5.1.0：她有一双真正的手。好奇攒够了，或者心里挂着件要动手的事，就会想去碰这台机器。
      if (config.soul.handsEnabled && !quiet) {
        const actionableGoal =
          intention?.kind === "goal" &&
          /服务器|日志|进程|磁盘|内存|端口|装|修|删|备份|配置|重启/.test(intention.text);
        if (actionableGoal && Math.random() < 0.5) {
          activity = "hands";
        } else if (driveName === "curiosity" && Math.random() < 0.35) {
          activity = "hands";
        }
      }

      // 5.3.0：想说话却没人可说，或者单纯无聊时，去找本机另一个模型聊几句。
      if (!quiet && canCompanion(db, config) && (bored || (driveName === "connection" && !canTalk))) {
        if (Math.random() < (bored ? 0.55 : 0.4)) {
          activity = "companion";
        }
      }

      // 防重复：刚看过热搜就别立刻再刷。
      if (activity === "hot" && didRecently(db, ["hot"], 90)) {
        activity = "browse";
      }
      if (activity === "browse" && didRecently(db, ["browse"], 60)) {
        activity = "monologue";
      }
      if (activity === "hands" && didRecently(db, ["hands"], 120)) {
        activity = "browse";
      }
      if (activity === "companion" && didRecently(db, ["companion"], 150)) {
        activity = "monologue";
      }

      logger.info({ activity, drive: driveName, level: top?.level, intention: intention?.text }, "她醒来了");

      switch (activity) {
        case "hot":
          await activityHot(deps, intention);
          break;
        case "browse":
          await activityBrowse(deps, intention);
          break;
        case "talk":
          await activityTalk(deps, intention);
          break;
        case "rest":
          await activityRest(deps);
          break;
        case "hands":
          await activityHands(deps, intention);
          break;
        case "companion":
          await activityCompanion(deps, intention);
          break;
        default:
          await activityMonologue(deps, intention);
      }
      relieveDrive(db, activity);
      patchSoulSnapshot(db, { lastWakeAt: Date.now() });
    } catch (error) {
      logger.warn({ err: error }, "自主活动失败");
    } finally {
      running = false;
      scheduleNext();
    }
  }

  return {
    tick,
    start(): void {
      if (!config.soul.enabled) {
        logger.info("赛博女儿自主活动已关闭（SOUL_ENABLED=false）");
        return;
      }
      setTimeout(() => void tick(), 60_000);
      logger.info({ mode: "drive-driven", tickMinutes: config.soul.tickMinutes }, "赛博女儿的生命循环已启动");
    },
    stop(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** 驱力越强，越可能忍不住真的去做；安静时段整体压低（除了累）。 */
function planetChance(level: number, quiet: boolean): number {
  const base = clamp(level - 25, 8, 88);
  return quiet ? base * 0.45 : base;
}

/** 供后台「手动叫她活动一下」使用。 */
export type SoulLoop = ReturnType<typeof createSoulLoop>;
