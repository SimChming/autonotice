import { and, eq, isNull, lte } from "drizzle-orm";
import cron from "node-cron";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../db/client.js";
import { alerts, bindings } from "../db/schema.js";
import type { NotifyHub } from "../notify/hub.js";
import type { OneBotClient } from "../onebot/client.js";

interface SchedulerOptions {
  db: Db;
  hub: NotifyHub;
  onebot: OneBotClient;
  logger: FastifyBaseLogger;
}

async function dispatchDueAlerts(options: SchedulerOptions): Promise<void> {
  const { db, hub, onebot, logger } = options;
  const now = Date.now();
  const due = db
    .select()
    .from(alerts)
    .where(and(lte(alerts.at, now), isNull(alerts.sentAt)))
    .limit(50)
    .all();

  for (const alert of due) {
    const payload = {
      type: "alert",
      id: alert.id,
      scheduleId: alert.scheduleId,
      level: alert.level,
      title: alert.title,
      body: alert.body,
      at: new Date(alert.at).toISOString(),
    };

    let delivered = hub.push(alert.userId, payload);

    if (!delivered && onebot.connected) {
      const binding = db.select().from(bindings).where(eq(bindings.userId, alert.userId)).get();
      if (binding) {
        try {
          await onebot.sendPrivateMsg(binding.qq, `⏰ ${alert.title}${alert.body ? `\n${alert.body}` : ""}`);
          delivered = true;
        } catch (error) {
          logger.warn({ err: error, alertId: alert.id }, "QQ 私聊提醒发送失败");
        }
      }
    }

    if (delivered) {
      db.update(alerts).set({ sentAt: now }).where(eq(alerts.id, alert.id)).run();
    }
  }
}

/** 每 30 秒扫描到期提醒：优先 WS，离线时 QQ 私聊兜底。 */
export function startReminderScheduler(options: SchedulerOptions) {
  return cron.schedule("*/30 * * * * *", () => {
    void dispatchDueAlerts(options).catch((error: unknown) => {
      options.logger.error({ err: error }, "提醒调度失败");
    });
  });
}
