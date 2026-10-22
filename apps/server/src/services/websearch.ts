/**
 * 联网搜索：使用必应中国 RSS 结果（无需 API Key，服务器可直连）。
 * 返回格式化文本，由模型结合搜索结果回答；结果属于不受信任的外部内容。
 */

const ENDPOINT = "https://cn.bing.com/search";
const MAX_SNIPPET = 300;

function decodeEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)));
}

function cleanText(value: string): string {
  return decodeEntities(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pick(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? cleanText(match[1] ?? "") : "";
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function searchWeb(query: string, limit = 5): Promise<string> {
  const keyword = query.trim();
  if (!keyword) {
    return "缺少搜索关键词。";
  }
  const url = `${ENDPOINT}?q=${encodeURIComponent(keyword)}&format=rss&mkt=zh-CN&setlang=zh-CN`;
  let xml: string;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "application/rss+xml, application/xml, text/xml, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return `搜索失败：搜索服务返回 HTTP ${response.status}。`;
    }
    xml = await response.text();
  } catch (error) {
    return `搜索失败：${error instanceof Error ? error.message : "网络异常"}`;
  }

  const results: SearchResult[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1] ?? "";
    const title = pick(block, "title");
    const link = pick(block, "link");
    const snippet = pick(block, "description").slice(0, MAX_SNIPPET);
    if (!title || !link) {
      continue;
    }
    results.push({ title, url: link, snippet });
    if (results.length >= Math.min(Math.max(limit, 1), 8)) {
      break;
    }
  }

  if (!results.length) {
    return `没有搜到与「${keyword}」相关的结果。`;
  }

  const lines = results.map(
    (item, index) => `${index + 1}. ${item.title}\n   ${item.url}\n   ${item.snippet || "（无摘要）"}`,
  );
  return `搜索「${keyword}」的结果：\n${lines.join("\n")}`;
}
