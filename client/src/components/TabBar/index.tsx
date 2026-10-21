import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'

import { useAlertsStore } from '../../store/alerts'
import { useDesktopUI } from '../../utils/desktop'
import { Icon, type IconName } from '../Icon'
import './index.scss'

export type TabKey = 'schedule' | 'calendar' | 'alerts' | 'settings'

const TABS: Array<{ key: TabKey; label: string; icon: IconName; url: string }> = [
  { key: 'schedule', label: '日程', icon: 'list', url: '/pages/schedule/index' },
  { key: 'calendar', label: '日历', icon: 'calendar', url: '/pages/calendar/index' },
  { key: 'alerts', label: '告警', icon: 'alert', url: '/pages/alerts/index' },
  { key: 'settings', label: '设置', icon: 'gear', url: '/pages/settings/index' }
]

export interface TabBarProps {
  active: TabKey
}

/** 自定义底部导航（带「告警未读」角标）；桌面形态由侧边栏取代 */
export function TabBar({ active }: TabBarProps) {
  const desktop = useDesktopUI()
  const alerts = useAlertsStore((s) => s.alerts)
  const unread = alerts.filter((a) => !a.read_at).length

  if (desktop) return null

  return (
    <View className='tabbar'>
      <View className='tabbar__inner'>
        {TABS.map((tab) => {
          const isActive = tab.key === active
          return (
            <View
              key={tab.key}
              className={`tabbar__item pressable${isActive ? ' is-active' : ''}`}
              onClick={() => {
                if (isActive) return
                Taro.redirectTo({ url: tab.url }).catch(() => undefined)
              }}
            >
              <View className='tabbar__icon-wrap'>
                <Icon name={tab.icon} className='tabbar__icon' strokeWidth={isActive ? 2.1 : 1.7} />
                {tab.key === 'alerts' && unread > 0 ? (
                  <View className='tabbar__badge'>
                    <Text className='tabbar__badge-text'>{unread > 99 ? '99+' : String(unread)}</Text>
                  </View>
                ) : null}
              </View>
              <Text className='tabbar__label'>{tab.label}</Text>
            </View>
          )
        })}
      </View>
    </View>
  )
}
