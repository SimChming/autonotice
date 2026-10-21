import { create } from 'zustand'

import type { DeltaResult, ScheduleDoc, ScheduleItem } from '../types'
import { KEYS, getJSON, getRaw, removeRaw, setJSON, setRaw } from '../utils/storage'

export interface ConflictRecord {
  itemId: string
  local: ScheduleItem
  server: ScheduleItem
  at: number
}

interface ScheduleState {
  items: ScheduleItem[]
  revision: number
  digest: string
  /** GET /schedules/me 返回的 ETag，用于 If-None-Match */
  etag: string | null
  lastSyncAt: number | null
  syncing: boolean
  conflicts: ConflictRecord[]

  hydrate: () => void
  replaceAll: (doc: ScheduleDoc, etag?: string | null) => void
  applyDelta: (delta: DeltaResult) => void
  upsertLocal: (item: ScheduleItem) => void
  removeLocal: (id: string) => void
  setRevision: (revision: number) => void
  setSyncing: (syncing: boolean) => void
  markSynced: (revision: number) => void
  addConflict: (record: ConflictRecord) => void
  removeConflict: (itemId: string) => void
  clear: () => void
}

function persist(items: ScheduleItem[], revision: number, digest: string, etag: string | null) {
  setJSON(KEYS.items, items)
  setRaw(KEYS.revision, String(revision))
  setRaw(KEYS.digest, digest)
  if (etag) setRaw(KEYS.etag, etag)
  else removeRaw(KEYS.etag)
}

function persistConflicts(conflicts: ConflictRecord[]) {
  setJSON(KEYS.conflicts, conflicts)
}

export const useScheduleStore = create<ScheduleState>((set, get) => ({
  items: [],
  revision: 0,
  digest: '',
  etag: null,
  lastSyncAt: null,
  syncing: false,
  conflicts: [],

  hydrate: () => {
    set({
      items: getJSON<ScheduleItem[]>(KEYS.items, []),
      revision: Number(getRaw(KEYS.revision) || 0),
      digest: getRaw(KEYS.digest) || '',
      etag: getRaw(KEYS.etag),
      conflicts: getJSON<ConflictRecord[]>(KEYS.conflicts, [])
    })
  },

  replaceAll: (doc, etag) => {
    const items = (doc.items || []).slice()
    persist(items, doc.revision, doc.digest, etag ?? get().etag)
    set({
      items,
      revision: doc.revision,
      digest: doc.digest,
      etag: etag ?? get().etag,
      lastSyncAt: Date.now()
    })
  },

  applyDelta: (delta) => {
    const map = new Map(get().items.map((it) => [it.id, it]))
    for (const id of delta.deleted || []) map.delete(id)
    for (const it of delta.changed || []) map.set(it.id, it)
    const items = Array.from(map.values())
    persist(items, delta.revision, get().digest, get().etag ? null : null)
    set({ items, revision: delta.revision, lastSyncAt: Date.now() })
  },

  upsertLocal: (item) => {
    const items = get().items.slice()
    const idx = items.findIndex((it) => it.id === item.id)
    if (idx >= 0) items[idx] = item
    else items.push(item)
    persist(items, get().revision, get().digest, null)
    set({ items })
  },

  removeLocal: (id) => {
    const items = get().items.filter((it) => it.id !== id)
    persist(items, get().revision, get().digest, null)
    set({ items })
  },

  setRevision: (revision) => {
    setRaw(KEYS.revision, String(revision))
    set({ revision })
  },

  setSyncing: (syncing) => set({ syncing }),

  markSynced: (revision) => {
    setRaw(KEYS.revision, String(revision))
    set({ revision, lastSyncAt: Date.now() })
  },

  addConflict: (record) => {
    const conflicts = get()
      .conflicts.filter((c) => c.itemId !== record.itemId)
      .concat(record)
    persistConflicts(conflicts)
    set({ conflicts })
  },

  removeConflict: (itemId) => {
    const conflicts = get().conflicts.filter((c) => c.itemId !== itemId)
    persistConflicts(conflicts)
    set({ conflicts })
  },

  clear: () => {
    persist([], 0, '', null)
    persistConflicts([])
    set({ items: [], revision: 0, digest: '', etag: null, conflicts: [], lastSyncAt: null })
  }
}))

useScheduleStore.getState().hydrate()

/** 排序：未完成优先 → due_at 升序 → 创建时间 */
export function sortItems(items: ScheduleItem[]): ScheduleItem[] {
  const weight = (s: ScheduleItem['status']) => (s === 'done' || s === 'ignored' ? 1 : 0)
  return items.slice().sort((a, b) => {
    if (weight(a.status) !== weight(b.status)) return weight(a.status) - weight(b.status)
    const ta = a.due_at ? new Date(a.due_at).getTime() : Number.MAX_SAFE_INTEGER
    const tb = b.due_at ? new Date(b.due_at).getTime() : Number.MAX_SAFE_INTEGER
    if (ta !== tb) return ta - tb
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  })
}

export function findItem(id: string | undefined): ScheduleItem | undefined {
  if (!id) return undefined
  return useScheduleStore.getState().items.find((it) => it.id === id)
}
