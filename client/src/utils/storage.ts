import Taro from '@tarojs/taro'

/**
 * 本地持久化封装。
 * H5 用 localStorage；壳内同样走 WebView storage（Capacitor/Tauri 都会持久化）。
 * 内存兜底：隐私模式 / storage 被禁用时不至于抛异常。
 */

const memory = new Map<string, string>()

function storage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  } catch {
    /* 被禁用 */
  }
  return null
}

export function getRaw(key: string): string | null {
  const s = storage()
  if (s) {
    try {
      return s.getItem(key)
    } catch {
      /* ignore */
    }
  }
  return memory.has(key) ? memory.get(key)! : null
}

export function setRaw(key: string, value: string): void {
  const s = storage()
  if (s) {
    try {
      s.setItem(key, value)
      return
    } catch {
      /* ignore */
    }
  }
  memory.set(key, value)
}

export function removeRaw(key: string): void {
  const s = storage()
  if (s) {
    try {
      s.removeItem(key)
    } catch {
      /* ignore */
    }
  }
  memory.delete(key)
}

export function getJSON<T>(key: string, fallback: T): T {
  const raw = getRaw(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function setJSON(key: string, value: unknown): void {
  try {
    setRaw(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

/** 统一键名，避免散落魔法字符串 */
export const KEYS = {
  token: 'qqsa.token',
  user: 'qqsa.user',
  credentials: 'qqsa.credentials',
  bindings: 'qqsa.bindings',
  items: 'qqsa.items',
  revision: 'qqsa.revision',
  digest: 'qqsa.digest',
  etag: 'qqsa.etag',
  alerts: 'qqsa.alerts',
  notifiedAlerts: 'qqsa.notifiedAlerts',
  queue: 'qqsa.mutationQueue',
  notifySettings: 'qqsa.notifySettings',
  lastScheduleAt: 'qqsa.lastScheduleAt',
  conflicts: 'qqsa.conflicts',
  adminToken: 'qqsa.adminToken',
  adminUser: 'qqsa.adminUser'
} as const

/** 轻量 UUID v4（客户端生成，用于幂等） */
export function uuid(): string {
  const g = globalThis as any
  if (g.crypto?.randomUUID) {
    try {
      return g.crypto.randomUUID()
    } catch {
      /* ignore */
    }
  }
  const bytes = new Uint8Array(16)
  if (g.crypto?.getRandomValues) {
    g.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex: string[] = []
  for (let i = 0; i < 16; i++) hex.push((bytes[i] + 0x100).toString(16).slice(1))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex
    .slice(8, 10)
    .join('')}-${hex.slice(10, 16).join('')}`
}

/** 字符串 → 稳定 32 位正整数（Capacitor 本地通知 id 必须是 number） */
export function hashCode(str: string): number {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0
  }
  return Math.abs(h) || 1
}

export function copyText(text: string): void {
  try {
    if (typeof navigator !== 'undefined' && (navigator as any).clipboard?.writeText) {
      void (navigator as any).clipboard.writeText(text)
      Taro.showToast({ title: '已复制', icon: 'success' })
      return
    }
  } catch {
    /* ignore */
  }
  Taro.setClipboardData({ data: text }).catch(() => {
    Taro.showToast({ title: '复制失败', icon: 'none' })
  })
}
