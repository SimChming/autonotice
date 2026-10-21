import type { ScheduleItem } from '../../types'
import { useAlertsStore } from '../../store/alerts'
import { useAuthStore } from '../../store/auth'
import { useNotifyStore, type NotifySettings } from '../../store/notify'
import { useScheduleStore } from '../../store/schedule'
import type { NotifyRequest, PermissionState, PlatformNotify } from './types'
import type { Runtime } from '../../utils/platform'
import {
  DAY,
  HOUR,
  MINUTE,
  fmtDate,
  fmtTime,
  parseDate,
  startOfDay,
  toMs
} from '../../utils/date'
import { getNotifier } from './platform'

/** 每日简报时间（本地时区） */
export const DIGEST_HOUR = 8

/** remind_at 为空时，基于 due_at 的默认提醒偏移（分钟） */
export const DEFAULT_OFFSETS_MINUTES = [-24 * 60, -2 * 60, -15]

const TYPE_LABEL: Record<string, string> = {
  exam: '考试',
  deadline: '作业截止',
  payment: '缴费',
  event: '活动',
  other: '日程'
}

const RESCHEDULE_THROTTLE_MS = 15 * 1000

// ---------------------------------------------------------------------------
// 候选提醒构造
// ---------------------------------------------------------------------------

function itemTitle(item: ScheduleItem): string {
  return item.title || '未命名日程'
}

function describe(item: ScheduleItem, at: number, due: number | null): string {
  const label = TYPE_LABEL[item.type] || '日程'
  const tail = item.notes ? `　·　${item.notes.slice(0, 40)}` : ''
  if (due === null) return `${label}提醒 · ${fmtDate(at)} ${fmtTime(at)}${tail}`
  const diff = due - at
  if (diff <= 0) return `${label} · 已到截止时间 ${fmtTime(due)}${tail}`
  if (diff < HOUR) return `${label} · 还有 ${Math.max(1, Math.round(diff / MINUTE))} 分钟截止（${fmtTime(due)}）${tail}`
  if (diff < DAY) return `${label} · 还有 ${Math.round(diff / HOUR)} 小时截止（${fmtTime(due)}）${tail}`
  return `${label} · 还有 ${Math.round(diff / DAY)} 天截止（${fmtDate(due)} ${fmtTime(due)}）${tail}`
}

/** 单个 item → 若干条候选提醒（可能多个偏移） */
function requestsForItem(
  item: ScheduleItem,
  offsetsMinutes: number[],
  owner: string,
  highPriorityOnly = false
): NotifyRequest[] {
  if (item.status === 'done' || item.status === 'ignored') return []

  const due = toMs(item.due_at)
  const remind = toMs(item.remind_at)
  let times: number[] = []

  if (remind !== null) {
    // 用户/AI 指定的提醒时间优先，单条
    times = [remind]
  } else if (due !== null) {
    if (item.all_day) {
      // 全天事项：当天 08:00 提醒一次
      times = [startOfDay(due).getTime() + DIGEST_HOUR * HOUR]
    } else {
      times = offsetsMinutes.map((m) => due + m * MINUTE)
    }
  }

  const out: NotifyRequest[] = []
  for (const at of times) {
    if (!Number.isFinite(at)) continue
    // 临近截止（≤1h）/ 高优先级 / 进行中 → 高优先通知（Android 走 allowWhileIdle）
    const urgent =
      item.priority === 'high' ||
      item.status === 'doing' ||
      (due !== null && due - at <= 60 * MINUTE)
    const route = `/pages/detail/index?id=${encodeURIComponent(item.id)}`
    out.push({
      id: `${item.id}|${at}`,
      title: itemTitle(item),
      body: describe(item, at, due),
      at,
      highPriority: highPriorityOnly ? item.priority === 'high' : urgent,
      route,
      extra: { itemId: item.id, due_at: item.due_at, owner, route }
    })
  }
  return out
}

/** 每日 08:00 简报 */
function digestRequest(items: ScheduleItem[], owner: string, now: number): NotifyRequest {
  let at = startOfDay(now).getTime() + DIGEST_HOUR * HOUR
  if (at <= now) at += DAY

  const today = items.filter((it) => {
    if (it.status === 'done' || it.status === 'ignored') return false
    const due = toMs(it.due_at)
    if (due === null) return false
    return due >= startOfDay(now).getTime() && due <= startOfDay(now).getTime() + DAY
  })
  const overdue = items.filter((it) => {
    if (it.status === 'done' || it.status === 'ignored') return false
    const due = toMs(it.due_at)
    return due !== null && due < now
  })

  const next = today.slice().sort((a, b) => (toMs(a.due_at) || 0) - (toMs(b.due_at) || 0))[0]
  const parts: string[] = []
  parts.push(today.length ? `今天有 ${today.length} 项待办` : '今天没有到期的日程')
  if (next) parts.push(`最近：${itemTitle(next)} ${fmtTime(next.due_at)}`)
  if (overdue.length) parts.push(`${overdue.length} 项已逾期`)

  return {
    id: `digest|${at}`,
    title: '今日日程简报',
    body: parts.join('　·　'),
    at,
    highPriority: false,
    route: '/pages/schedule/index',
    extra: { owner, route: '/pages/schedule/index' }
  }
}

