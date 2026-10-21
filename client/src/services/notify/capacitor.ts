import { hashCode } from '../../utils/storage'
import { isCapacitor } from '../../utils/platform'
import type {
  NotifyRequest,
  PermissionState,
  PlatformNotify,
  ScheduleOptions,
  ScheduleOutcome
} from './types'
import { ALERT_CHANNEL, APP_MARK, REMINDER_EVENT } from './types'

/**
 * Capacitor (iOS / Android) 实现 —— 真实调用 `@capacitor/local-notifications`。
 *
 * - 通过动态 import 加载插件，H5 下永不执行，保证 H5 编译不硬依赖壳插件。
 * - iOS 严格守 64 条 pending 上限（由调度器截断到 60）。
 * - Android 12+ 精确定时需 SCHEDULE_EXACT_ALARM / 闹钟与提醒权限，未授予则降级并提示。
 */
export class CapacitorNotifier implements PlatformNotify {
  readonly platform = 'capacitor' as const

  private ln: any = null
  private app: any = null
  private inited = false
  private resumeCbs: Array<() => void> = []

  isAvailable(): boolean {
    return isCapacitor()
  }

  private async init(): Promise<void> {
    if (this.inited) return
    // 动态 import：不在 H5 打包路径上运行，仅在能力探测命中时加载
    const mod: any = await import(/* webpackChunkName: "cap-local-notifications" */ '@capacitor/local-notifications')
    this.ln = mod?.LocalNotifications ?? mod?.default?.LocalNotifications
    if (!this.ln) throw new Error('@capacitor/local-notifications 不可用')

    try {
      const appMod: any = await import(/* webpackChunkName: "cap-app" */ '@capacitor/app')
      this.app = appMod?.App ?? appMod?.default?.App
    } catch {
      this.app = null
    }

    try {
      await this.ln.createChannel({
        id: ALERT_CHANNEL,
        name: '日程提醒',
        description: 'QQ 群 AI 日程助手的到点提醒',
        importance: 5,
        visibility: 1,
        vibration: true
      })
    } catch {
      /* iOS 无 channel 概念，忽略 */
    }

    if (this.app?.addListener) {
      try {
        await this.app.addListener('appStateChange', (state: any) => {
          if (state?.isActive) this.resumeCbs.forEach((cb) => cb())
        })
      } catch {
        /* ignore */
      }
    }

    this.inited = true
  }

  // -------------------------------------------------------------------------
  // 权限
  // -------------------------------------------------------------------------

  async ensurePermission(request = false): Promise<PermissionState> {
    await this.init()

    let display: string = 'prompt'
    try {
      const cur = await this.ln.checkPermissions()
      display = cur?.display ?? 'prompt'
      if (display !== 'granted' && request) {
        const asked = await this.ln.requestPermissions()
        display = asked?.display ?? display
      }
    } catch {
      /* ignore */
    }

    let exactAlarmGranted = true
    let needsSystemSettings = display === 'denied'
    let detail: string | undefined =
      display === 'denied' ? '系统通知被关闭：请在系统设置中允许本应用发送通知' : undefined

    try {
      if (typeof this.ln.checkExactNotificationSetting === 'function') {
        const exact = await this.ln.checkExactNotificationSetting()
        if (exact && 'exact_alarm' in exact) {
          exactAlarmGranted = exact.exact_alarm === 'granted'
          if (!exactAlarmGranted) {
            needsSystemSettings = true
            detail =
              'Android 12+ 需要「闹钟和提醒」权限才能准点提醒；未开启时通知可能被系统延后（降级为不精确定时）'
          }
        }
      }
    } catch {
      /* 非 Android 或插件版本不支持，视为精确可用 */
    }

    return { granted: display === 'granted', exactAlarmGranted, needsSystemSettings, detail }
  }

