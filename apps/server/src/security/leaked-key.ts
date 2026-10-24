import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";

/**
 * 已泄露到公开仓库的 dashscope Key 指纹（只存 SHA-256，不存密钥本身）。
 * 用于在服务端启动时提醒轮换；密钥一旦出现在公开仓库就应视为已泄露。
 */
const LEAKED_KEY_SHA256 = "b07b110bbd774ec045d2c4861fbb9e4793379f7f0fdb80620f2651d092fd05cc";

function fingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function isLeakedKey(key: string | null | undefined): boolean {
  return typeof key === "string" && key.length > 0 && fingerprint(key) === LEAKED_KEY_SHA256;
}

/** 启动时检查运行时/环境里的密钥是否仍是泄露的那一把，是则打一条 error 日志。 */
export function warnIfLeakedKey(
  keys: Array<string | null | undefined>,
  logger: FastifyBaseLogger,
): void {
  if (!keys.some((key) => isLeakedKey(key))) {
    return;
  }
  logger.error(
    "检测到已公开泄露的 LLM API Key 仍在使用：请立即到模型提供商后台轮换，并通过服务器 .env 或后台「模型设置」更新新密钥。",
  );
}