/** 未读高优告警 → 立即（5s 后）提醒 */
function alertRequests(owner: string, now: number): NotifyRequest[] {
  const { alerts, notified } = useAlertsStore.getState()
  const seen = new Set(notified)
  const out: NotifyRequest[] = []
  for (const a of alerts) {
    if (a.read_at || seen.has(a.id)) continue
    if (a.level !== 'high') continue
    out.push({
      id: `alert|${a.id}`,
      title: `需人工查看：${a.title || '有一条需要你确认的内容'}`,
      body: a.summary || a.context_excerpt || '有一条内容因被屏蔽/无法抓取，建议亲自查看',
      at: now + 5000,
      highPriority: true,
      route: `/pages/detail/index?alertId=${encodeURIComponent(a.id)}`,
      extra: { alertId: a.id, owner, route: `/pages/detail/index?alertId=${encodeURIComponent(a.id)}` }
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 滚动排程算法
// ---------------------------------------------------------------------------

/**
 * 构造全部候选提醒（未截断、未过滤过期）。
 * 顺序：item 提醒 → 每日简报 → 未读高优告警。
 */
export function buildRequests(options?: {
  settings?: NotifySettings
  includeAlerts?: boolean
  now?: number
  owner?: string
}): NotifyRequest[] {
  const now = options?.now ?? Date.now()
  const settings = options?.settings ?? useNotifyStore.getState().settings
  const owner = options?.owner ?? useAuthStore.getState().user?.id ?? 'anon'
  const offsets = settings.offsetsMinutes?.length ? settings.offsetsMinutes : DEFAULT_OFFSETS_MINUTES
  const items = useScheduleStore.getState().items

  const requests: NotifyRequest[] = []
  for (const item of items) {
    requests.push(...requestsForItem(item, offsets, owner, settings.highPriorityOnly))
  }

  if (settings.digestEnabled) requests.push(digestRequest(items, owner, now))

  if (options?.includeAlerts !== false) requests.push(...alertRequests(owner, now))

  // 过滤已过去的时间点，并按 remind_at（触发时间）升序
  return requests.filter((r) => r.at > now).sort((a, b) => a.at - b.at)
}

/** 第 3 步：按触发时间升序取最近 N 条 */
export function selectWindow(requests: NotifyRequest[], maxCount: number): NotifyRequest[] {
  return requests.slice().sort((a, b) => a.at - b.at).slice(0, Math.max(0, maxCount))
}

export interface RescheduleResult {
  platform: Runtime
  permission: PermissionState
  /** 实际排程数 */
  scheduled: number
  /** 因窗口上限被舍弃数 */
  dropped: number
  /** 候选总数 */
  total: number
  at: number
}

let lastRunAt = 0

/**
 * 完整滚动重排：
 *  1) 取消该用户全部已排通知
 *  2) 由 remind_at（空则 due_at + 默认偏移）算提醒 + 每日 08:00 简报
 *  3) 升序取最近 N 条（iOS/Android ≤60、Windows ≤80）
 *  4) extra 带 {itemId, due_at, alertId}
 *  5) 简报通知点开触发重排 → 滚动窗口
 */
export async function reschedule(options?: {
  request?: boolean
  force?: boolean
  includeAlerts?: boolean
}): Promise<RescheduleResult> {
  const notifier: PlatformNotify = await getNotifier()
  const now = Date.now()

  const notifyStore = useNotifyStore.getState()
  notifyStore.setRuntime(notifier.platform)

  if (!options?.force && now - lastRunAt < RESCHEDULE_THROTTLE_MS) {
    return {
      platform: notifier.platform,
      permission: notifyStore.permission,
      scheduled: notifyStore.scheduledCount,
      dropped: notifyStore.droppedCount,
      total: notifyStore.scheduledCount + notifyStore.droppedCount,
      at: now
    }
  }
  lastRunAt = now

  // 先收「已送达」的高优告警，避免重复打扰
  try {
    const fired = (await notifier.collectFiredAlerts?.()) ?? []
    if (fired.length) useAlertsStore.getState().markNotified(fired)
  } catch {
    /* ignore */
  }

  const permission = await notifier.ensurePermission(Boolean(options?.request))
  notifyStore.setPermission(permission)

  // 1) 取消该用户全部已排通知
  await notifier.cancelAllForUser()

  // 2~3) 构造候选 + 截断
  const candidates = buildRequests({ includeAlerts: options?.includeAlerts !== false, now })
  const maxCount = notifyStore.maxCount
  const window = selectWindow(candidates, maxCount)

  const outcome = await notifier.schedule(window, {
    maxCount,
    channelName: '日程提醒'
  })

  useNotifyStore.getState().recordSchedule(outcome.scheduled, outcome.dropped)

  const alertIds = window.map((r) => r.extra.alertId).filter((v): v is string => Boolean(v))
  if (alertIds.length) useAlertsStore.getState().markNotified(alertIds)

  return {
    platform: notifier.platform,
    permission,
    scheduled: outcome.scheduled,
    dropped: outcome.dropped,
    total: candidates.length,
    at: now
  }
}

/** App 启动 / 回前台时调用：注册重排回调并做一次重排 */
export async function startScheduler(options?: { request?: boolean }): Promise<void> {
  const notifier = await getNotifier()
  notifier.onAppResume(() => {
    void reschedule({ force: true }).catch(() => undefined)
  })
  await reschedule({ request: options?.request }).catch(() => undefined)
}

/** 供设置页手动「重新排程」按钮 */
export function forceReschedule(): Promise<RescheduleResult> {
  return reschedule({ force: true, includeAlerts: true })
}

/** 计算某条目会产生的提醒时间（设置页预览用） */
export function previewReminderTimes(item: ScheduleItem, offsetsMinutes?: number[]): number[] {
  const settings = useNotifyStore.getState().settings
  const offsets =
    offsetsMinutes && offsetsMinutes.length ? offsetsMinutes : settings.offsetsMinutes
  return requestsForItem(
    item,
    offsets.length ? offsets : DEFAULT_OFFSETS_MINUTES,
    'preview',
    settings.highPriorityOnly
  )
    .map((r) => r.at)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)
}

export { parseDate }
