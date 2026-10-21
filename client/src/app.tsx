import { useEffect } from 'react'
import type { PropsWithChildren } from 'react'
import Taro, { useDidShow, useLaunch } from '@tarojs/taro'

import { InAppReminder } from './components/InAppReminder'
import { DesktopLayout } from './components/DesktopLayout'
import { NAVIGATE_EVENT } from './services/notify/types'
import { reschedule, startScheduler } from './services/notify/scheduler'
import { pollAgentActions } from './services/agent-actions'
import { syncAll } from './services/sync'
import { loadCredentials, silentRelogin, useAuthStore } from './store/auth'
import { useNotifyStore } from './store/notify'
import { useDesktopUI } from './utils/desktop'
import './app.scss'

let bootstrapped = false
let listenersBound = false

/** 前台自动轮询间隔：1 分钟（走增量，代价很小；回到前台另有 useDidShow 兜底） */
const AUTO_SYNC_MS = 60_000

/** Agent 动作轮询间隔：15 秒（大模型/QQ 机器人的提醒要尽快落到本机） */
const AGENT_POLL_MS = 15_000

/** 全局事件：系统通知被点击 → 跳转对应页面（hash 路由） */
function bindGlobalListeners() {
  if (listenersBound || typeof window === 'undefined') return
  listenersBound = true

  window.addEventListener(NAVIGATE_EVENT, (e: Event) => {
    const route = (e as CustomEvent).detail?.route as string | undefined
    if (route) {
      Taro.navigateTo({ url: route }).catch(() => {
        Taro.redirectTo({ url: route }).catch(() => undefined)
      })
    }
  })

  // 纯 H5 环境下的「回前台」兜底（壳内由 Notifier 的 onAppResume 覆盖）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && useAuthStore.getState().token) {
      void syncAll()
      void reschedule({ force: true }).catch(() => undefined)
      void pollAgentActions()
    }
  })
}

async function bootstrap() {
  bindGlobalListeners()
  useAuthStore.getState().hydrate()
  useNotifyStore.getState().hydrate()

  // 没有 token 但本地存有账号密码：先静默重登，再走正常的同步/跳转逻辑
  if (!useAuthStore.getState().token && loadCredentials()) {
    await silentRelogin()
  }

  if (!useAuthStore.getState().token) return

  // 启动时：先同步（离线也有本地缓存可读），再做滚动重排
  await syncAll()
  await startScheduler({ request: false })
  await pollAgentActions().catch(() => undefined)
}

function App({ children }: PropsWithChildren) {
  const desktop = useDesktopUI()

  useLaunch(() => {
    if (bootstrapped) return
    bootstrapped = true
    void bootstrap().catch(() => undefined)
  })

  // 每次回到前台：增量同步 + 滚动重排（第 4 步「滚动窗口」的驱动力）
  useDidShow(() => {
    if (!useAuthStore.getState().token) return
    void syncAll()
    void reschedule({ force: true }).catch(() => undefined)
    void pollAgentActions()
  })

  useEffect(() => {
    bindGlobalListeners()

    // 前台每 1 分钟自动同步一次：仅当页面可见且已登录，避免无谓请求
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      if (!useAuthStore.getState().token) return
      void syncAll()
        .then(() => reschedule({ force: true }))
        .catch(() => undefined)
    }, AUTO_SYNC_MS)

    return () => clearInterval(timer)
  }, [])

  // Agent 动作单独用更短的轮询：提醒/闹钟要尽快响，代价只是一次空列表查询
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      void pollAgentActions()
    }, AGENT_POLL_MS)
    return () => clearInterval(timer)
  }, [])

  return (
    <>
      {desktop ? <DesktopLayout>{children}</DesktopLayout> : children}
      <InAppReminder />
    </>
  )
}

export default App
