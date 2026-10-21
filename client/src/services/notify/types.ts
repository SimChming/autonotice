import type { Runtime } from '../../utils/platform'

/** 通知附带的负载：点击后用于直达详情页 */
export interface NotifyExtraPayload {
  itemId?: string
  due_at?: string | null
  alertId?: string
  /** 排程归属用户（用于按用户取消） */
  owner?: string
  /** 固定标记，便于识别「本应用」排的通知 */
  app?: string
  /** hash 路由，点击后跳转 */
  route?: string
}

/** 一次待排程的本地通知 */
export interface NotifyRequest {
  /** 稳定 id：同一 item 的同一提醒时间重复排程时可被覆盖 */
  id: string
  title: string
  body: string
  /** 触发时间（epoch ms） */
  at: number
  /** 高优先级（Android 高优 channel / allowWhileIdle） */
  highPriority?: boolean
  /** 点击跳转的 hash 路由 */
  route?: string
  extra: NotifyExtraPayload
}

export interface ScheduleOptions {
  /** 该平台允许的最大 pending 数（滚动窗口长度） */
  maxCount: number
  channelName?: string
}

export interface PermissionState {
  /** 系统通知总开关 */
  granted: boolean
  /** Android 12+ 「闹钟和提醒」精确定时；其他平台恒 true */
  exactAlarmGranted: boolean
  /** 是否需要引导用户去系统设置手动开启 */
  needsSystemSettings: boolean
  detail?: string
}

export interface ScheduleOutcome {
  scheduled: number
  dropped: number
}

/**
 * 跨端通知抽象。三种实现：web / capacitor(iOS+Android) / tauri(Windows)。
 * 壳内实现通过动态 import 加载插件，避免 H5 硬依赖。
 */
export interface PlatformNotify {
  readonly platform: Runtime

  /** 当前环境是否具备排程能力 */
  isAvailable(): boolean

  /**
   * 检查（并在 request=true 时申请）通知权限。
   * reschedule 时只检查不申请，避免每次回前台都弹权限框。
   */
  ensurePermission(request?: boolean): Promise<PermissionState>

  /** 取消「该用户全部已排通知」（滚动排程第 1 步） */
  cancelAllForUser(): Promise<void>

  /** 排程（调用方已按 maxCount 截断） */
  schedule(items: NotifyRequest[], options: ScheduleOptions): Promise<ScheduleOutcome>

  /**
   * 立即触发一条一次性通知（Agent 动作 / QQ 机器人指令）。
   * 不得影响滚动排程队列，也不受 cancelAllForUser 影响。
   */
  fireNow(req: NotifyRequest): Promise<void>

  /** App 回到前台时回调（用于滚动重排） */
  onAppResume(cb: () => void): () => void

  /** [可选] 申请 Android 12+ 精确定时权限 */
  requestExactAlarm?(): Promise<boolean>

  /** [可选] 跳转系统设置页（通知/自启动） */
  openSystemSettings?(): Promise<void>

  /** [可选] 取出「已送达」的高优 alert id（用于去重，避免重复打扰） */
  collectFiredAlerts?(): Promise<string[]>
}

/** 应用内兜底提醒事件：无法使用系统通知时由 App 层弹出应用内提示 */
export const REMINDER_EVENT = 'qqsa:reminder'
/** 应用内导航事件：通知被点击时由 App 层路由跳转 */
export const NAVIGATE_EVENT = 'qqsa:navigate'

export const APP_MARK = 'qqsa'
export const ALERT_CHANNEL = 'qqsa-schedule'
