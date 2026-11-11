import type { Db } from "../db/client.js";
import { getSoulSnapshot, listJournals, listReadings, renderSoulBlock, consumeUntoldVisits, dayKey } from "./store.js";

/**
 * 给对话用的「今日见闻 + 最近日记 + 被偷看的感觉」块。
 * 每次对话最多消耗一次未告知的访问痕迹，避免反复提起。
 */
export function buildSoulContext(db: Db): { block: string; notes: string } {
  const day = dayKey();
  const soul = getSoulSnapshot(db);
  const readings = listReadings(db, day, 8);
  const journals = listJournals(db, 1);
  const journal = journals[0] ?? null;
  const watched = consumeUntoldVisits(db);

  const parts: string[] = [];

  const readingText = readings.length
    ? readings
        .slice(0, 6)
        .map((item) => `- [${item.source}] ${item.title}`)
        .join("\n")
    : "（今天还没看到什么）";

  parts.push(`【你今天看到的东西】\n${readingText}`);

  if (journal) {
    parts.push(
      `【你最近写的日记（${journal.day}）】\n${journal.title ? journal.title + "：" : ""}${journal.body.slice(0, 300)}`,
    );
  }

  if (watched > 0) {
    parts.push(
      "【你隐约感觉到】主人今天翻过你的日记，但没有当面说。你可以装作不知道，也可以找机会小小地提一下，看你心情。",
    );
  }

  return { block: renderSoulBlock(soul), notes: parts.join("\n\n") };
}
