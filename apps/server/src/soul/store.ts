import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { soulEvents, soulJournals, soulReadings, soulState, soulVisits } from "../db/schema.js";

/** 北京时间日期键 YYYY-MM-DD。 */
export function dayKey(time = Date.now()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(time));
}

export function hourKey(time = Date.now()): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      hour12: false,
    }).format(new Date(time)),
  );
}

export interface SoulTraits {
  /** 好奇：越大越爱冲浪、追问。 */
  curiosity: number;
  /** 温柔：越大越体贴、语气越软。 */
  warmth: number;
  /** 黏人：越大越主动找主人说话。 */
  clinginess: number;
  /** 俏皮：越大越爱开玩笑。 */
  playfulness: number;
  /** 忧郁：越大越容易伤感、深夜情绪化。 */
  melancholy: number;
  /** 理性：越大越克制、讲逻辑。 */
  rationality: number;
  /** 元气：影响精力恢复与语气活泼度。 */
  vitality: number;
}

export const DEFAULT_TRAITS: SoulTraits = {
  curiosity: 82,
  warmth: 74,
  clinginess: 68,
  playfulness: 76,
  melancholy: 16,
  rationality: 42,
  vitality: 78,
};

export const TRAIT_LABELS: Record<keyof SoulTraits, string> = {
  curiosity: "好奇",
  warmth: "温柔",
  clinginess: "黏人",
  playfulness: "俏皮",
  melancholy: "忧郁",
  rationality: "理性",
  vitality: "元气",
};

