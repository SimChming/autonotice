import { create } from 'zustand'

import type { Runtime } from '../utils/platform'
import { KEYS, getJSON, getRaw, setJSON, setRaw } from '../utils/storage'
import { notifyBudget, detectRuntime } from '../utils/platform'

export interface NotifySettings {
  /** 无 remind_at 时，基于 due_at 的提醒偏移（分钟，负数表示提前） */
  offsetsMinutes: number[]
  /** 每日 08:00 简报 */
  digestEnabled: boolean
  /** 是否仅在高优先级项上请求精确定时 */
  highPriorityOnly: boolean
  /** 是否申请过厂商自启动白名单引导 */
  bootGuideAcknowledged: boolean
}

export interface PermissionSnapshot {
  granted: boolean
  exactAlarmGranted: boolean
  needsSystemSettings: boolean
  detail?: string
}

interface NotifyState {
  runtime: Runtime
  permission: PermissionSnapshot
  maxCount: number
  settings: NotifySettings
  scheduledCount: number
  droppedCount: number
  lastScheduledAt: number | null

  hydrate: () => void
  setRuntime: (runtime: Runtime) => void
  setPermission: (permission: PermissionSnapshot) => void
  setSettings: (patch: Partial<NotifySettings>) => void
  recordSchedule: (scheduled: number, dropped: number) => void
}

export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = {
  // due_at 前 1 天 / 2 小时 / 15 分钟（负数为「提前」）
  offsetsMinutes: [-24 * 60, -2 * 60, -15],
  digestEnabled: true,
  highPriorityOnly: false,
  bootGuideAcknowledged: false
}

export const useNotifyStore = create<NotifyState>((set, get) => ({
  runtime: 'web',
  permission: { granted: false, exactAlarmGranted: true, needsSystemSettings: false },
  maxCount: notifyBudget(),
  settings: DEFAULT_NOTIFY_SETTINGS,
  scheduledCount: 0,
  droppedCount: 0,
  lastScheduledAt: null,

  hydrate: () => {
    const last = Number(getRaw(KEYS.lastScheduleAt) || 0)
    set({
      runtime: detectRuntime(),
      maxCount: notifyBudget(),
      settings: {
        ...DEFAULT_NOTIFY_SETTINGS,
        ...getJSON<Partial<NotifySettings>>(KEYS.notifySettings, {})
      },
      lastScheduledAt: last > 0 ? last : null
    })
  },

  setRuntime: (runtime) => set({ runtime }),

  setPermission: (permission) => set({ permission }),

  setSettings: (patch) => {
    const settings = { ...get().settings, ...patch }
    setJSON(KEYS.notifySettings, settings)
    set({ settings })
  },

  recordSchedule: (scheduled, dropped) => {
    setRaw(KEYS.lastScheduleAt, String(Date.now()))
    set({ scheduledCount: scheduled, droppedCount: dropped, lastScheduledAt: Date.now() })
  }
}))

useNotifyStore.getState().hydrate()
