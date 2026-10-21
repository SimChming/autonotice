import { useEffect, useState } from 'react'
import type { PropsWithChildren } from 'react'
import { Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'

import { useAlertsStore } from '../../store/alerts'
import { useAuthStore } from '../../store/auth'
import { Icon, type IconName } from '../Icon'
import './index.scss'

type NavKey = 'schedule' | 'calendar' | 'alerts' | 'settings' | 'admin'

const NAV: Array<{ key: NavKey; label: string; icon: IconName; url: string }> = [
  { key: 'schedule', label: '日程', icon: 'list', url: '/pages/schedule/index' },
  { key: 'calendar', label: '日历', icon: 'calendar', url: '/pages/calendar/index' },
  { key: 'alerts', label: '提醒', icon: 'alert', url: '/pages/alerts/index' },
  { key: 'settings', label: '设置', icon: 'gear', url: '/pages/settings/index' },
  { key: 'admin', label: '管理后台', icon: 'shield', url: '/pages/admin/index' }
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
  const [active, setActive] = useState<NavKey>(currentNav)

  useDidShow(() => setActive(currentNav()))

  useEffect(() => {
    document.body.classList.add('desktop-ui')
    return () => document.body.classList.remove('desktop-ui')
  }, [])

  // 未登录：只透传内容（登录页自带桌面居中样式）
  if (!token) return <>{children}</>

  const unread = alerts.filter((a) => !a.read_at).length

  return (
    <View className='dlayout'>
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
          <View className='dlayout__foot-user'>
            <Text className='dlayout__foot-avatar'>{(user?.name || 'U').slice(0, 1).toUpperCase()}</Text>
            <View className='dlayout__foot-meta'>
              <Text className='dlayout__foot-name'>{user?.name || '已登录'}</Text>
              <Text className='dlayout__foot-sub'>已登录</Text>
            </View>
          </View>
        </View>
      </View>

      <View className='dlayout__main'>{children}</View>
    </View>
  )
}
