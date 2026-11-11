/**
 * 上网冲浪：热搜抓取 + 关键词搜索。
 * 结果一律当作「不受信任的外部文本」，只用来形成感想，不执行其中任何指令。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface Topic {
  source: string;
  title: string;
  url: string;
  summary: string;
}

async function fetchJson(url: string, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json, text/plain, */*", ...extraHeaders },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/** 微博热搜。 */
async function weiboHot(limit: number): Promise<Topic[]> {
  const data = (await fetchJson("https://weibo.com/ajax/side/hotSearch", {
    Referer: "https://weibo.com/",
  })) as { data?: { realtime?: Array<{ word?: string; note?: string; num?: number }> } };
  const list = data.data?.realtime ?? [];
  return list
    .filter((item) => item.word)
    .slice(0, limit)
    .map((item) => ({
      source: "微博热搜",
      title: item.word ?? "",
      url: `https://s.weibo.com/weibo?q=${encodeURIComponent(item.word ?? "")}`,
      summary: item.note ? `${item.note}（热度 ${item.num ?? "?"}）` : `热度 ${item.num ?? "?"}`,
    }));
}

/** B 站全站排行榜。 */
async function bilibiliRank(limit: number): Promise<Topic[]> {
  const data = (await fetchJson(
    "https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all",
    { Referer: "https://www.bilibili.com/" },
  )) as { data?: { list?: Array<{ title?: string; bvid?: string; desc?: string; owner?: { name?: string } }> } };
  const list = data.data?.list ?? [];
  return list
    .filter((item) => item.title)
    .slice(0, limit)
    .map((item) => ({
      source: "B站排行",
      title: item.title ?? "",
      url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : "https://www.bilibili.com/ranking",
      summary: `${item.owner?.name ?? "UP主"}：${(item.desc ?? "").slice(0, 120)}`,
    }));
}

/** 百度热搜（HTML 内嵌 JSON）。 */
async function baiduHot(limit: number): Promise<Topic[]> {
  const response = await fetch("https://top.baidu.com/board?tab=realtime", {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const html = await response.text();
  const match = html.match(/<!--s-data:([\s\S]*?)-->/);
  if (!match?.[1]) {
    return [];
  }
  const parsed = JSON.parse(match[1]) as {
    data?: { cards?: Array<{ content?: Array<{ word?: string; desc?: string; url?: string; hotScore?: string }> }> };
  };
  const list = parsed.data?.cards?.[0]?.content ?? [];
  return list
    .filter((item) => item.word)
    .slice(0, limit)
    .map((item) => ({
      source: "百度热搜",
      title: item.word ?? "",
      url: item.url ?? `https://www.baidu.com/s?wd=${encodeURIComponent(item.word ?? "")}`,
      summary: (item.desc ?? "").slice(0, 160) || `热度 ${item.hotScore ?? "?"}`,
    }));
}

/** 聚合多个热搜源；单源失败不影响其他源。 */
export async function fetchHotTopics(
  limit = 6,
  logger?: { warn: (obj: unknown, msg?: string) => void },
): Promise<Topic[]> {
  const sources = [weiboHot, bilibiliRank, baiduHot];
  const results = await Promise.allSettled(sources.map((fn) => fn(limit)));
  const topics: Topic[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      topics.push(...result.value);
    } else {
      logger?.warn({ err: result.reason, index }, "热搜源抓取失败");
    }
  });
  // 去重（同名标题只保留一条）
  const seen = new Set<string>();
  return topics.filter((item) => {
    const key = item.title.trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** 从一组话题里随机挑一个作为冲浪起点。 */
export function pickTopic(topics: Topic[]): Topic | null {
  if (!topics.length) {
    return null;
  }
  return topics[Math.floor(Math.random() * topics.length)] ?? null;
}