  /** 引导用户开启「闹钟和提醒」（Android 12+） */
  async requestExactAlarm(): Promise<boolean> {
    await this.init()
    try {
      if (typeof this.ln.changeExactNotificationSetting !== 'function') return true
      const res = await this.ln.changeExactNotificationSetting()
      return res?.exact_alarm === 'granted'
    } catch {
      return false
    }
  }

  async openSystemSettings(): Promise<void> {
    await this.init()
    try {
      // Capacitor 没有统一的「打开应用通知设置」API，交给壳工程说明文案引导
      if (typeof this.ln.checkPermissions === 'function') {
        await this.ln.requestPermissions()
      }
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // 排程
  // -------------------------------------------------------------------------

  async cancelAllForUser(): Promise<void> {
    await this.init()
    try {
      const pending = await this.ln.getPending()
      const all: any[] = pending?.notifications ?? []
      const ours = all.filter((n) => n?.extra?.app === APP_MARK)
      const targets = ours.length ? ours : all
      if (targets.length) {
        await this.ln.cancel({ notifications: targets.map((n) => ({ id: n.id })) })
      }
    } catch {
      /* ignore */
    }
  }

  async schedule(items: NotifyRequest[], options: ScheduleOptions): Promise<ScheduleOutcome> {
    await this.init()
    const now = Date.now()
    const selected = items
      .filter((r) => r.at > now)
      .sort((a, b) => a.at - b.at)
      .slice(0, options.maxCount)

    if (!selected.length) return { scheduled: 0, dropped: items.length }

    const notifications = selected.map((r) => ({
      id: hashCode(r.id),
      title: r.title,
      body: r.body,
      channelId: ALERT_CHANNEL,
      schedule: {
        at: new Date(r.at),
        // Android 12+ Doze 下用 allowWhileIdle（系统限制每 9 分钟最多一次）
        allowWhileIdle: Boolean(r.highPriority)
      },
      extra: {
        app: APP_MARK,
        itemId: r.extra.itemId,
        due_at: r.extra.due_at,
        alertId: r.extra.alertId,
        owner: r.extra.owner,
        route: r.route
      }
    }))

    try {
      await this.ln.schedule({ notifications })
    } catch (err) {
      // 常见：iOS 超过 64 条 / 精确定时权限缺失 → 由调用方下次重排收敛
      return { scheduled: 0, dropped: items.length }
    }

    return { scheduled: selected.length, dropped: Math.max(0, items.length - selected.length) }
  }

  /** 一次性立即提醒：直接发一条本地通知，不进滚动队列 */
  async fireNow(req: NotifyRequest): Promise<void> {
    try {
      await this.init()
      const notification: any = {
        id: hashCode(req.id),
        title: req.title,
        body: req.body,
        channelId: ALERT_CHANNEL,
        extra: {
          app: APP_MARK,
          itemId: req.extra.itemId,
          due_at: req.extra.due_at,
          alertId: req.extra.alertId,
          owner: req.extra.owner,
          route: req.route
        }
      }
      if (req.at > Date.now() + 1000) {
        notification.schedule = {
          at: new Date(req.at),
          allowWhileIdle: Boolean(req.highPriority)
        }
      }
      await this.ln.schedule({ notifications: [notification] })
      return
    } catch {
      // 权限缺失或插件不可用 → 回落到应用内横幅
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent(REMINDER_EVENT, {
          detail: { title: req.title, body: req.body, route: req.route, highPriority: req.highPriority }
        })
      )
    }
  }

  async collectFiredAlerts(): Promise<string[]> {
    try {
      await this.init()
      const delivered = await this.ln.getDeliveredNotifications()
      const ids: string[] = []
      for (const n of delivered?.notifications ?? []) {
        if (n?.extra?.app === APP_MARK && n.extra.alertId) ids.push(n.extra.alertId)
      }
      return ids
    } catch {
      return []
    }
  }

  onAppResume(cb: () => void): () => void {
    this.resumeCbs.push(cb)
    void this.init().catch(() => undefined)
    return () => {
      this.resumeCbs = this.resumeCbs.filter((fn) => fn !== cb)
    }
  }
}
