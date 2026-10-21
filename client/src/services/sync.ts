import type { ScheduleItem, SyncMutation, SyncResult } from '../types'
import { KEYS, getJSON, setJSON, uuid } from '../utils/storage'
import { ApiError, api, isNetworkError } from './api'
import { useAuthStore } from '../store/auth'
import { useScheduleStore, type ConflictRecord } from '../store/schedule'
import { useAlertsStore } from '../store/alerts'
import { useReplanStore } from '../store/replan'

export type ConflictStrategy = 'mine' | 'server' | 'merge'

export interface CommitResult {
  ok: boolean
  queued?: boolean
  conflict?: ScheduleItem
  item?: ScheduleItem
  error?: string
}

// ---------------------------------------------------------------------------
// 本地变更队列（离线，UUID 幂等）
// ---------------------------------------------------------------------------

function loadQueue(): SyncMutation[] {
  return getJSON<SyncMutation[]>(KEYS.queue, [])
}

function saveQueue(queue: SyncMutation[]): void {
  setJSON(KEYS.queue, queue)
}

export function pendingCount(): number {
  return loadQueue().length
}

function enqueue(item: ScheduleItem, op: SyncMutation['op']): void {
  const queue = loadQueue().filter((m) => m.item.id !== item.id)
  queue.push({ mutation_id: `${op}:${item.id}:${uuid()}`, op, item, queued_at: Date.now() })
  saveQueue(queue)
}

function dequeue(itemId: string): void {
  saveQueue(loadQueue().filter((m) => m.item.id !== itemId))
}

// ---------------------------------------------------------------------------
// 拉取
// ---------------------------------------------------------------------------

export interface PullOutcome {
  notModified: boolean
  revision: number
  count: number
}

/** 全量拉取（带 ETag / If-None-Match）；force=true 时忽略本地 ETag，强制拿最新 */
export async function pullFull(force = false): Promise<PullOutcome> {
  const res = await api.getScheduleDoc({ force })
  if (res.notModified) {
    const doc = useScheduleStore.getState()
    return { notModified: true, revision: doc.revision, count: doc.items.length }
  }
  const doc = res.data!
  useScheduleStore.getState().replaceAll(doc, res.etag)
  return { notModified: false, revision: doc.revision, count: doc.items.length }
}

/** 增量拉取：需要本地已有 revision */
export async function pullDelta(): Promise<PullOutcome> {
  const { revision } = useScheduleStore.getState()
  if (!revision) return pullFull()
  const delta = await api.getDelta(revision)
  useScheduleStore.getState().applyDelta(delta)
  return { notModified: false, revision: delta.revision, count: delta.changed.length }
}

export interface RefreshOptions {
  alerts?: boolean
  /** 忽略本地 revision / ETag，强制全量拉取（用于手动刷新，保证拿到服务端最新） */
  force?: boolean
}

/**
 * 刷新日程：优先增量，网络不可用时静默失败（离线仍可读本地缓存）。
 * 同时刷新 alerts。force=true 时强制全量拉取最新。
 */
export async function refreshSchedule(opts: RefreshOptions = {}): Promise<PullOutcome> {
  const store = useScheduleStore.getState()
  store.setSyncing(true)
  try {
    const outcome = opts.force || !store.revision ? await pullFull(opts.force) : await pullDelta()
    if (opts.alerts !== false) await refreshAlerts().catch(() => undefined)
    return outcome
  } finally {
    useScheduleStore.getState().setSyncing(false)
  }
}

export async function refreshAlerts(): Promise<number> {
  const res = await api.listAlerts()
  useAlertsStore.getState().replaceAll(res.alerts || [])
  return (res.alerts || []).length
}

/** 手动刷新：立即提交离线队列 + 强制拉取最新日程与告警（不等自动轮询） */
export async function refreshNow(): Promise<PullOutcome> {
  try {
    await flushQueue()
  } catch {
    /* 离线：保留队列稍后自动重试 */
  }
  return refreshSchedule({ alerts: true, force: true })
}

// ---------------------------------------------------------------------------
// 写入（乐观更新 + 冲突处理）
// ---------------------------------------------------------------------------

/** 提交单个条目变更：在线走 PATCH，离线入队 */
export async function commitItem(item: ScheduleItem, op: SyncMutation['op'] = 'upsert'): Promise<CommitResult> {
  // 先本地乐观更新，UI 立即响应
  if (op === 'delete') useScheduleStore.getState().removeLocal(item.id)
  else useScheduleStore.getState().upsertLocal(item)

  if (!useAuthStore.getState().token) {
    enqueue(item, op)
    return { ok: true, queued: true, item }
  }

  try {
    if (op === 'delete') {
      await api.deleteItem(item.id)
      dequeue(item.id)
      useScheduleStore.getState().removeConflict(item.id)
      return { ok: true }
    }
    const saved = await api.patchItem(item.id, item)
    dequeue(item.id)
    useScheduleStore.getState().removeConflict(item.id)
    const store = useScheduleStore.getState()
    store.upsertLocal(saved)
    if (saved.revision > store.revision) store.setRevision(saved.revision)
    return { ok: true, item: saved }
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && op === 'upsert') {
      // 本地新建的条目（服务端还没有）→ 走 POST 创建
      try {
        const created = await api.createItem(item)
        dequeue(item.id)
        useScheduleStore.getState().upsertLocal(created)
        return { ok: true, item: created }
      } catch (createErr) {
        if (isNetworkError(createErr)) {
          enqueue(item, op)
          return { ok: true, queued: true, item }
        }
      }
    }
    if (err instanceof ApiError && err.status === 409 && err.conflict) {
      useScheduleStore.getState().addConflict({
        itemId: item.id,
        local: item,
        server: err.conflict,
        at: Date.now()
      })
      dequeue(item.id)
      return { ok: false, conflict: err.conflict }
    }
    if (isNetworkError(err)) {
      enqueue(item, op)
      return { ok: true, queued: true, item }
    }
    // 服务端明确拒绝（4xx）：回滚本地
    if (op !== 'delete') await tryRollback(item.id)
    return { ok: false, error: err instanceof Error ? err.message : '保存失败' }
  }
}

