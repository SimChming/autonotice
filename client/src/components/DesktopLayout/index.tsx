import { useEffect, useRef, useState } from 'react'
import type { PropsWithChildren } from 'react'
import { createPortal } from 'react-dom'
import { Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'

import { api } from '../../services/api'
import { reschedule } from '../../services/notify/scheduler'
import { syncAll, syncStatus } from '../../services/sync'
import { useAlertsStore } from '../../store/alerts'
import { useAuthStore } from '../../store/auth'
import { Icon, type IconName } from '../Icon'
import './index.scss'

type NavKey = 'schedule' | 'calendar' | 'alerts' | 'settings' | 'admin'

const NAV: Array<{ key: NavKey; label: string; icon: IconName; url: string }> = [
  { key: 'schedule', label: '日程', icon: 'list', url: '/pages/schedule/index' },
  { key: 'calendar', label: '日历', icon: 'calendar', url: '/pages/calendar/index' },
  { key: 'alerts', label: '提醒', icon: 'alert', url: '/pages/alerts/index' },
  { key: 'settings', label: '设置', icon: 'gear', url: '/pages/settings/index' }
]

const ADMIN_NAV: (typeof NAV)[number] = {
  key: 'admin',
  label: '后台',
  icon: 'shield',
  url: '/pages/admin/index'
}

function currentNav(): NavKey {
  const path = Taro.getCurrentInstance().router?.path || ''
  if (path.includes('/pages/admin/')) return 'admin'
  const hit = NAV.find((n) => path.includes(n.key))
  return hit ? hit.key : 'schedule'
}

interface MenuPos {
  left: number
  bottom: number
  width: number
}

/**
 * 桌面专用外壳：左侧固定导航栏 + 右侧内容区（macOS 风格）。
 * 未登录（login / bind 引导页）不渲染侧栏，页面自身全屏呈现。
 */
export function DesktopLayout({ children }: PropsWithChildren) {
  const token = useAuthStore((s) => s.token)
  const user = useAuthStore((s) => s.user)
  const bindings = useAuthStore((s) => s.bindings)
  const isOwner = useAuthStore((s) => s.privileges.isOwner)
  const alerts = useAlertsStore((s) => s.alerts)
  const logout = useAuthStore((s) => s.logout)
  const [active, setActive] = useState<NavKey>(currentNav)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pos, setPos] = useState<MenuPos>({ left: 12, bottom: 84, width: 192 })
  const [syncing, setSyncing] = useState(false)
  const btnRef = useRef<HTMLDivElement | null>(null)

  useDidShow(() => {
    setActive(currentNav())
    setMenuOpen(false)
  })

  useEffect(() => {
    document.body.classList.add('desktop-ui')
    return () => document.body.classList.remove('desktop-ui')
  }, [])

  // 主人身份由服务端判定（已绑定主人 QQ），决定是否显示后台入口
  useEffect(() => {
    if (token) void useAuthStore.getState().loadPrivileges()
  }, [token])

  // macOS 风格：Esc 关闭用户菜单
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menuOpen])

  // 未登录：只透传内容（登录页自带桌面居中样式）
  if (!token) return <>{children}</>

  const unread = alerts.filter((a) => !a.read_at).length
  const verifiedBindings = bindings.filter((b) => b.verified).length
  const status = syncStatus()
  const nav = isOwner ? [...NAV, ADMIN_NAV] : NAV

  /** 以用户按钮的实时位置为锚点，弹出 fixed 面板（脱离侧栏裁剪/层叠上下文） */
  function openMenu() {
    const el = btnRef.current as unknown as HTMLElement | null
    const rect = el?.getBoundingClientRect?.()
    if (rect && rect.width > 0) {
      setPos({
        left: Math.round(rect.left),
        bottom: Math.round(window.innerHeight - rect.top + 8),
        width: Math.round(rect.width)
      })
    }
    setMenuOpen((v) => !v)
  }

  function go(url: string, redirect = false) {
    setMenuOpen(false)
    const nav2 = redirect ? Taro.redirectTo({ url }) : Taro.navigateTo({ url })
    nav2.catch(() => undefined)
  }

  async function handleSync() {
    if (syncing) return
    setSyncing(true)
    try {
      await syncAll()
      await reschedule({ force: true }).catch(() => undefined)
      setMenuOpen(false)
      Taro.showToast({ title: '已同步', icon: 'success' })
    } catch {
      Taro.showToast({ title: '网络不可用', icon: 'none' })
    } finally {
      setSyncing(false)
    }
  }

  async function handleLogout() {
    setMenuOpen(false)
    await logout()
    Taro.redirectTo({ url: '/pages/login/index' })
  }

  const menu =
    menuOpen && typeof document !== 'undefined'
      ? createPortal(
          <View className='dlayout__menu-layer'>
            <View className='dlayout__menu-mask' onClick={() => setMenuOpen(false)} />
            <View
              className='dlayout__user-menu'
              style={{
                left: `${pos.left}px`,
                bottom: `${pos.bottom}px`,
                width: `${Math.max(pos.width, 200)}px`,
                position: 'fixed',
                zIndex: 10000,
                background: 'var(--bg-elevated, #ffffff)'
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <View className='dlayout__menu-head'>
                <Text className='dlayout__menu-head-name'>{user?.name || '已登录'}</Text>
                <Text className='dlayout__menu-head-sub'>
                  {isOwner ? '主人账号 · 后台已解锁' : `服务端 ${api.base}`}
                </Text>
              </View>
              <View className='dlayout__user-menu-sep' />

              <MenuRow
                icon='link'
                label='QQ 绑定'
                hint={verifiedBindings ? `${verifiedBindings} 个已验证` : '未绑定'}
                onClick={() => go('/pages/bind/index', true)}
              />
              <MenuRow
                icon='refresh'
                label='立即同步'
                hint={`待同步 ${status.pending}`}
                onClick={() => void handleSync()}
              />
              <MenuRow
                icon='user'
                label='个人信息与提醒'
                onClick={() => go('/pages/settings/index', true)}
              />
              {isOwner ? (
                <MenuRow icon='shield' label='管理后台' hint='模型 · 能力 · 名单' onClick={() => go('/pages/admin/index')} />
              ) : null}

              <View className='dlayout__user-menu-sep' />
              <MenuRow icon='file' label='退出登录' danger onClick={() => void handleLogout()} />
            </View>
          </View>,
          document.body
        )
      : null

  return (
    <View className='dlayout'>
      <View className='dlayout__sidebar'>
        <View className='dlayout__brand'>
          <Text className='dlayout__brand-logo'>🐋</Text>
          <Text className='dlayout__brand-name'>Autonotice</Text>
        </View>

        <View className='dlayout__nav'>
          {nav.map((item) => {
            const isActive = active === item.key
            return (
              <View
                key={item.key}
                className={`dlayout__nav-item pressable${isActive ? ' is-active' : ''}`}
                onClick={() => {
                  if (isActive) return
                  setActive(item.key)
                  Taro.redirectTo({ url: item.url }).catch(() => undefined)
                }}
              >
                <Icon name={item.icon} className='dlayout__nav-icon' strokeWidth={isActive ? 2.1 : 1.7} />
                <Text className='dlayout__nav-label'>{item.label}</Text>
                {item.key === 'alerts' && unread > 0 ? (
                  <View className='dlayout__nav-badge'>
                    <Text className='dlayout__nav-badge-text'>{unread > 99 ? '99+' : String(unread)}</Text>
                  </View>
                ) : null}
              </View>
            )
          })}
        </View>

        <View className='dlayout__foot'>
          <View
            ref={btnRef as any}
            className={`dlayout__foot-user pressable${menuOpen ? ' is-open' : ''}`}
            onClick={openMenu}
          >
            <Text className='dlayout__foot-avatar'>{(user?.name || 'U').slice(0, 1).toUpperCase()}</Text>
            <View className='dlayout__foot-meta'>
              <Text className='dlayout__foot-name'>{user?.name || '已登录'}</Text>
              <Text className='dlayout__foot-sub'>账号与同步</Text>
            </View>
            <Icon
              name='chevron'
              className={`dlayout__foot-caret${menuOpen ? ' is-open' : ''}`}
              strokeWidth={2}
            />
          </View>
          {menu}
        </View>
      </View>

      <View className='dlayout__main'>{children}</View>
    </View>
  )
}

/** 用户菜单里的一行 */
function MenuRow({
  icon,
  label,
  hint,
  danger,
  onClick
}: {
  icon: IconName
  label: string
  hint?: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <View className='dlayout__menu-row pressable' onClick={onClick}>
      <Icon name={icon} className='dlayout__menu-icon' strokeWidth={2} />
      <Text className={`dlayout__menu-label${danger ? ' is-danger' : ''}`}>{label}</Text>
      {hint ? <Text className='dlayout__menu-hint'>{hint}</Text> : null}
    </View>
  )
}
