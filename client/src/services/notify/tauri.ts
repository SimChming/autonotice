import { isTauri } from '../../utils/platform'
import type {
  NotifyRequest,
  PermissionState,
  PlatformNotify,
  ScheduleOptions,
  ScheduleOutcome
} from './types'
import { ALERT_CHANNEL, APP_MARK, NAVIGATE_EVENT } from './types'

/**
 * Tauri 2 (Windows) 实现。
 *
 * 双保险策略：
 *  1. JS 侧通过 `@tauri-apps/plugin-notification` 保证「应用在运行」时的即时通知；
 *  2. 把整个滚动窗口交给 Rust 侧（命令 `set_schedule`），由 tokio 定时线程负责到点弹窗，
 *     即使窗口最小化/隐藏也照样触发；Rust 侧记录「最近触发项」，JS 回前台时取回做点击跳转。
 *
 * 所有壳插件都通过动态 import 加载，纯 H5 构建不硬依赖。
 */
export class TauriNotifier implements PlatformNotify {
  readonly platform = 'tauri' as const

  private notif: any = null
  private core: any = null
  private inited = false
  private resumeCbs: Array<() => void> = []
  private bound = false
  private inSession = new Map<string, ReturnType<typeof setTimeout>>()

  isAvailable(): boolean {
    return isTauri()
  }

  private async init(): Promise<void> {
    if (this.inited) return
    const [notifMod, coreMod]: any[] = await Promise.all([
      import(/* webpackChunkName: "tauri-notification" */ '@tauri-apps/plugin-notification'),
      import(/* webpackChunkName: "tauri-core" */ '@tauri-apps/api/core')
    ])
    this.notif = notifMod
    this.core = coreMod
    if (!this.core?.invoke) throw new Error('@tauri-apps/api 不可用')

    try {
      if (typeof this.notif.createChannel === 'function') {
        await this.notif.createChannel({ id: ALERT_CHANNEL, name: '日程提醒', importance: 5 })
      }
    } catch {
      /* ignore */
    }
    this.inited = true
  }

  // -------------------------------------------------------------------------
  // 权限
  // -------------------------------------------------------------------------

  async ensurePermission(request = false): Promise<PermissionState> {
    await this.init()
    let granted = false
    try {
      granted = await this.notif.isPermissionGranted()
      if (!granted && request) {
        granted = (await this.notif.requestPermission()) === 'granted'
      }
    } catch {
      /* ignore */
    }
    return {
      granted,
      exactAlarmGranted: true,
      needsSystemSettings: !granted,
      detail: granted ? undefined : 'Windows 需要在「设置 → 系统 → 通知」中允许本应用发送通知'
    }
  }

  // -------------------------------------------------------------------------
  // 排程
  // -------------------------------------------------------------------------

  async cancelAllForUser(): Promise<void> {
    await this.init()
    this.clearSessionTimers()
    try {
      await this.core.invoke('clear_schedule')
    } catch {
      /* ignore */
    }
    try {
      if (typeof this.notif.cancelAll === 'function') await this.notif.cancelAll()
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

    try {
      // 交给 Rust：关窗/托盘常驻时也准时触发
      await this.core.invoke('set_schedule', {
        entries: selected.map((r) => ({
          id: r.id,
          title: r.title,
          body: r.body,
          at: r.at,
          highPriority: Boolean(r.highPriority),
          route: r.route ?? '',
          alertId: r.extra.alertId ?? '',
          itemId: r.extra.itemId ?? ''
        }))
      })
    } catch {
      /* Rust 命令不可用时退化为会话内定时 */
    }

    this.clearSessionTimers()
    for (const r of selected) {
      const delay = r.at - Date.now()
      if (delay <= 0 || delay > 2147483647) continue
      const t = setTimeout(() => {
        void this.fireNow(r)
        this.inSession.delete(r.id)
      }, delay)
      this.inSession.set(r.id, t)
    }

    return { scheduled: selected.length, dropped: Math.max(0, items.length - selected.length) }
  }

  private async fireNow(r: NotifyRequest): Promise<void> {
    try {
      await this.notif.sendNotification({
        title: r.title,
        body: r.body,
        channelId: ALERT_CHANNEL
      })
    } catch {
      /* ignore */
    }
  }

  private clearSessionTimers(): void {
    for (const t of this.inSession.values()) clearTimeout(t)
    this.inSession.clear()
  }

  async collectFiredAlerts(): Promise<string[]> {
    try {
      await this.init()
      const fired = await this.core.invoke('take_fired')
      if (!Array.isArray(fired)) return []
      return fired.map((f: any) => f?.alertId).filter((id: any) => typeof id === 'string' && id)
    } catch {
      return []
    }
  }

  // -------------------------------------------------------------------------
  // 回前台
  // -------------------------------------------------------------------------

  onAppResume(cb: () => void): () => void {
    this.resumeCbs.push(cb)
    void this.init().catch(() => undefined)

    if (!this.bound && typeof window !== 'undefined') {
      this.bound = true
      const handler = () => {
        this.resumeCbs.forEach((fn) => {
          try {
            fn()
          } catch {
            /* ignore */
          }
        })
      }
      window.addEventListener('focus', handler)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') handler()
      })

      void this.init()
        .then(async () => {
          // Rust 侧 tokio 线程到点弹窗后 emit `qqsa://fired`，点击直达详情
          try {
            const evt: any = await import(/* webpackChunkName: "tauri-event" */ '@tauri-apps/api/event')
            if (evt?.listen) {
              await evt.listen('qqsa://fired', (event: any) => {
                const route = event?.payload?.route
                if (route) {
                  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { route } }))
                }
              })
            }
          } catch {
            /* ignore */
          }

          // 兜底：取回 JS 加载前已触发过的最近一条
          try {
            const last = await this.core.invoke('take_last_fired')
            if (last?.route) {
              window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { route: last.route } }))
            }
          } catch {
            /* ignore */
          }
        })
        .catch(() => undefined)
    }

    return () => {
      this.resumeCbs = this.resumeCbs.filter((fn) => fn !== cb)
    }
  }

  get mark(): string {
    return APP_MARK
  }
}
