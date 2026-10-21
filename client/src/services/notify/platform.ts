import type { Runtime } from '../../utils/platform'
import { detectDeviceKind, detectRuntime, notifyBudget } from '../../utils/platform'
import { CapacitorNotifier } from './capacitor'
import { TauriNotifier } from './tauri'
import type { PlatformNotify } from './types'
import { WebNotifier } from './web'

/**
 * 运行时探测 → 选择通知实现。
 *
 * 注意：这里静态 import 了三个「类」，但壳插件本身（@capacitor/local-notifications、
 * @tauri-apps/plugin-notification）都在各自实现里用动态 import 加载，
 * 因此纯 H5 构建不会硬依赖壳插件，也只在真正命中时才加载对应 chunk。
 */
let cached: PlatformNotify | null = null
let cachedRuntime: Runtime | null = null

export function currentRuntime(): Runtime {
  return detectRuntime()
}

export function maxNotifyCount(): number {
  return notifyBudget()
}

/** 通知预算与平台说明文案（设置页展示） */
export function notifyBudgetHint(): string {
  const kind = detectDeviceKind()
  if (kind === 'ios') return `iOS 每 App 上限 64 条，滚动窗口取 ${notifyBudget()} 条`
  if (kind === 'android') return `Android 滚动窗口取 ${notifyBudget()} 条（Doze 下可能延后）`
  if (kind === 'windows') return `Windows 滚动窗口取 ${notifyBudget()} 条`
  return `浏览器标签页内提醒（最多 ${notifyBudget()} 条）`
}

export async function getNotifier(): Promise<PlatformNotify> {
  const rt = detectRuntime()
  if (cached && cachedRuntime === rt) return cached

  let instance: PlatformNotify
  switch (rt) {
    case 'tauri':
      instance = new TauriNotifier()
      break
    case 'capacitor':
      instance = new CapacitorNotifier()
      break
    default:
      instance = new WebNotifier()
  }
  cached = instance
  cachedRuntime = rt
  return instance
}

export type { PlatformNotify } from './types'
export * from './types'
