import { create } from 'zustand'

import type { Alert } from '../types'
import { KEYS, getJSON, setJSON } from '../utils/storage'

interface AlertsState {
  alerts: Alert[]
  /** 已经弹过本地通知的 alert id，避免重复打扰 */
  notified: string[]
  hydrate: () => void
  replaceAll: (alerts: Alert[]) => void
  markRead: (id: string) => void
  markAllRead: () => void
  markNotified: (ids: string[]) => void
  clear: () => void
}

export const useAlertsStore = create<AlertsState>((set, get) => ({
  alerts: [],
  notified: [],

  hydrate: () => {
    set({
      alerts: getJSON<Alert[]>(KEYS.alerts, []),
      notified: getJSON<string[]>(KEYS.notifiedAlerts, [])
    })
  },

  replaceAll: (alerts) => {
    setJSON(KEYS.alerts, alerts)
    set({ alerts })
  },

  markRead: (id) => {
    const alerts = get().alerts.map((a) =>
      a.id === id ? { ...a, read_at: a.read_at || new Date().toISOString() } : a
    )
    setJSON(KEYS.alerts, alerts)
    set({ alerts })
  },

  markAllRead: () => {
    const now = new Date().toISOString()
    const alerts = get().alerts.map((a) => (a.read_at ? a : { ...a, read_at: now }))
    setJSON(KEYS.alerts, alerts)
    set({ alerts })
  },

  markNotified: (ids) => {
    const notified = Array.from(new Set(get().notified.concat(ids)))
    setJSON(KEYS.notifiedAlerts, notified)
    set({ notified })
  },

  clear: () => {
    setJSON(KEYS.alerts, [])
    setJSON(KEYS.notifiedAlerts, [])
    set({ alerts: [], notified: [] })
  }
}))

useAlertsStore.getState().hydrate()

export function unreadAlerts(): Alert[] {
  return useAlertsStore.getState().alerts.filter((a) => !a.read_at)
}

export function unreadAlertCount(): number {
  return unreadAlerts().length
}
