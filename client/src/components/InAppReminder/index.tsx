import { useEffect, useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'

import { REMINDER_EVENT } from '../../services/notify/types'
import './index.scss'

interface ReminderDetail {
  title: string
  body: string
  route?: string
  highPriority?: boolean
}

const AUTO_DISMISS_MS = 15000

/**
 * 应用内兜底提醒：当系统通知不可用（浏览器拒绝 / 不支持）时，
 * WebNotifier 会派发 REMINDER_EVENT，这里弹出一条 Apple-like 横幅。
 */
export function InAppReminder() {
  const [items, setItems] = useState<Array<ReminderDetail & { id: number }>>([])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    let seq = 0
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as ReminderDetail
      if (!detail?.title) return
      seq += 1
      const id = Date.now() + seq
      setItems((prev) => [...prev.slice(-2), { ...detail, id }])
      setTimeout(() => setItems((prev) => prev.filter((it) => it.id !== id)), AUTO_DISMISS_MS)
    }
    window.addEventListener(REMINDER_EVENT, handler)
    return () => window.removeEventListener(REMINDER_EVENT, handler)
  }, [])

  const dismiss = (id: number) => setItems((prev) => prev.filter((it) => it.id !== id))

  if (!items.length) return null

  return (
    <View className='reminder-layer'>
      {items.map((it) => (
        <View
          key={it.id}
          className={`reminder-card${it.highPriority ? ' is-urgent' : ''}`}
          onClick={() => {
            dismiss(it.id)
            if (it.route) Taro.navigateTo({ url: it.route }).catch(() => undefined)
          }}
        >
          <View className='reminder-card__head'>
            <Text className='reminder-card__title'>{it.title}</Text>
            <Text
              className='reminder-card__close'
              onClick={(e) => {
                e.stopPropagation()
                dismiss(it.id)
              }}
            >
              ×
            </Text>
          </View>
          <Text className='reminder-card__body'>{it.body}</Text>
          <Text className='reminder-card__hint'>
            {it.route ? '点击查看详情' : '应用内提醒'}
          </Text>
        </View>
      ))}
    </View>
  )
}