async function tryRollback(itemId: string): Promise<void> {
  try {
    const res = await api.getDelta(useScheduleStore.getState().revision)
    useScheduleStore.getState().applyDelta(res)
  } catch {
    void itemId
  }
}

/** 勾选/取消勾选：只动 status（客户端掌管的字段） */
export async function toggleDone(item: ScheduleItem): Promise<CommitResult> {
  const nextStatus = item.status === 'done' ? 'todo' : 'done'
  const next: ScheduleItem = {
    ...item,
    status: nextStatus,
    updated_at: new Date().toISOString()
  }
  return commitItem(next)
}

/** 更新文本类字段（notes/remind_at 等）；改内容 → locked_by_user=true */
export function applyLocalEdit(item: ScheduleItem, patch: Partial<ScheduleItem>): ScheduleItem {
  const touchesContent =
    patch.title !== undefined || patch.due_at !== undefined || patch.remind_at !== undefined
  return {
    ...item,
    ...patch,
    locked_by_user: item.locked_by_user || touchesContent,
    updated_at: new Date().toISOString()
  }
}

// ---------------------------------------------------------------------------
// 批量提交（POST /schedules/me/sync）
// ---------------------------------------------------------------------------

export interface FlushOutcome {
  attempted: number
  applied: number
  conflicts: number
  revision: number
  offline: boolean
}

export async function flushQueue(): Promise<FlushOutcome> {
  const queue = loadQueue()
  const base: FlushOutcome = {
    attempted: queue.length,
    applied: 0,
    conflicts: 0,
    revision: useScheduleStore.getState().revision,
    offline: false
  }
  if (!queue.length) return base
  if (!useAuthStore.getState().token) return { ...base, offline: true }

  try {
    const res: SyncResult = await api.syncMutations(base.revision, queue)
    for (const item of res.changed || []) useScheduleStore.getState().upsertLocal(item)
    for (const server of res.conflicts || []) {
      const local = queue.find((m) => m.item.id === server.id)?.item || server
      const record: ConflictRecord = { itemId: server.id, local, server, at: Date.now() }
      useScheduleStore.getState().addConflict(record)
    }
    saveQueue([])
    useScheduleStore.getState().markSynced(res.revision)
    return { ...base, applied: (res.changed || []).length, conflicts: (res.conflicts || []).length, revision: res.revision }
  } catch (err) {
    if (isNetworkError(err)) return { ...base, offline: true }
    throw err
  }
}

/** 启动/回前台时的完整同步：刷新 + 提交离线队列 */
export async function syncAll(): Promise<void> {
  try {
    await flushQueue()
  } catch {
    /* 忽略，稍后重试 */
  }
  try {
    await refreshSchedule({ alerts: true })
  } catch {
    /* 离线时静默 */
  }
}

// ---------------------------------------------------------------------------
// 冲突解决
// ---------------------------------------------------------------------------

/**
 * 字段归属：AI 掌 title / due_at / source / type / priority；客户端掌 status / notes。
 * 手动合并 = 服务端 AI 字段 + 我的状态与备注。
 */
export function mergeItems(local: ScheduleItem, server: ScheduleItem): ScheduleItem {
  return {
    ...server,
    status: local.status,
    notes: local.notes || server.notes,
    updated_at: new Date().toISOString()
  }
}

export async function resolveConflict(
  itemId: string,
  strategy: ConflictStrategy,
  mergedOverride?: ScheduleItem
): Promise<CommitResult> {
  const record = useScheduleStore.getState().conflicts.find((c) => c.itemId === itemId)
  if (!record) return { ok: false, error: '冲突记录不存在' }

  if (strategy === 'server') {
    useScheduleStore.getState().upsertLocal(record.server)
    useScheduleStore.getState().removeConflict(itemId)
    return { ok: true, item: record.server }
  }

  // 用服务端最新 revision 作为 base，覆盖回写 → 保留我的修改
  const candidate =
    strategy === 'merge'
      ? mergedOverride || mergeItems(record.local, record.server)
      : { ...record.local, source: record.local.source ?? record.server.source }

  const pushed: ScheduleItem = { ...candidate, revision: record.server.revision, locked_by_user: true }
  return commitItem(pushed)
}

/** 离线队列 + 未解决冲突的数量，用于设置页展示 */
export function syncStatus(): { pending: number; conflicts: number; revision: number } {
  return {
    pending: pendingCount(),
    conflicts: useScheduleStore.getState().conflicts.length,
    revision: useScheduleStore.getState().revision
  }
}

export function clearLocalData(): void {
  useScheduleStore.getState().clear()
  useAlertsStore.getState().clear()
  useReplanStore.getState().clear()
  saveQueue([])
}
