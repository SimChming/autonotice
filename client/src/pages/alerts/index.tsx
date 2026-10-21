import { useState } from 'react'
import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'

import { Empty } from '../../components/Empty'
import { Icon, type IconName } from '../../components/Icon'
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

/** 把 CQ 代码 / HTML 残留 清洗干净，兜底（服务端也做了，前端双保险） */
function cleanCQ(s: string): string {
  if (!s) return ''
  return s
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 根据 alert 的来源字段决定显示成 "群聊" 还是 "私聊" */
function sourceLabel(a: { message_type?: string; source_name?: string; group_id?: string }) {
  const isPrivate = a.message_type === 'private' || (!a.message_type && !a.group_id)
  const icon: IconName = isPrivate ? 'user' : 'groups'
  const label = isPrivate ? '私聊' : '群聊'
  const detail = a.source_name || (isPrivate ? '' : a.group_id ? `群 ${a.group_id}` : '')
  return { icon, label, detail, isPrivate }
}

/** 头像占位：没头像 URL 时用字母代替 */
function avatarInitial(name?: string): string {
  if (!name) return '?'
  const ch = name.trim().charAt(0)
  return ch || '?'
}

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
            const src = sourceLabel(a)
            return (
              <View key={a.id} className={`alert-card card${isUnread ? ' is-unread' : ''}`}>
                {/* 来源行：头像 + "群聊/私聊" + 名称 */}
                <View className='alert-card__source'>
                  {a.source_avatar ? (
                    <Image
                      className='alert-card__avatar'
                      src={a.source_avatar}
                      mode='aspectFill'
                    />
                  ) : (
                    <View className={`alert-card__avatar alert-card__avatar-placeholder${src.isPrivate ? ' is-private' : ''}`}>
                      <Text className='alert-card__avatar-text'>{avatarInitial(src.detail)}</Text>
                    </View>
                  )}
                  <View className='alert-card__source-info'>
                    <View className='alert-card__source-label'>
                      <Icon name={src.icon} className='alert-card__source-icon' strokeWidth={2} />
                      <Text className='alert-card__source-type'>{src.label}</Text>
                    </View>
                    {src.detail ? <Text className='alert-card__source-name'>{src.detail}</Text> : null}
                  </View>
                  <Text className='alert-card__time'>{fmtRelative(a.created_at)}</Text>
                  {isUnread ? <View className='alert-card__dot' /> : null}
                </View>

                {/* 优先级 + 标题 */}
                <View className='alert-card__head'>
                  <View className={`alert-card__level${a.level === 'high' ? ' is-high' : ''}`}>
                    <Text className='alert-card__level-text'>
                      {a.level === 'high' ? '高优先' : '提示'}
                    </Text>
                  </View>
                </View>

                <Text className='alert-card__title'>{cleanCQ(a.title)}</Text>
                <Text className='alert-card__summary'>{cleanCQ(a.summary)}</Text>

                {a.context_excerpt ? (
                  <View className='alert-card__excerpt'>
                    <Text className='alert-card__excerpt-text'>{cleanCQ(a.context_excerpt)}</Text>
                  </View>
                ) : null}

                {a.review_reason ? (
                  <View className='alert-card__reason'>
                    <Icon name='alert' className='alert-card__reason-icon' strokeWidth={1.8} />
                    <Text className='alert-card__reason-text'>{cleanCQ(a.review_reason)}</Text>
                  </View>
                ) : null}

                <View className='alert-card__footer'>
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
