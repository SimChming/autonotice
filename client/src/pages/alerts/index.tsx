import { useState } from 'react'
import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'

import { Empty } from '../../components/Empty'
import { Icon } from '../../components/Icon'
import { PageHeader } from '../../components/PageHeader'
import { TabBar } from '../../components/TabBar'
import { api } from '../../services/api'
import { refreshAlerts } from '../../services/sync'
import { reschedule } from '../../services/notify/scheduler'
import { useAlertsStore } from '../../store/alerts'
import { fmtRelative } from '../../utils/date'
import { copyText } from '../../utils/storage'
import { useAuthGuard } from '../../utils/useAuthGuard'
import './index.scss'

/** 「需人工查看」告警：被屏蔽/无法抓取的群内容 */
export default function AlertsPage() {
  useAuthGuard()

  const alerts = useAlertsStore((s) => s.alerts)
  const [busy, setBusy] = useState('')

  const unread = alerts.filter((a) => !a.read_at)

  async function markRead(id: string) {
    setBusy(id)
    try {
      await api.readAlert(id)
    } catch {
      /* 离线也要允许本地标记，服务端稍后同步 */
    }
    useAlertsStore.getState().markRead(id)
    setBusy('')
  }

  async function markAllRead() {
    for (const a of unread) {
      try {
        await api.readAlert(a.id)
      } catch {
        /* 忽略 */
      }
    }
    useAlertsStore.getState().markAllRead()
    void reschedule({ force: true }).catch(() => undefined)
    Taro.showToast({ title: '已全部标记', icon: 'none' })
  }

  async function refresh() {
    try {
      await refreshAlerts()
      void reschedule({ force: true }).catch(() => undefined)
      Taro.showToast({ title: '已刷新', icon: 'none' })
    } catch {
      Taro.showToast({ title: '网络不可用，显示本地缓存', icon: 'none' })
    }
  }

  return (
    <View className='page-root alerts'>
      <PageHeader
        title='待查看'
        subtitle={unread.length ? `${unread.length} 条需人工确认` : '没有待确认的内容'}
        right={
          <View className='alerts__actions'>
            <View className='alerts__action pressable' onClick={() => void refresh()}>
              <Icon name='refresh' className='alerts__action-icon' strokeWidth={2} />
            </View>
            {unread.length ? (
              <View className='alerts__action pressable' onClick={() => void markAllRead()}>
                <Text className='alerts__action-text'>全部已读</Text>
              </View>
            ) : null}
          </View>
        }
      />

      <View className='page-scroll alerts__list'>
        {alerts.length ? (
          alerts.map((a) => {
            const isUnread = !a.read_at
            return (
              <View key={a.id} className={`alert-card card${isUnread ? ' is-unread' : ''}`}>
                <View className='alert-card__head'>
                  <View className={`alert-card__level${a.level === 'high' ? ' is-high' : ''}`}>
                    <Text className='alert-card__level-text'>
                      {a.level === 'high' ? '高优先' : '提示'}
                    </Text>
                  </View>
                  <Text className='alert-card__time'>{fmtRelative(a.created_at)}</Text>
                  {isUnread ? <View className='alert-card__dot' /> : null}
                </View>

                <Text className='alert-card__title'>{a.title}</Text>
                <Text className='alert-card__summary'>{a.summary}</Text>

                {a.context_excerpt ? (
                  <View className='alert-card__excerpt'>
                    <Text className='alert-card__excerpt-text'>{a.context_excerpt}</Text>
                  </View>
                ) : null}

                {a.review_reason ? (
                  <View className='alert-card__reason'>
                    <Icon name='alert' className='alert-card__reason-icon' strokeWidth={1.8} />
                    <Text className='alert-card__reason-text'>{a.review_reason}</Text>
                  </View>
                ) : null}

                <View className='alert-card__footer'>
                  <Text className='alert-card__group'>群 {a.group_id}</Text>
                  <View className='alert-card__buttons'>
                    <View
                      className='alert-card__btn pressable'
                      onClick={() => copyText(`${a.title}\n${a.summary}`)}
                    >
                      <Icon name='copy' className='alert-card__btn-icon' strokeWidth={1.8} />
                      <Text className='alert-card__btn-text'>复制</Text>
                    </View>
                    {isUnread ? (
                      <View
                        className='alert-card__btn is-primary pressable'
                        onClick={() => void markRead(a.id)}
                      >
                        <Text className='alert-card__btn-text is-primary'>
                          {busy === a.id ? '处理中' : '标记已读'}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>
              </View>
            )
          })
        ) : (
          <Empty title='暂无待查看内容' hint='当群里的文件/链接抓取失败或被屏蔽时，这里会出现高优先提醒' />
        )}
      </View>

      <TabBar active='alerts' />
    </View>
  )
}
