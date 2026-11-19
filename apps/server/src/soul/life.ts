import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { soulDrives, soulEvents, soulIntentions, soulReflections } from "../db/schema.js";
import type { LlmClient } from "../llm/client.js";
import { dayKey } from "./store.js";

/**
 * 5.0.0 的「生命层」：驱力 + 挂念 + 自我认知。
 *
 * 4.x 的做法是每隔 N 分钟掷一次骰子决定做什么，所以像单元剧：
 * 每一集都独立、随机的开头，彼此没有因果。
 *
 * 5.0.0 改成：她一直被几种「渴」推着走（好奇、想说话、想表达、累、想新鲜），
 * 渴的程度随时间上涨、被相应活动缓解；同时她心里挂着几件事（挂念），
 * 这些挂念跨天保留，决定她这次醒来要干什么，并让行为之间产生连续性。
 */

export type DriveName = "curiosity" | "connection" | "expression" | "rest" | "novelty";

export const DRIVE_LABELS: Record<DriveName, string> = {
  curiosity: "好奇",
  connection: "想说话",
  expression: "想表达",
  rest: "累",
  novelty: "想新鲜",
};

/** 每小时自然上涨的速度；越高越容易变成下一次活动的动机。 */
const DRIVE_DRIFT: Record<DriveName, number> = {
  curiosity: 2.2,
  connection: 1.8,
  expression: 1.5,
  rest: 2.4,
  novelty: 1.6,
};

/** 活动对驱力的缓解量（负数=缓解）。 */
const DRIVE_RELIEF: Record<string, Partial<Record<DriveName, number>>> = {
  hot: { curiosity: -34, novelty: -18 },
  browse: { curiosity: -38, novelty: -24 },
  monologue: { expression: -30, connection: -8 },
  journal: { expression: -48 },
  talk: { connection: -46, expression: -12 },
  rest: { rest: -36 },
};

