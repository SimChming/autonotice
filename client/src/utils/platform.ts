/**
 * 运行时平台探测：区分「原生壳」与「纯 H5」。
 * 必须在 import 任何壳插件之前完成，避免 H5 里硬依赖壳插件导致编译/运行失败。
 */

export type Runtime = 'tauri' | 'capacitor' | 'web'

export type DeviceKind = 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'web'

function w(): any {
  return typeof window === 'undefined' ? {} : window
}

export function isTauri(): boolean {
  const win = w()
  return Boolean(win.__TAURI__ || win.__TAURI_INTERNALS__)
}

export function isCapacitor(): boolean {
  const win = w()
  if (!win.Capacitor) return false
  if (typeof win.Capacitor.isNativePlatform === 'function') {
    return Boolean(win.Capacitor.isNativePlatform())
  }
  return typeof win.Capacitor.platform === 'string' && win.Capacitor.platform !== 'web'
}

export function detectRuntime(): Runtime {
  if (isTauri()) return 'tauri'
  if (isCapacitor()) return 'capacitor'
  return 'web'
}

export function detectDeviceKind(): DeviceKind {
  const win = w()
  if (isCapacitor()) {
    const p = typeof win.Capacitor?.getPlatform === 'function' ? win.Capacitor.getPlatform() : ''
    if (p === 'ios') return 'ios'
    if (p === 'android') return 'android'
  }
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || ''
  if (/Windows/i.test(ua)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad/i.test(ua)) return 'macos'
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return 'linux'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'web'
}

export function isIOS(): boolean {
  return detectDeviceKind() === 'ios'
}

export function isAndroid(): boolean {
  return detectDeviceKind() === 'android'
}

export function isWindows(): boolean {
  return detectDeviceKind() === 'windows'
}

/** 是否为「壳内运行」（Capacitor/Tauri） —— 壳内是离线可弹本地通知的前提 */
export function isNativeShell(): boolean {
  return detectRuntime() !== 'web'
}

/**
 * iOS 系统硬限制：每个 App 最多 64 条 pending 本地通知（无法绕过）。
 * 这里留 4 条余量给系统/其他来源。
 */
export const IOS_PENDING_LIMIT = 64
export const NOTIFY_BUDGET = {
  ios: 60,
  android: 60,
  windows: 80
} as const

export function notifyBudget(): number {
  const kind = detectDeviceKind()
  if (kind === 'ios') return NOTIFY_BUDGET.ios
  if (kind === 'android') return NOTIFY_BUDGET.android
  return NOTIFY_BUDGET.windows
}
