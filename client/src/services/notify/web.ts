import type {
  NotifyRequest,
  PermissionState,
  PlatformNotify,
  ScheduleOptions,
  ScheduleOutcome
} from './types'
import { APP_MARK, NAVIGATE_EVENT, REMINDER_EVENT } from './types'

/** 兜底轮询间隔：浏览器后台 tab 的 setInterval 会被节流，取足够小的步长即可 */
const TICK_MS = 15000
/** 精确补一次最近一条的 setTimeout */
const MAX_TIMEOUT = 2147483647

/**
 * 纯 H5 实现：优先使用 Notification API；不可用或被拒绝时降级为
 * 「应用内提醒」（派发 REMINDER_EVENT 由 App 层弹横幅），
 * 始终保留 setInterval 轮询兜底，保证到点一定会被触发一次。
 */
export class WebNotifier implements PlatformNotify {
  readonly platform = 'web' as const

  private queue: NotifyRequest[] = []
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private precisionTimer: ReturnType<typeof setTimeout> | null = null
  private resumeCbs: Array<() => void> = []
  private firedAlerts: string[] = []
  private bound = false

  isAvailable(): boolean {
    return typeof window !== 'undefined'
  }

  // -------------------------------------------------------------------------
  // 权限
  // -------------------------------------------------------------------------

  async ensurePermission(request = false): Promise<PermissionState> {
    if (typeof window === 'undefined') {
      return { granted: false, exactAlarmGranted: true, needsSystemSettings: true, detail: '当前环境不支持通知' }
    }
    if (typeof Notification === 'undefined') {
      return {
        granted: false,
        exactAlarmGranted: true,
        needsSystemSettings: false,
        detail: '浏览器不支持系统通知，将改为应用内提醒'
      }
    }
    let status: NotificationPermission = Notification.permission
    if (status === 'default' && request) {
      try {
        status = await Notification.requestPermission()
      } catch {
        /* 部分环境不支持 Promise 版本，忽略 */
      }
    }
    return {
      granted: status === 'granted',
      exactAlarmGranted: true,
      needsSystemSettings: status === 'denied',
      detail:
        status === 'denied'
          ? '通知被拒绝：请在浏览器站点设置中重新允许通知，否则只能收到应用内提醒'
          : status === 'default'
            ? '尚未授权通知（点击「申请通知权限」）'
            : undefined
    }
  }

  // -------------------------------------------------------------------------
  // 排程
  // -------------------------------------------------------------------------

  async cancelAllForUser(): Promise<void> {
    this.queue = []
    this.stopTimers()
  }

  async schedule(items: NotifyRequest[], options: ScheduleOptions): Promise<ScheduleOutcome> {
    await this.cancelAllForUser()

    const now = Date.now()
    const sorted = items
      .filter((r) => r.at > now)
      .sort((a, b) => a.at - b.at)
      .slice(0, options.maxCount)

    this.queue = sorted
    this.startTimers()
    return { scheduled: sorted.length, dropped: Math.max(0, items.length - sorted.length) }
  }

  private startTimers(): void {
    this.stopTimers()
    if (!this.queue.length) return

    this.tickTimer = setInterval(() => this.tick(), TICK_MS)
    this.schedulePrecision()
  }

  /** 为最近一条单独设一个精确 setTimeout（长延时自动分片） */
  private schedulePrecision(): void {
    if (this.precisionTimer) clearTimeout(this.precisionTimer)
    const next = this.queue[0]
    if (!next) return
    const delay = next.at - Date.now()
    if (delay <= 0) {
      this.tick()
      return
    }
    if (delay > MAX_TIMEOUT) {
      this.precisionTimer = setTimeout(() => this.schedulePrecision(), MAX_TIMEOUT)
      return
    }
    this.precisionTimer = setTimeout(() => this.tick(), delay)
  }

  private stopTimers(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    if (this.precisionTimer) {
      clearTimeout(this.precisionTimer)
      this.precisionTimer = null
    }
  }

  private tick(): void {
    const now = Date.now()
    const due = this.queue.filter((r) => r.at <= now)
    if (!due.length) {
      if (!this.queue.length) this.stopTimers()
      else this.schedulePrecision()
      return
    }
    this.queue = this.queue.filter((r) => r.at > now)
    for (const req of due) this.fire(req)
    if (this.queue.length) this.schedulePrecision()
    else this.stopTimers()
  }

  private fire(req: NotifyRequest): void {
    const granted =
      typeof Notification !== 'undefined' && Notification.permission === 'granted'

    if (granted) {
      try {
        const n = new Notification(req.title, {
          body: req.body,
          tag: req.id,
          requireInteraction: Boolean(req.highPriority),
          data: req.extra
        } as NotificationOptions)
        n.onclick = () => {
          this.emitNavigate(req.route)
          n.close()
        }
        return
      } catch {
        /* 部分环境（移动浏览器）构造 Notification 会抛错 → 走应用内提醒 */
      }
    }
    this.emitReminder(req)
  }

  private emitReminder(req: NotifyRequest): void {
    if (typeof window === 'undefined') return
    if (req.extra?.alertId) this.firedAlerts.push(req.extra.alertId)
    window.dispatchEvent(
      new CustomEvent(REMINDER_EVENT, {
        detail: { title: req.title, body: req.body, route: req.route, highPriority: req.highPriority }
      })
    )
  }

  private emitNavigate(route?: string): void {
    if (typeof window === 'undefined') return
    if (route) window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { route } }))
    try {
      window.focus()
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // 回前台
  // -------------------------------------------------------------------------

  onAppResume(cb: () => void): () => void {
    this.resumeCbs.push(cb)
    if (!this.bound && typeof document !== 'undefined') {
      this.bound = true
      const handler = () => {
        if (document.visibilityState === 'visible') {
          // 长时间后台后 queue 可能已过期，交给调用方重排
          this.tick()
          this.resumeCbs.forEach((fn) => {
            try {
              fn()
            } catch {
              /* ignore */
            }
          })
        }
      }
      document.addEventListener('visibilitychange', handler)
      window.addEventListener('focus', handler)
    }
    return () => {
      this.resumeCbs = this.resumeCbs.filter((fn) => fn !== cb)
    }
  }

  /** 仅用于调试/自检 */
  pendingCount(): number {
    return this.queue.length
  }

  async collectFiredAlerts(): Promise<string[]> {
    const out = this.firedAlerts
    this.firedAlerts = []
    return out
  }

  get mark(): string {
    return APP_MARK
  }
}
