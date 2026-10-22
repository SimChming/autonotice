import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { groups, userGroups } from "../db/schema.js";
import type { OneBotClient } from "../onebot/client.js";

export function groupAvatarUrl(groupId: string): string {
  return `https://p.qlogo.cn/gh/${groupId}/${groupId}/100`;
}

/** 确保 groups 表中有该群的基础行（名称可后补）。 */
export function ensureGroup(db: Db, groupId: string) {
  const now = Date.now();
  const existing = db.select().from(groups).where(eq(groups.groupId, groupId)).get();
  if (existing) {
    db.update(groups).set({ updatedAt: now }).where(eq(groups.groupId, groupId)).run();
    return existing;
  }
  const created = {
    groupId,
    name: "",
    avatar: groupAvatarUrl(groupId),
    updatedAt: now,
  };
  db.insert(groups).values(created).onConflictDoNothing().run();
  return created;
}

export function updateGroupInfo(db: Db, groupId: string, name: string): void {
  ensureGroup(db, groupId);
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }
  db.update(groups)
    .set({ name: trimmed, avatar: groupAvatarUrl(groupId), updatedAt: Date.now() })
    .where(eq(groups.groupId, groupId))
    .run();
}

/** 通过 NapCat 群信息接口补全群名称（失败时保留群号兜底）。 */
export async function refreshGroupInfo(
  onebot: OneBotClient,
  db: Db,
  groupId: string,
  logger: FastifyBaseLogger,
): Promise<{ ok: boolean; name: string; avatar: string }> {
  const row = ensureGroup(db, groupId);
  if (!onebot.connected) {
    return { ok: false, name: row.name, avatar: row.avatar };
  }
  try {
    const data = await onebot.request<{ group_name?: string }>("get_group_info", {
      group_id: Number(groupId),
    });
    const name = String(data.group_name ?? "").trim();
    if (name) {
      updateGroupInfo(db, groupId, name);
    }
    const latest = db.select().from(groups).where(eq(groups.groupId, groupId)).get();
    return { ok: Boolean(name), name: latest?.name ?? "", avatar: latest?.avatar ?? groupAvatarUrl(groupId) };
  } catch (error) {
    logger.warn({ err: error, groupId }, "获取群信息失败");
    return { ok: false, name: row.name, avatar: row.avatar };
  }
}

/** 绑定用户与群聊；已存在时幂等返回 false。 */
export function linkUserGroup(db: Db, userId: number, groupId: string): boolean {
  ensureGroup(db, groupId);
  const existing = db
    .select()
    .from(userGroups)
    .where(and(eq(userGroups.userId, userId), eq(userGroups.groupId, groupId)))
    .get();
  if (existing) {
    return false;
  }
  db.insert(userGroups)
    .values({ userId, groupId, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
  return true;
}

export function unlinkUserGroup(db: Db, userId: number, groupId: string): boolean {
  const existing = db
    .select()
    .from(userGroups)
    .where(and(eq(userGroups.userId, userId), eq(userGroups.groupId, groupId)))
    .get();
  if (!existing) {
    return false;
  }
  db.delete(userGroups)
    .where(and(eq(userGroups.userId, userId), eq(userGroups.groupId, groupId)))
    .run();
  return true;
}

export interface UserGroupRow {
  groupId: string;
  name: string;
  avatar: string;
  boundAt: number;
}

export function listUserGroups(db: Db, userId: number): UserGroupRow[] {
  const rows = db
    .select({
      groupId: groups.groupId,
      name: groups.name,
      avatar: groups.avatar,
      boundAt: userGroups.createdAt,
    })
    .from(userGroups)
    .innerJoin(groups, eq(groups.groupId, userGroups.groupId))
    .where(eq(userGroups.userId, userId))
    .orderBy(userGroups.createdAt)
    .all();

  return rows.map((row) => ({
    ...row,
    avatar: row.avatar || groupAvatarUrl(row.groupId),
  }));
}