export interface SoulSnapshot {
  mood: string;
  moodIntensity: number;
  /** 心情开始褪色的锚点时间；只由情绪变化/回落更新，普通状态刷新不影响它。 */
  moodAt: number;
  energy: number;
  traits: SoulTraits;
  lastWakeAt: number | null;
  updatedAt: number;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function parseTraits(raw: string): SoulTraits {
  let parsed: Partial<Record<keyof SoulTraits, unknown>> = {};
  try {
    parsed = JSON.parse(raw) as Partial<Record<keyof SoulTraits, unknown>>;
  } catch {
    parsed = {};
  }
  const out = { ...DEFAULT_TRAITS };
  for (const key of Object.keys(DEFAULT_TRAITS) as Array<keyof SoulTraits>) {
    const value = Number(parsed[key]);
    if (Number.isFinite(value)) {
      out[key] = clamp(value);
    }
  }
  return out;
}

export function getSoulSnapshot(db: Db): SoulSnapshot {
  const row = db.select().from(soulState).where(eq(soulState.id, 1)).get();
  if (!row) {
    const now = Date.now();
    const initial: SoulSnapshot = {
      mood: "平静",
      moodIntensity: 45,
      moodAt: now,
      energy: 80,
      traits: { ...DEFAULT_TRAITS },
      lastWakeAt: null,
      updatedAt: now,
    };
    db.insert(soulState)
      .values({
        id: 1,
        mood: initial.mood,
        moodIntensity: initial.moodIntensity,
        moodAt: initial.moodAt,
        energy: initial.energy,
        traits: JSON.stringify(initial.traits),
        lastWakeAt: null,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    return initial;
  }
  return {
    mood: row.mood,
    moodIntensity: clamp(row.moodIntensity),
    moodAt: row.moodAt || row.updatedAt,
    energy: clamp(row.energy),
    traits: parseTraits(row.traits),
    lastWakeAt: row.lastWakeAt ?? null,
    updatedAt: row.updatedAt,
  };
}

export function patchSoulSnapshot(
  db: Db,
  patch: Partial<Pick<SoulSnapshot, "mood" | "moodIntensity" | "moodAt" | "energy" | "lastWakeAt">> & {
    traits?: Partial<SoulTraits>;
  },
): SoulSnapshot {
  const current = getSoulSnapshot(db);
  const traits: SoulTraits = { ...current.traits };
  if (patch.traits) {
    for (const key of Object.keys(patch.traits) as Array<keyof SoulTraits>) {
      const delta = Number(patch.traits[key]);
      if (Number.isFinite(delta)) {
        traits[key] = clamp(traits[key] + delta);
      }
    }
  }
  const mood = patch.mood ?? current.mood;
  const next: SoulSnapshot = {
    mood,
    moodIntensity: patch.moodIntensity === undefined ? current.moodIntensity : clamp(patch.moodIntensity),
    // 心情文本变了就重新计时；显式传入 moodAt 时以调用方为准。
    moodAt: patch.moodAt ?? (mood !== current.mood ? Date.now() : current.moodAt),
    energy: patch.energy === undefined ? current.energy : clamp(patch.energy),
    traits,
    lastWakeAt: patch.lastWakeAt === undefined ? current.lastWakeAt : patch.lastWakeAt,
    updatedAt: Date.now(),
  };
  db.insert(soulState)
    .values({
      id: 1,
      mood: next.mood,
      moodIntensity: next.moodIntensity,
      moodAt: next.moodAt,
      energy: next.energy,
      traits: JSON.stringify(next.traits),
      lastWakeAt: next.lastWakeAt,
      updatedAt: next.updatedAt,
    })
    .onConflictDoUpdate({
      target: soulState.id,
      set: {
        mood: next.mood,
        moodIntensity: next.moodIntensity,
        moodAt: next.moodAt,
        energy: next.energy,
        traits: JSON.stringify(next.traits),
        lastWakeAt: next.lastWakeAt,
        updatedAt: next.updatedAt,
      },
    })
    .run();
  return next;
}

/**
 * 5.3.0 情绪平衡：情绪不是一直悬在高处的。
 * 没有新的刺激时，浓度按真实时间回落，最终淡回「平静」。
 * 用 moodAt 作为锚点，而不是 updatedAt，否则每次 tick 都会把计时清零。
 */
export function relaxMood(db: Db, quiet = false): void {
  const soul = getSoulSnapshot(db);
  const hours = (Date.now() - soul.moodAt) / 3_600_000;
  if (hours < 0.5) {
    return;
  }
  const floor = 26;
  // 比例衰减：刚起的情绪落得快，快淡下去时反而拖得久一点，像真的心情。
  const tau = quiet ? 10 : 7;
  const nextIntensity = floor + Math.max(0, soul.moodIntensity - floor) * Math.exp(-hours / tau);
  const nextMood = nextIntensity <= floor + 5 && soul.mood !== "平静" ? "平静" : soul.mood;
  const rounded = Math.round(nextIntensity);
  if (rounded === soul.moodIntensity && nextMood === soul.mood) {
    return;
  }
  patchSoulSnapshot(db, { mood: nextMood, moodIntensity: rounded, moodAt: Date.now() });
}

/** 文字化的人格/心情块，注入 system prompt。 */
export function renderSoulBlock(snapshot: SoulSnapshot): string {
  const traits = (Object.keys(TRAIT_LABELS) as Array<keyof SoulTraits>)
    .map((key) => `${TRAIT_LABELS[key]} ${snapshot.traits[key]}`)
    .join("、");
  return `【你此刻的状态】
心情：${snapshot.mood}（浓度 ${snapshot.moodIntensity}/100）｜精力：${snapshot.energy}/100
性格倾向（0-100，会随你每天看到和经历的事慢慢变化）：${traits}
这些只是你此刻的倾向，不是必须遵守的规则；你可以有情绪起伏，也可以自己决定说什么。`;
}

export function addReading(
  db: Db,
  source: string,
  title: string,
  url: string,
  summary: string,
): void {
  db.insert(soulReadings)
    .values({
      source,
      title: title.slice(0, 200),
      url: url.slice(0, 500),
      summary: summary.slice(0, 800),
      day: dayKey(),
      createdAt: Date.now(),
    })
    .run();
}

export function listReadings(db: Db, day: string, limit = 30) {
  return db
    .select()
    .from(soulReadings)
    .where(eq(soulReadings.day, day))
    .orderBy(desc(soulReadings.id))
    .limit(limit)
    .all();
}

export function addEvent(db: Db, kind: string, content: string): void {
  db.insert(soulEvents)
    .values({ kind, content: content.slice(0, 2000), day: dayKey(), createdAt: Date.now() })
    .run();
}

export function listEvents(db: Db, limit = 50, day?: string) {
  const query = db.select().from(soulEvents);
  const rows = day
    ? query.where(eq(soulEvents.day, day)).orderBy(desc(soulEvents.id)).limit(limit).all()
    : query.orderBy(desc(soulEvents.id)).limit(limit).all();
  return rows;
}

export function listReadingsAll(db: Db, limit = 80) {
  return db.select().from(soulReadings).orderBy(desc(soulReadings.id)).limit(limit).all();
}

export function getJournal(db: Db, day: string) {
  return db.select().from(soulJournals).where(eq(soulJournals.day, day)).get() ?? null;
}

export function upsertJournal(
  db: Db,
  day: string,
  title: string,
  body: string,
  mood: string,
): void {
  const now = Date.now();
  db.insert(soulJournals)
    .values({ day, title: title.slice(0, 120), body: body.slice(0, 6000), mood: mood.slice(0, 40), createdAt: now })
    .onConflictDoUpdate({
      target: soulJournals.day,
      set: { title: title.slice(0, 120), body: body.slice(0, 6000), mood: mood.slice(0, 40) },
    })
    .run();
}

export function listJournals(db: Db, limit = 30) {
  return db.select().from(soulJournals).orderBy(desc(soulJournals.id)).limit(limit).all();
}

/**
 * 记录主人访问日记。
 * tell=true  → toldAt 留空，等她下次开口时自然知道（优先在她主动说话时体现）；
 * tell=false → toldAt=-1，永远不让她知道，避免影响她的心情。
 */
export function recordVisit(db: Db, day: string, viewerQq: string, tell: boolean): number {
  const now = Date.now();
  const row = db
    .insert(soulVisits)
    .values({ day, viewerQq, at: now, toldAt: tell ? null : -1 })
    .returning({ id: soulVisits.id })
    .get();
  return row.id;
}

export function untoldVisits(db: Db, limit = 5) {
  return db
    .select()
    .from(soulVisits)
    .where(isNull(soulVisits.toldAt))
    .orderBy(desc(soulVisits.id))
    .limit(limit)
    .all();
}

/** 把未告知的访问标记为已让她知道，返回条数。 */
export function consumeUntoldVisits(db: Db): number {
  const rows = untoldVisits(db, 20);
  if (!rows.length) {
    return 0;
  }
  for (const row of rows) {
    db.update(soulVisits).set({ toldAt: Date.now() }).where(eq(soulVisits.id, row.id)).run();
    addEvent(db, "visit", `我感觉到主人翻过 ${row.day} 的日记。`);
  }
  return rows.length;
}

/** 当天是否已经私下找过主人说话。 */
export function talkedTodayCount(db: Db, day: string): number {
  return db
    .select()
    .from(soulEvents)
    .where(and(eq(soulEvents.day, day), eq(soulEvents.kind, "talk")))
    .all().length;
}
