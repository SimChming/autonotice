import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { OWNER_QQ } from "@autonotice/shared";
import type { Db } from "../db/client.js";
import { alerts, bindings } from "../db/schema.js";
import type { NotifyHub } from "./hub.js";
import type { OneBotClient } from "../onebot/client.js";

/** 掉线多久后提醒主人；以及同一轮离线的最短重复提醒间隔。 */
const OFFLINE_ALERT_AFTER_MS = 2 * 60 * 1000;
const ALERT_REPEAT_MS = 6 * 60 * 60 * 1000;
const TICK_MS = 60 * 1000;

interface WatchdogOptions {
  db: Db;
  hub: NotifyHub;
  onebot: OneBotClient;
  logger: FastifyBaseLogger;
}

/** 通过 WS 系统通知 + 提醒列表告知主人：机器人掉线了，需要扫码。 */
function alertOwner(options: WatchdogOptions): void {
  const { db, hub, logger } = options;
  const binding = db.select().from(bindings).where(eq(bindings.qq, OWNER_QQ)).get();
  if (!binding) {
    logger.warn("OneBot 掉线，但主人 QQ 尚未绑定账号，无法推送提醒");
    return;
  }

  const now = Date.now();
  const title = "机器人 QQ 已掉线";
  const body = "NapCat 登录已失效，请在后台「运维」页扫码重新登录。";
  try {
    const inserted = db
      .insert(alerts)
      .values({
        userId: binding.userId,
        scheduleId: null,
        level: "urgent",
        title,
        body,
        route: "ws",
        at: now,
        sentAt: now,
      })
      .run();
    hub.push(binding.userId, {
      type: "alert",
      id: Number(inserted.lastInsertRowid),
      scheduleId: null,
      level: "urgent",
      title,
      body,
      at: new Date(now).toISOString(),
    });
    logger.warn({ userId: binding.userId }, "OneBot 已掉线，已提醒主人重新扫码");
  } catch (error) {
    logger.warn({ err: error }, "OneBot 掉线提醒写入失败");
  }
}

/**
 * 反向 WS 掉线看门狗：QQ 被腾讯踢下线后 NapCat 会停在二维码登录态，
 * 服务端会一直等不到重连，这里主动提醒主人去扫码。
 */
export function startOneBotWatchdog(options: WatchdogOptions) {
  let offlineSince: number | null = options.onebot.connected ? null : Date.now();
  let alertedAt: number | null = null;

  const timer = setInterval(() => {
    const now = Date.now();
    if (options.onebot.connected) {
      if (offlineSince !== null) {
        options.logger.info({ offlineMs: now - offlineSince }, "OneBot 已恢复连接");
      }
      offlineSince = null;
      alertedAt = null;
      return;
    }

    offlineSince ??= now;
    if (now - offlineSince < OFFLINE_ALERT_AFTER_MS) {
      return;
    }
    if (alertedAt !== null && now - alertedAt < ALERT_REPEAT_MS) {
      return;
    }
    alertedAt = now;
    alertOwner(options);
  }, TICK_MS);

  timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}
