import type { FastifyInstance } from "fastify";
import { bindConfirmRequestSchema, bindConfirmResponseSchema, bindStartRequestSchema, bindStartResponseSchema, bindStatusResponseSchema } from "@autonotice/shared";
import type { Db } from "../db/client.js";
import type { Config } from "../config.js";
import type { OneBotClient } from "../onebot/client.js";
import { fail, requireUser } from "../auth/guard.js";
import { confirmBind, getUserBinding, startBind } from "../services/bind.js";
import { linkUserGroup, refreshGroupInfo } from "../services/groups.js";

interface BindRouteOptions {
  db: Db;
  config: Config;
  onebot: OneBotClient;
}

export function registerBindRoutes(
  app: FastifyInstance,
  { db, config, onebot }: BindRouteOptions,
): void {
  app.post("/api/v1/bind/start", async (request, reply) => {
    const claims = await requireUser(request, reply);
    if (!claims) {
      return;
    }

    const parsed = bindStartRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, "invalid_request", parsed.error.issues[0]?.message ?? "参数不合法");
    }

    const result = startBind(db, claims.sub, parsed.data.qq, config.bind.codeTtlSeconds);
    if (!result.ok) {
      return fail(reply, 409, "qq_taken", "该 QQ 已被其他账号绑定");
    }

    return bindStartResponseSchema.parse({
      code: result.ticket.code,
      qq: parsed.data.qq,
      expiresAt: new Date(result.ticket.expiresAt).toISOString(),
      groupId: config.bind.groupId,
      instruction: `请用 QQ ${parsed.data.qq} 在群 ${config.bind.groupId} 内发送：${result.ticket.code}`,
    });
  });

  app.get("/api/v1/bind/status", async (request, reply) => {
    const claims = await requireUser(request, reply);
    if (!claims) {
      return;
    }
    const binding = getUserBinding(db, claims.sub);
    if (!binding) {
      return bindStatusResponseSchema.parse({ bound: false });
    }
    return bindStatusResponseSchema.parse({
      bound: true,
      qq: binding.qq,
      verifiedAt: new Date(binding.verifiedAt).toISOString(),
    });
  });

  app.post("/api/v1/bind/confirm", async (request, reply) => {
    const claims = await requireUser(request, reply);
    if (!claims) {
      return;
    }

    const parsed = bindConfirmRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, "invalid_request", parsed.error.issues[0]?.message ?? "参数不合法");
    }

    const bound = confirmBind(db, claims.sub, parsed.data.code);
    if (!bound) {
      return fail(reply, 400, "invalid_code", "绑定码无效或已过期");
    }

    // 绑定 QQ 的同时把主群加入该用户的群聊列表（多群聊管理的第一条）。
    linkUserGroup(db, claims.sub, config.bind.groupId);
    void refreshGroupInfo(onebot, db, config.bind.groupId, app.log).catch(() => undefined);

    return bindConfirmResponseSchema.parse({
      qq: bound.qq,
      verifiedAt: new Date(bound.verifiedAt).toISOString(),
    });
  });
}
