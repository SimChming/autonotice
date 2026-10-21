import { useEffect, useRef, useState } from 'react'
import type { PropsWithChildren } from 'react'
import { Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'

import { useAlertsStore } from '../../store/alerts'
import { useAuthStore } from '../../store/auth'
import { Icon, type IconName } from '../Icon'
import './index.scss'

type NavKey = 'schedule' | 'calendar' | 'alerts' | 'settings'

const NAV: Array<{ key: NavKey; label: string; icon: IconName; url: string }> = [
  { key: 'schedule', label: '日程', icon: 'list', url: '/pages/schedule/index' },
  { key: 'calendar', label: '日历', icon: 'calendar', url: '/pages/calendar/index' },
  { key: 'alerts', label: '提醒', icon: 'alert', url: '/pages/alerts/index' },
  { key: 'settings', label: '设置', icon: 'gear', url: '/pages/settings/index' }
]

function currentNav(): NavKey {
  const path = Taro.getCurrentInstance().router?.path || ''
  const hit = NAV.find((n) => path.includes(n.key))
  return hit ? hit.key : 'schedule'
}

/**
 * 桌面专用外壳：左侧固定导航栏 + 右侧内容区（macOS 风格）。
 * 未登录（login / bind 引导页）不渲染侧栏，页面自身全屏呈现。
 */
export function DesktopLayout({ children }: PropsWithChildren) {
  const token = useAuthStore((s) => s.token)
  const user = useAuthStore((s) => s.user)
  const alerts = useAlertsStore((s) => s.alerts)
  const logout = useAuthStore((s) => s.logout)
  const [active, setActive] = useState<NavKey>(currentNav)
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useDidShow(() => setActive(currentNav()))

  useEffect(() => {
    document.body.classList.add('desktop-ui')
    return () => document.body.classList.remove('desktop-ui')
  }, [])

  // 点击侧边栏空白处关闭用户菜单
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      const root = rootRef.current
      if (root && !root.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  // 未登录：只透传内容（登录页自带桌面居中样式）
  if (!token) return <>{children}</>

  const unread = alerts.filter((a) => !a.read_at).length

  async function handleLogout() {
    setMenuOpen(false)
    await logout()
    Taro.redirectTo({ url: '/pages/login/index' })
  }

  return (
    <View ref={rootRef as any} className='dlayout'>
      <View className='dlayout__sidebar'>
        <View className='dlayout__brand'>
          <Text className='dlayout__brand-logo'>🐋</Text>
          <Text className='dlayout__brand-name'>Autonotice</Text>
        </View>

        <View className='dlayout__nav'>
          {NAV.map((item) => {
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
          {/* 用户按钮：可点击弹出菜单 */}
          <View
            className={`dlayout__foot-user pressable${menuOpen ? ' is-open' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Text className='dlayout__foot-avatar'>{(user?.name || 'U').slice(0, 1).toUpperCase()}</Text>
            <View className='dlayout__foot-meta'>
              <Text className='dlayout__foot-name'>{user?.name || '已登录'}</Text>
              <Text className='dlayout__foot-sub'>已登录</Text>
            </View>
            <Icon
              name='chevron'
              className={`dlayout__foot-caret${menuOpen ? ' is-open' : ''}`}
              strokeWidth={2}
            />
          </View>

          {/* 用户菜单 */}
          {menuOpen ? (
            <View className='dlayout__user-menu'>
              <MenuRow
                icon='user'
                label='个人信息'
                hint={user?.name || ''}
                onClick={() => {
                  setMenuOpen(false)
                  Taro.navigateTo({ url: '/pages/settings/index' })
                }}
              />
              <MenuRow
                icon='gear'
                label='设置'
                onClick={() => {
                  setMenuOpen(false)
                  Taro.redirectTo({ url: '/pages/settings/index' })
                }}
              />
              <MenuRow
                icon='bell'
                label='联系我们'
                onClick={() => {
                  setMenuOpen(false)
                  Taro.navigateTo({ url: '/pages/feedback/index' })
                }}
              />
              <MenuRow
                icon='bell'
                label='提醒偏好'
                onClick={() => {
                  setMenuOpen(false)
                  Taro.redirectTo({ url: '/pages/settings/index' })
                }}
              />
              <View className='dlayout__user-menu-sep' />
              <MenuRow icon='file' label='退出登录' danger onClick={() => void handleLogout()} />
            </View>
          ) : null}
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
