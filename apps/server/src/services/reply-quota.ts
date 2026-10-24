import type { Db } from "../db/client.js";
import { getSetting } from "../skills/registry.js";

/** 每轮最多发送多少条：群聊默认 8，普通用户私聊默认 8，主人私聊 0 表示不限。 */
export interface ReplyQuota {
  groupLimit: number;
  ownerPrivateLimit: number;
  userPrivateLimit: number;
}

export type ReplyScope = "group" | "ownerPrivate" | "userPrivate";

const DEFAULTS: ReplyQuota = {
  groupLimit: 8,
  ownerPrivateLimit: 0,
  userPrivateLimit: 8,
};

function readInt(db: Db, key: string, fallback: number, min: number, max: number): number {
  const raw = getSetting(db, key);
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function getReplyQuota(db: Db): ReplyQuota {
  return {
    groupLimit: readInt(db, "reply.limit.group", DEFAULTS.groupLimit, 1, 50),
    ownerPrivateLimit: readInt(db, "reply.limit.owner_private", DEFAULTS.ownerPrivateLimit, 0, 200),
    userPrivateLimit: readInt(db, "reply.limit.user_private", DEFAULTS.userPrivateLimit, 1, 50),
  };
}

/** 返回该场景单轮最多发送条数；0 表示不限（主人私聊）。 */
export function limitForScope(quota: ReplyQuota, scope: ReplyScope): number {
  if (scope === "group") {
    return quota.groupLimit;
  }
  return scope === "ownerPrivate" ? quota.ownerPrivateLimit : quota.userPrivateLimit;
}

/** 主人私聊允许多轮推进任务；群聊与普通用户私聊保持紧凑。 */
export function roundsForScope(scope: ReplyScope): number {
  return scope === "ownerPrivate" ? 24 : 8;
}
