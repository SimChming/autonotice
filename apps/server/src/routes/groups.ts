import type { FastifyInstance } from "fastify";
import {
  bindGroupRequestSchema,
  bindGroupResponseSchema,
  groupItemSchema,
  groupListResponseSchema,
} from "@autonotice/shared";
import type { Db } from "../db/client.js";
import type { OneBotClient } from "../onebot/client.js";
import { fail, requireUser } from "../auth/guard.js";
import {
  ensureGroup,
  linkUserGroup,
  listUserGroups,
  refreshGroupInfo,
  unlinkUserGroup,
} from "../services/groups.js";

interface GroupRouteOptions {
  db: Db;
  onebot: OneBotClient;
}

function toItem(row: { groupId: string; name: string; avatar: string; boundAt?: number }) {
  return groupItemSchema.parse({
    groupId: row.groupId,
    name: row.name,
    avatar: row.avatar,
    boundAt: row.boundAt === undefined ? undefined : new Date(row.boundAt).toISOString(),
  });
}

export function registerGroupRoutes(app: FastifyInstance, { db, onebot }: GroupRouteOptions): void {
  app.get("/api/v1/groups", async (request, reply) => {
    const claims = await requireUser(request, reply);
    if (!claims) {
      return;
    }
    const rows = listUserGroups(db, claims.sub);
    const items = rows.map((row) => toItem(row));
    // 群名缺失时后台补全，下一次刷新即可看到真实群名。
    for (const row of rows) {
      if (!row.name) {
        void refreshGroupInfo(onebot, db, row.groupId, app.log).catch(() => undefined);
      }
    }
    return groupListResponseSchema.parse({ items });
  });

  /** 绑定一个群聊：机器人必须在群里，否则拿不到真实群名。 */
  app.post("/api/v1/groups/bind", async (request, reply) => {
    const claims = await requireUser(request, reply);
    if (!claims) {
      return;
    }
    const parsed = bindGroupRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, "invalid_request", parsed.error.issues[0]?.message ?? "参数不合法");
    }

    const existing = ensureGroup(db, parsed.data.groupId);
    const info = await refreshGroupInfo(onebot, db, parsed.data.groupId, app.log);
    if (!info.name && !existing.name) {
      return fail(
        reply,
        400,
        "group_unavailable",
        "拿不到该群信息：请确认机器人已加入该群且在线后重试",
      );
    }

    linkUserGroup(db, claims.sub, parsed.data.groupId);
    const row = listUserGroups(db, claims.sub).find((item) => item.groupId === parsed.data.groupId);
    if (!row) {
      return fail(reply, 500, "internal_error", "绑定群聊失败，请稍后重试");
    }
    return bindGroupResponseSchema.parse({ group: toItem(row) });
  });

  app.delete("/api/v1/groups/:groupId", async (request, reply) => {
    const claims = await requireUser(request, reply);
    if (!claims) {
      return;
    }
    const groupId = String((request.params as { groupId: string }).groupId ?? "");
    if (!/^\d{5,12}$/.test(groupId)) {
      return fail(reply, 400, "invalid_request", "群号格式不正确");
    }
    if (!unlinkUserGroup(db, claims.sub, groupId)) {
      return fail(reply, 404, "not_found", "该群聊尚未绑定");
    }
    return reply.code(204).send();
  });
}
