import { create } from 'zustand'

import type { LatestReplan, ReplanEvent } from '../types'

export type ReplanStatus = 'idle' | 'running' | 'done' | 'error'

interface ReplanState {
  status: ReplanStatus
  /** 服务端推送的当前阶段文案 */
  phase: string
  busy: boolean
  /** 思考链累计文本（deepseek-reasoner 的 reasoning_content） */
  reasoning: string
  /** reasoner 正文结论累计文本 */
  answer: string
  newItems: number
  revision: number
  /** 留存的思考链时间（loadSaved 时填） */
  savedAt: string | null
  /** 是否已从服务端拉过「上次思考链」 */
  loaded: boolean
  /** 默认折叠 */
  expanded: boolean
  error: string

  beginRun: () => void
  applyEvent: (ev: ReplanEvent) => void
  finish: (revision: number, newItems: number) => void
  fail: (message: string) => void
  toggleExpanded: () => void
  loadSaved: (rec: LatestReplan) => void
  clear: () => void
}

export const useReplanStore = create<ReplanState>((set, get) => ({
  status: 'idle',
  phase: '',
  busy: false,
  reasoning: '',
  answer: '',
  newItems: 0,
  revision: 0,
  savedAt: null,
  loaded: false,
  expanded: false,
  error: '',

  beginRun: () =>
    set({
      status: 'running',
      busy: true,
      phase: '正在连接…',
      reasoning: '',
      answer: '',
      newItems: 0,
      savedAt: null,
      expanded: false,
      error: ''
    }),

  applyEvent: (ev) => {
    switch (ev.type) {
      case 'start':
        set({ phase: `正在排程 ${ev.bindings.length} 个绑定…` })
        break
      case 'phase':
        set({ phase: ev.message })
        break
      case 'reasoning':
        set((st) => ({ reasoning: st.reasoning + ev.delta }))
        break
      case 'answer':
        set((st) => ({ answer: st.answer + ev.delta }))
        break
      case 'run':
        set((st) => ({
          newItems: st.newItems + (ev.new_items || 0),
          revision: ev.revision || st.revision,
          phase: ev.skipped ? '该时间窗内没有与你相关的消息' : st.phase
        }))
        break
      case 'done':
        get().finish(ev.revision, get().newItems)
        break
      case 'error':
        get().fail(ev.message)
        break
      default:
        break
    }
  },

  finish: (revision, newItems) =>
    set({
      status: 'done',
      busy: false,
      phase: '排程完成',
      revision,
      newItems,
      savedAt: new Date().toISOString(),
      error: ''
    }),

  fail: (message) =>
    set((st) => ({
      status: 'error',
      busy: false,
      phase: st.phase || '排程失败',
      error: message
    })),

  toggleExpanded: () => set((st) => ({ expanded: !st.expanded })),

  loadSaved: (rec) => {
    const st = get()
    if (st.status === 'running') {
      set({ loaded: true })
      return
    }
    const reasoning = rec.reasoning || ''
    if (!reasoning) {
      set({ loaded: true })
      return
    }
    set({
      status: 'done',
      phase: '上次排程结果',
      reasoning,
      answer: '',
      newItems: rec.item_count || 0,
      revision: rec.revision || st.revision,
      savedAt: rec.at || null,
      loaded: true,
      error: ''
    })
  },

  clear: () =>
    set({
      status: 'idle',
      phase: '',
      busy: false,
      reasoning: '',
      answer: '',
      newItems: 0,
      expanded: false,
      error: ''
    })
}))
