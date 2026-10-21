import { api } from './api'
import { getNotifier } from './notify/platform'
import { APP_MARK, type NotifyRequest } from './notify/types'
import { useAuthStore } from '../store/auth'
import type { AgentAction } from '../types'

/**
 * Agent 动作执行器。
 *
 * 服务端（Autonotice Agent API）会把大模型 / QQ 机器人下发的动作写进
 * agent_actions 队列，客户端轮询取回后在本机执行（系统通知、震动、响铃），
 * 执行完 ack 掉，避免重复打扰。与「滚动排程」完全解耦，不会清空日程提醒队列。
 */

/** 已执行过的动作 id：ack 失败时也不会在本进程内重复触发 */
const executed = new Set<string>()
let running = false

export async function pollAgentActions(): Promise<void> {
  if (running) return
  if (!useAuthStore.getState().token) return
  running = true
  try {
    const { actions } = await api.listAgentActions()
    if (!actions || !actions.length) return
    for (const action of actions) {
      // 计划时间未到：保留下次轮询再执行
      if (action.due_at) {
        const at = Date.parse(action.due_at)
        if (Number.isFinite(at) && at > Date.now() + 1500) continue
      }
      if (!executed.has(action.id)) {
        executed.add(action.id)
        try {
          await runAction(action)
        } catch {
          /* 单条失败不影响后续动作 */
        }
      }
      await ack(action.id)
    }
  } catch {
    /* 网络不可用：下次轮询自动重试 */
  } finally {
    running = false
  }
}

async function ack(id: string): Promise<void> {
  try {
    await api.ackAgentAction(id)
  } catch {
    /* 下次轮询会补 ack */
  }
}

/** 把一条服务端动作落到本机 */
async function runAction(action: AgentAction): Promise<void> {
  const payload = (action.payload || {}) as Record<string, unknown>
  const route = typeof payload.route === 'string' && payload.route ? payload.route : undefined
  const isAlarm = action.action === 'client.alarm'

  if (isAlarm) {
    const mode = String(payload.mode || 'both')
    if (mode !== 'ring') vibrate([500, 180, 500, 180, 800])
    if (mode !== 'vibrate') ring()
  } else if (payload.vibrate === true) {
    vibrate([300, 120, 300])
  }

  const notifier = await getNotifier()
  const req: NotifyRequest = {
    id: `agent|${action.id}`,
    title: action.title || 'Autonotice 提醒',
    body: action.body || '',
    at: Date.now(),
    highPriority: isAlarm || payload.level === 'urgent',
    route,
    extra: { app: APP_MARK, route }
  }
  await notifier.fireNow(req)
}

function vibrate(pattern: number[]): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern)
    }
  } catch {
    /* 桌面端/浏览器不支持震动，忽略 */
  }
}

/** 用 Web Audio 生成三声提示音（无需音频文件） */
function ring(times = 3): void {
  try {
    if (typeof window === 'undefined') return
    const w = window as unknown as {
      AudioContext?: typeof AudioContext
      webkitAudioContext?: typeof AudioContext
    }
    const Ctx = w.AudioContext || w.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const base = ctx.currentTime
    for (let i = 0; i < times; i++) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const start = base + i * 0.5
      osc.type = 'sine'
      osc.frequency.setValueAtTime(i % 2 === 0 ? 880 : 660, start)
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.35, start + 0.03)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.35)
    }
    setTimeout(() => {
      void ctx.close().catch(() => undefined)
    }, times * 500 + 600)
  } catch {
    /* 无音频权限时静默失败 */
  }
}
