import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  adminOpsResponseSchema,
  adminShellRequestSchema,
  adminShellResponseSchema,
  SERVICE_VERSION,
} from "@autonotice/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { adminAudit } from "../db/schema.js";
import type { OneBotClient } from "../onebot/client.js";
import { fail, requireAdmin } from "../auth/guard.js";
import { runShell } from "../bot/shell.js";

interface AdminOpsRouteOptions {
  db: Db;
  config: Config;
  onebot: OneBotClient;
}

function readWebuiToken(path: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return typeof parsed.token === "string" ? parsed.token : "";
  } catch {
    return "";
  }
}

/** 运维页与管理员 Shell：NapCat 入口、OneBot 状态、容器内命令执行。 */
export function registerAdminOpsRoutes(
  app: FastifyInstance,
  { db, config, onebot }: AdminOpsRouteOptions,
): void {
  app.get("/api/v1/admin/ops", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }

    let selfId: string | null = null;
    let nickname: string | null = null;
    let appVersion: string | null = null;
    let protocolVersion: string | null = null;

    if (onebot.connected) {
      try {
        const info = await onebot.request<Record<string, unknown>>("get_login_info", {}, 4000);
        if (typeof info.user_id === "number" || typeof info.user_id === "string") {
          selfId = String(info.user_id);
        }
        if (typeof info.nickname === "string") {
          nickname = info.nickname;
        }
      } catch {
        // 机器人未登录或调用超时，保持空值即可。
      }
      try {
        const version = await onebot.request<Record<string, unknown>>("get_version_info", {}, 4000);
        if (typeof version.app_version === "string") {
          appVersion = version.app_version;
        }
        if (typeof version.protocol_version === "string") {
          protocolVersion = version.protocol_version;
        }
      } catch {
        // 同上。
      }
    }

    return adminOpsResponseSchema.parse({
      service: {
        version: SERVICE_VERSION,
        uptime: process.uptime(),
        onebotConnected: onebot.connected,
      },
      onebot: { selfId, nickname, appVersion, protocolVersion },
      napcat: {
        webuiPath: "/webui/",
        account: config.napcat.account,
        container: "autonotice-napcat",
        webuiToken: readWebuiToken(config.napcat.webuiConfigPath),
      },
    });
  });

  app.post("/api/v1/admin/shell", async (request, reply) => {
    const claims = await requireAdmin(request, reply);
    if (!claims) {
      return;
    }
    const parsed = adminShellRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, "invalid_request", parsed.error.issues[0]?.message ?? "参数不合法");
    }

    const result = await runShell(parsed.data.command);
    try {
      db.insert(adminAudit)
        .values({
          adminId: null,
          action: "shell",
          detail: parsed.data.command.slice(0, 500),
          createdAt: Date.now(),
        })
        .run();
    } catch {
      // 审计写入失败不影响命令结果。
    }
    return adminShellResponseSchema.parse(result);
  });
}
