import { z } from "zod";
import type { LlmClient } from "../llm/client.js";
import { extractUrls, fetchUrl, type FetchedPage } from "./fetcher.js";

const extractedItemSchema = z.object({
  title: z.string().min(1),
  type: z.enum(["task", "exam", "meeting", "other"]).default("task"),
  priority: z.enum(["high", "normal", "low"]).default("normal"),
  due_at: z.string().nullable().optional(),
  remind_at: z.string().nullable().optional(),
  notes: z.string().default(""),
});

const extractionSchema = z.object({
  items: z.array(extractedItemSchema).default([]),
});

export interface ExtractedItem {
  title: string;
  type: "task" | "exam" | "meeting" | "other";
  priority: "high" | "normal" | "low";
  dueAt: number | null;
  remindAt: number | null;
  notes: string;
}

function toTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function normalize(item: z.infer<typeof extractedItemSchema>): ExtractedItem {
  const dueAt = toTimestamp(item.due_at ?? null);
  const remindAt = toTimestamp(item.remind_at ?? null);
  return {
    title: item.title.trim(),
    type: item.type,
    priority: item.priority,
    dueAt,
    remindAt: remindAt ?? (dueAt === null ? null : dueAt - 30 * 60 * 1000),
    notes: item.notes.trim(),
  };
}

function buildPrompt(text: string, pages: FetchedPage[], nowIso: string): string {
  const linkSection = pages.length
    ? pages.map((page) => `【链接内容 ${page.url}】\n${page.text}`).join("\n\n")
    : "（无链接内容）";
  return `当前时间：${nowIso}（Asia/Shanghai）。
从下面这段群聊消息中抽取需要记入日程的事项，只输出 json，格式：
{"items":[{"title":"事项标题","type":"task|exam|meeting|other","priority":"high|normal|low","due_at":"ISO8601 或 null","remind_at":"ISO8601 或 null","notes":"补充说明"}]}

规则：
1. 只有包含明确时间/截止时间、且需要提醒的事项才抽取；闲聊、无时间信息的内容返回 {"items":[]}。
2. 没有明确年份时按当前时间推断；无法确定具体时间则 due_at 为 null。
3. 不要编造信息；标题不超过 40 字。
4. 若消息含链接，结合链接正文判断截止时间。

群聊消息：
${text}

${linkSection}`;
}

function parseResponse(raw: string): ExtractedItem[] | null {
  try {
    const parsed = extractionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }
    return parsed.data.items.map(normalize).filter((item) => item.title.length > 0);
  } catch {
    return null;
  }
}

/** 消息 + 链接 → LLM JSON 抽取；非法 JSON 时重试一次。 */
export async function extractSchedules(llm: LlmClient, text: string): Promise<ExtractedItem[]> {
  if (!text.trim()) {
    return [];
  }

  const pages: FetchedPage[] = [];
  for (const url of extractUrls(text)) {
    try {
      pages.push(await fetchUrl(url));
    } catch {
      // 抓取失败不阻塞抽取，链接异常由调用方日志记录
    }
  }

  const nowIso = new Date().toISOString();
  const systemMessage = {
    role: "system" as const,
    content: "你是严格的日程抽取器，只输出合法的 json 对象，不要输出任何解释。",
  };
  const userMessage = { role: "user" as const, content: buildPrompt(text, pages, nowIso) };

  const first = await llm.chatJson([systemMessage, userMessage]);
  const parsed = parseResponse(first);
  if (parsed) {
    return parsed;
  }

  const retry = await llm.chatJson([
    systemMessage,
    { role: "user", content: `${userMessage.content}\n\n上一次输出不是合法 json，请严格只输出 json 对象。` },
  ]);
  return parseResponse(retry) ?? [];
}