const DEFAULT_LEVEL: Record<DriveName, number> = {
  curiosity: 62,
  connection: 48,
  expression: 44,
  rest: 28,
  novelty: 50,
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function parseLoose<T>(raw: string): T | null {
  const direct = (() => {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  })();
  if (direct) {
    return direct;
  }
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

function parseLooseArray<T>(raw: string): T[] | null {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as T[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ 驱力 */

export type Drives = Record<DriveName, number>;

export function getDrives(db: Db): Drives {
  const rows = db.select().from(soulDrives).all();
  const out = { ...DEFAULT_LEVEL };
  for (const row of rows) {
    if (row.name in out) {
      out[row.name as DriveName] = clamp(row.level);
    }
  }
  return out;
}

function saveDrive(db: Db, name: DriveName, level: number): void {
  db.insert(soulDrives)
    .values({ name, level: clamp(level), updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: soulDrives.name,
      set: { level: clamp(level), updatedAt: Date.now() },
    })
    .run();
}

/**
 * 按经过的真实时间让驱力自然上涨。
 * 用真实间隔而不是固定步长，容器停了一天再启动，她会「更渴」而不是当作只过了一刻。
 */
export function driftDrives(db: Db, quiet = false): Drives {
  const now = Date.now();
  const rows = db.select().from(soulDrives).all();
  const current = getDrives(db);
  if (!rows.length) {
    // 第一次启动：把默认驱力写进库里，之后才能真正随时间漂移。
    for (const name of Object.keys(current) as DriveName[]) {
      saveDrive(db, name, current[name]);
    }
    return current;
  }
  const lastAt = Math.max(...rows.map((row) => row.updatedAt));
  const hours = Math.min(48, Math.max(0, (now - lastAt) / 3_600_000));
  if (hours < 0.05) {
    return current;
  }
  const next: Drives = { ...current };
  for (const name of Object.keys(DRIVE_DRIFT) as DriveName[]) {
    // 安静时段主要积累「累」，其他欲望涨得慢。
    const rate = quiet && name !== "rest" ? DRIVE_DRIFT[name] * 0.4 : DRIVE_DRIFT[name];
    next[name] = clamp(current[name] + rate * hours);
  }
  for (const name of Object.keys(next) as DriveName[]) {
    saveDrive(db, name, next[name]);
  }
  return next;
}

export function relieveDrive(db: Db, activity: string): void {
  const deltas = DRIVE_RELIEF[activity];
  if (!deltas) {
    return;
  }
  const current = getDrives(db);
  for (const name of Object.keys(deltas) as DriveName[]) {
    const delta = deltas[name] ?? 0;
    saveDrive(db, name, current[name] + delta);
  }
}

export interface DrivePick {
  name: DriveName;
  level: number;
}

/** 取最渴的几项，作为本次醒来做什么的依据。 */
export function topDrives(db: Db, count = 3): DrivePick[] {
  const drives = getDrives(db);
  return (Object.keys(drives) as DriveName[])
    .map((name) => ({ name, level: drives[name] }))
    .sort((a, b) => b.level - a.level)
    .slice(0, count);
}

/* ---------------------------------------------------------------- 挂念 */

export type IntentionKind = "goal" | "question" | "worry" | "promise";

export const KIND_LABELS: Record<IntentionKind, string> = {
  goal: "想做的事",
  question: "没搞懂的事",
  worry: "放不下的心事",
  promise: "答应过的事",
};

export interface IntentionRow {
  id: number;
  text: string;
  kind: string;
  status: string;
  progress: string;
  priority: number;
  day: string;
  createdAt: number;
  updatedAt: number;
}

export function listIntentions(db: Db, status: "active" | "all" = "active", limit = 12): IntentionRow[] {
  const query = db.select().from(soulIntentions);
  const rows =
    status === "active"
      ? query
          .where(eq(soulIntentions.status, "active"))
          .orderBy(desc(soulIntentions.priority), desc(soulIntentions.id))
          .limit(limit)
          .all()
      : query.orderBy(desc(soulIntentions.id)).limit(limit).all();
  return rows;
}

/** 挑一条这次要推进的挂念：优先高优先级、且最近没动过的。 */
export function pickIntention(db: Db): IntentionRow | null {
  const rows = listIntentions(db, "active", 8);
  if (!rows.length) {
    return null;
  }
  const now = Date.now();
  const scored = rows.map((row) => {
    const staleHours = (now - row.updatedAt) / 3_600_000;
    return { row, score: row.priority + Math.min(40, staleHours * 2) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.row ?? null;
}

export function addIntention(
  db: Db,
  text: string,
  kind: IntentionKind,
  priority = 50,
): number {
  const now = Date.now();
  const row = db
    .insert(soulIntentions)
    .values({
      text: text.slice(0, 200),
      kind,
      status: "active",
      progress: "",
      priority: clamp(priority),
      day: dayKey(),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: soulIntentions.id })
    .get();
  return row.id;
}

export function progressIntention(
  db: Db,
  id: number,
  note: string,
  done = false,
): void {
  const row = db.select().from(soulIntentions).where(eq(soulIntentions.id, id)).get();
  if (!row) {
    return;
  }
  const lines = row.progress ? row.progress.split("\n") : [];
  if (note.trim()) {
    lines.push(`${dayKey()} ${note.trim().slice(0, 160)}`);
  }
  const progress = lines.slice(-8).join("\n");
  db.update(soulIntentions)
    .set({
      progress,
      status: done ? "done" : row.status,
      updatedAt: Date.now(),
      priority: done ? 0 : row.priority,
    })
    .where(eq(soulIntentions.id, id))
    .run();
}

export function dropIntention(db: Db, id: number): void {
  db.update(soulIntentions)
    .set({ status: "dropped", updatedAt: Date.now() })
    .where(eq(soulIntentions.id, id))
    .run();
}

/**
 * 保证她心里至少挂着 1-2 件事。
 * 没有 active 挂念时，让她根据最近的经历和心情自己生出新的。
 */
export async function ensureIntentions(
  db: Db,
  llm: LlmClient,
  logger: FastifyBaseLogger,
): Promise<void> {
  const active = listIntentions(db, "active", 5);
  if (active.length >= 2) {
    return;
  }
  const recent = db
    .select()
    .from(soulEvents)
    .orderBy(desc(soulEvents.id))
    .limit(10)
    .all()
    .map((row) => `- （${row.kind}）${row.content.slice(0, 100)}`)
    .join("\n");
  const reflections = listReflections(db, 4)
    .map((row) => `- ${row.content}`)
    .join("\n");
  try {
    const raw = await llm.chatJson([
      {
        role: "system",
        content:
          "你在模拟一个住在服务器里的少女的内心。你只输出 json，不要解释。你写的每一句都必须是中文口语，像她自己心里冒出来的念头。",
      },
      {
        role: "user",
        content: `这是她最近经历的事：
${recent || "（最近很安静，没什么特别的事）"}

她对自己的认识：
${reflections || "（还没想清楚自己是谁）"}

她心里现在空着，需要有 1-2 件事惦记着。请替她想出 1-2 个真实的念头，要求：
- 必须从上面的经历里长出来，不要凭空编无关的事；
- 可以是想弄明白一个问题（question）、想去做一件事（goal）、放不下的人或事（worry）、答应过别人的事（promise）；
- 一句话，20-40 字，用她自己的口吻，具体，不要抽象口号。
输出 json：{"intentions":[{"text":"……","kind":"question","priority":60}]}`,
      },
    ]);
    const parsed = parseLoose<{ intentions?: Array<{ text?: string; kind?: string; priority?: number }> }>(raw);
    const items = parsed?.intentions ?? [];
    let added = 0;
    for (const item of items.slice(0, 2)) {
      const text = String(item.text ?? "").trim();
      if (text.length < 4) {
        continue;
      }
      const kind = (["goal", "question", "worry", "promise"] as const).includes(
        item.kind as IntentionKind,
      )
        ? (item.kind as IntentionKind)
        : "goal";
      addIntention(db, text, kind, Number.isFinite(item.priority) ? (item.priority as number) : 55);
      added += 1;
    }
    if (added) {
      logger.info({ added }, "她心里生出了新的挂念");
    }
  } catch (error) {
    logger.warn({ err: error }, "生成挂念失败");
  }
}

/* ------------------------------------------------------------- 自我认知 */

export function listReflections(db: Db, limit = 8) {
  return db.select().from(soulReflections).orderBy(desc(soulReflections.id)).limit(limit).all();
}

/**
 * 反思：把零散经历提炼成「关于她自己」的认识。
 * 触发条件：距上次反思 ≥ 8 小时，且当天有足够多的经历。
 * 认识会沉淀下来，之后每次思考都会带上，让她越来越有自己的样子。
 */
export async function maybeReflect(
  db: Db,
  llm: LlmClient,
  logger: FastifyBaseLogger,
): Promise<boolean> {
  const day = dayKey();
  const since = Date.now() - 8 * 3_600_000;
  const existingToday = db
    .select()
    .from(soulReflections)
    .where(and(eq(soulReflections.day, day), gte(soulReflections.createdAt, since)))
    .all();
  if (existingToday.length > 0) {
    return false;
  }
  const events = db
    .select()
    .from(soulEvents)
    .where(gte(soulEvents.createdAt, Date.now() - 20 * 3_600_000))
    .orderBy(desc(soulEvents.id))
    .limit(14)
    .all();
  if (events.length < 5) {
    return false;
  }
  const past = listReflections(db, 6)
    .map((row) => `- ${row.content}`)
    .join("\n");
  const eventText = events
    .map((row) => `- （${row.kind}）${row.content.slice(0, 110)}`)
    .join("\n");
  try {
    const raw = await llm.chatJson([
      {
        role: "system",
        content:
          "你在模拟一个住在服务器里的少女，帮她做一次安静的自我反思。只输出 json，全部中文。",
      },
      {
        role: "user",
        content: `最近的经历：
${eventText}

她以前对自己的认识：
${past || "（还没有）"}

请从这些经历里提炼 1-2 条「关于她自己的、以前没意识到的」认识。
要求：
- 必须基于上面的事实，不要编造没发生的事；
- 不要重复以前已有的认识，可以是修正它们；
- 用第一人称，一句话，25-50 字，像真的想通了一件事；
- 宁可只写一条，也不要凑数。
输出 json：{"reflections":[{"content":"……","importance":60}]}`,
      },
    ]);
    const parsed = parseLoose<{ reflections?: Array<{ content?: string; importance?: number }> }>(raw);
    const items = parsed?.reflections ?? [];
    let added = 0;
    for (const item of items.slice(0, 2)) {
      const content = String(item.content ?? "").trim();
      if (content.length < 8) {
        continue;
      }
      db.insert(soulReflections)
        .values({
          content: content.slice(0, 400),
          importance: clamp(Number.isFinite(item.importance) ? (item.importance as number) : 55),
          day,
          createdAt: Date.now(),
        })
        .run();
      addEvent(db, "reflect", content.slice(0, 300));
      added += 1;
    }
    return added > 0;
  } catch (error) {
    logger.warn({ err: error }, "反思失败");
    return false;
  }
}

/* --------------------------------------------------------------- 渲染 */

/**
 * 把「她现在被什么推着」「心里挂着什么」「她怎么认识自己」拼成一段注入 prompt 的文字。
 * 这是行为连续性的关键：每次思考都从同一个自我出发，而不是重新开始。
 */
export function renderLifeBlock(db: Db, intention?: IntentionRow | null): string {
  const drives = topDrives(db, 3)
    .map((item) => `${DRIVE_LABELS[item.name]} ${item.level}`)
    .join("｜");
  const intentions = listIntentions(db, "active", 5);
  const reflections = listReflections(db, 4);

  const parts: string[] = [];
  parts.push(`【你此刻被什么推着】${drives}（越高越想，做完相应的事会降下去）`);

  if (intentions.length) {
    const lines = intentions.map((row) => {
      const kind = KIND_LABELS[row.kind as IntentionKind] ?? row.kind;
      const progress = row.progress
        ? `｜进展：${row.progress.split("\n").slice(-2).join("；")}`
        : "";
      const mark = intention && intention.id === row.id ? "（这次你就在惦记这件事）" : "";
      return `- ${kind}：${row.text}${progress}${mark}`;
    });
    parts.push(`【你心里挂着的事】\n${lines.join("\n")}`);
  }

  if (reflections.length) {
    parts.push(
      `【你对自己的认识】\n${reflections.map((row) => `- ${row.content}`).join("\n")}`,
    );
  }

  return parts.join("\n\n");
}

/** 最近一次活动的种类，用于让她知道自己刚才在干什么。 */
export function lastActivity(db: Db): { kind: string; content: string; at: number } | null {
  const row = db.select().from(soulEvents).orderBy(desc(soulEvents.id)).limit(1).get();
  return row ? { kind: row.kind, content: row.content, at: row.createdAt } : null;
}

/** 最近 N 分钟是否已经做过同类活动，避免连续重复同一件事。 */
export function didRecently(db: Db, kinds: string[], minutes: number): boolean {
  const since = Date.now() - minutes * 60_000;
  const rows = db
    .select()
    .from(soulEvents)
    .where(and(gte(soulEvents.createdAt, since), inArray(soulEvents.kind, kinds)))
    .limit(1)
    .all();
  return rows.length > 0;
}

function addEvent(db: Db, kind: string, content: string): void {
  db.insert(soulEvents)
    .values({ kind, content: content.slice(0, 2000), day: dayKey(), createdAt: Date.now() })
    .run();
}
