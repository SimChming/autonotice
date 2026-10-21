import { useReplanStore } from '../store/replan'
import { api, errorMessage } from './api'
import { reschedule } from './notify/scheduler'
import { refreshNow } from './sync'

let current: AbortController | null = null

/**
 * 一键实时排程：流式接收 DeepSeek 思考链，结束后强制刷新日程与提醒。
 * 运行中重复调用会被直接忽略（服务端另有 409 并发闸兜底）。
 */
export async function runReplan(lookback?: string): Promise<void> {
  if (useReplanStore.getState().status === 'running') return
  const ctrl = new AbortController()
  current = ctrl
  useReplanStore.getState().beginRun()
  try {
    await api.replanStream((ev) => useReplanStore.getState().applyEvent(ev), ctrl.signal, lookback)
  } catch (err) {
    if (!ctrl.signal.aborted) useReplanStore.getState().fail(errorMessage(err))
  } finally {
    current = null
    // 无论成败都刷新：成功则有新日程，失败也要保证本地与服务端一致
    await refreshNow().catch(() => undefined)
    await reschedule({ force: true, includeAlerts: true }).catch(() => undefined)
  }
}

/** 主动中断当前排程（服务端会随之取消 DeepSeek 调用） */
export function stopReplan(): void {
  current?.abort()
  current = null
}

/** 页面首次挂载时拉取「上次思考链」（服务端只保留最近一条） */
export async function loadSavedReplan(): Promise<void> {
  if (useReplanStore.getState().loaded) return
  try {
    const rec = await api.getLatestReplan()
    useReplanStore.getState().loadSaved(rec)
  } catch {
    /* 忽略：未登录/离线时不阻塞主流程 */
  }
}
