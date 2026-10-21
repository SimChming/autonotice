import { describe, expect, it } from "vitest";
import { extractUrls, fetchUrl } from "./fetcher.js";

describe("extractUrls", () => {
  it("提取并去重链接，最多 3 条", () => {
    const urls = extractUrls(
      "看这个 https://a.com/1 和 https://a.com/1 ，还有 http://b.com/x ，https://c.com ，https://d.com",
    );
    expect(urls).toEqual(["https://a.com/1", "http://b.com/x", "https://c.com"]);
  });
});

describe("fetchUrl SSRF 防护", () => {
  it("拒绝回环地址", async () => {
    await expect(fetchUrl("http://127.0.0.1:8080/healthz")).rejects.toThrow(/内网/);
  });

  it("拒绝内网网段", async () => {
    await expect(fetchUrl("http://192.168.1.10/")).rejects.toThrow(/内网/);
    await expect(fetchUrl("http://10.0.0.5/")).rejects.toThrow(/内网/);
  });
});
