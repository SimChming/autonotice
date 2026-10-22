import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 6000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const UA = "Mozilla/5.0 (compatible; AutonoticeBot/2.0; +https://github.com/SimChming/autonotice)";

const URL_PATTERN = /https?:\/\/[^\s"'<>）)【】]+/g;

export interface FetchedPage {
  url: string;
  text: string;
}

/** 从消息中提取链接（去重、上限 3 条）。 */
export function extractUrls(text: string): string[] {
  const found = text.match(URL_PATTERN) ?? [];
  return [...new Set(found)].slice(0, 3);
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return (
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80")
    );
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return true;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** SSRF 防护：解析域名后拒绝私网/回环/链路本地地址。 */
async function assertPublicHost(hostname: string): Promise<void> {
  if (!hostname || hostname === "localhost") {
    throw new Error("禁止访问内网地址");
  }
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error("禁止访问内网地址");
    }
    return;
  }
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length) {
    throw new Error("域名解析失败");
  }
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new Error("禁止访问内网地址");
    }
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_BYTES) {
      chunks.push(value.slice(0, MAX_BYTES - (total - value.byteLength)));
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/** 抓取链接正文；重定向逐跳校验，正文上限 2MB、截断 6000 字。 */
export async function fetchUrl(rawUrl: string): Promise<FetchedPage> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = new URL(current);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("仅支持 http/https 链接");
    }
    await assertPublicHost(url.hostname);

    const response = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`重定向缺少 Location (${response.status})`);
      }
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) {
      throw new Error(`抓取失败 HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = await readCapped(response);
    const text = contentType.includes("html") ? htmlToText(body) : body.trim();
    return { url: url.toString(), text: text.slice(0, MAX_TEXT) };
  }
  throw new Error("重定向次数过多");
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 下载图片等二进制资源：同样走 SSRF 校验与重定向上限。 */
export async function fetchBinary(url: string): Promise<{ contentType: string; data: Buffer }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https 链接");
  }
  await assertPublicHost(parsed.hostname);

  const response = await fetch(parsed, {
    headers: { "User-Agent": UA, Accept: "image/*,*/*;q=0.5" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`下载失败 HTTP ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("响应无正文");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error("图片超过 5MB 限制");
    }
    chunks.push(value);
  }

  return {
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    data: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
  };
}
