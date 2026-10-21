import { useMemo, useState } from 'react'
import { Input, Picker, Switch, Text, Textarea, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'

import { ConflictSheet } from '../../components/ConflictSheet'
import { Empty } from '../../components/Empty'
import { Icon } from '../../components/Icon'
import { PageHeader } from '../../components/PageHeader'
import { SourceCard } from '../../components/SourceCard'
import { reschedule } from '../../services/notify/scheduler'
import {
  applyLocalEdit,
  commitItem,
  resolveConflict,
  type ConflictStrategy
} from '../../services/sync'
import { api } from '../../services/api'
import { useAlertsStore } from '../../store/alerts'
import { useScheduleStore } from '../../store/schedule'
import { TYPE_META } from '../../components/ItemCard'
import { fmtRelative, parseDate, toMs } from '../../utils/date'
import { copyText } from '../../utils/storage'
import { normalizeNotes } from '../../utils/text'
import './index.scss'

const TYPES = ['exam', 'deadline', 'payment', 'event', 'other']
const PRIORITIES = ['high', 'normal', 'low']
const PRIORITY_LABEL: Record<string, string> = { high: '高', normal: '普通', low: '低' }
const STATUSES = ['todo', 'doing', 'done']
const STATUS_LABEL: Record<string, string> = { todo: '待办', doing: '进行中', done: '已完成' }

/** 服务端使用 Asia/Shanghai，客户端按 +08:00 显式拼接 RFC3339 */
function composeRFC3339(date: string, time: string): string {
  return `${date}T${time}:00+08:00`
}

function splitRFC3339(value?: string | null): { date: string; time: string } {
  const d = parseDate(value)
  if (!d) return { date: '', time: '' }
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
}

export default function DetailPage() {
  const router = useRouter()
  const id = router.params?.id
  const alertId = router.params?.alertId

  const items = useScheduleStore((s) => s.items)
  const conflicts = useScheduleStore((s) => s.conflicts)
  const alerts = useAlertsStore((s) => s.alerts)

  const item = useMemo(() => items.find((it) => it.id === id) || null, [items, id])
  const alert = useMemo(() => alerts.find((a) => a.id === alertId) || null, [alerts, alertId])

  const [title, setTitle] = useState(item?.title || '')
  const [type, setType] = useState(item?.type || 'other')
  const [priority, setPriority] = useState(item?.priority || 'normal')
  const [status, setStatus] = useState(item?.status || 'todo')
  const [notes, setNotes] = useState(normalizeNotes(item?.notes))
  const [allDay, setAllDay] = useState(Boolean(item?.all_day))

  const initial = splitRFC3339(item?.due_at)
  const [dueDate, setDueDate] = useState(initial.date)
  const [dueTime, setDueTime] = useState(initial.time || '09:00')

  const initialRemind = splitRFC3339(item?.remind_at)
  const [remindDate, setRemindDate] = useState(initialRemind.date)
  const [remindTime, setRemindTime] = useState(initialRemind.time || '08:00')

  const [saving, setSaving] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const activeConflict = conflicts.find((c) => c.itemId === item?.id) || null

  // ---------------------------------------------------------------- 告警模式
  if (!item && alert) {
    return (
      <View className='page-root detail'>
        <PageHeader title='需人工查看' subtitle={`群 ${alert.group_id}`} back />
        <View className='page-scroll detail__scroll'>
          <View className='detail__hero card'>
            <View className={`detail__level${alert.level === 'high' ? ' is-high' : ''}`}>
              <Text className='detail__level-text'>{alert.level === 'high' ? '高优先' : '提示'}</Text>
            </View>
            <Text className='detail__title'>{alert.title}</Text>
            <Text className='detail__time'>发生 {fmtRelative(alert.created_at)}</Text>
          </View>

          <View className='detail__group card'>
            <Text className='section-title'>AI 整理的内容</Text>
            <Text className='detail__body'>{alert.summary}</Text>
            {alert.context_excerpt ? (
              <View className='detail__excerpt'>
                <Text className='detail__excerpt-text'>{alert.context_excerpt}</Text>
              </View>
            ) : null}
            {alert.review_reason ? (
              <View className='detail__reason'>
                <Icon name='alert' className='detail__reason-icon' strokeWidth={1.8} />
                <Text className='detail__reason-text'>{alert.review_reason}</Text>
              </View>
            ) : null}
          </View>

          <View className='detail__buttons'>
            <View
              className='detail__btn pressable'
              onClick={() => copyText(`${alert.title}\n${alert.summary}\n${alert.review_reason}`)}
            >
              <Icon name='copy' className='detail__btn-icon' strokeWidth={1.8} />
              <Text className='detail__btn-text'>复制内容</Text>
            </View>
            <View
              className='detail__btn is-primary pressable'
              onClick={async () => {
                try {
                  await api.readAlert(alert.id)
                } catch {
                  /* 离线也允许本地标记 */
                }
                useAlertsStore.getState().markRead(alert.id)
                void reschedule({ force: true }).catch(() => undefined)
                Taro.showToast({ title: '已标记已读', icon: 'none' })
              }}
            >
              <Text className='detail__btn-text is-primary'>标记已读</Text>
            </View>
          </View>

          <Text className='detail__notice'>
            服务端无法读取这条内容（可能被登录墙/验证码拦截，或小程序/微信链接无法抓取），
            建议回到 QQ 群按标题自行查看原文件或链接。
          </Text>
        </View>
      </View>
    )
  }

  // ---------------------------------------------------------------- 条目模式
  if (!item) {
    return (
      <View className='page-root detail'>
        <PageHeader title='日程详情' back />
        <View className='page-scroll detail__scroll'>
          <Empty title='没有找到这条日程' hint='它可能已在其它设备被删除' />
        </View>
      </View>
    )
  }

  async function save() {
    if (!item) return
    setSaving(true)
    const edited = applyLocalEdit(item, {
      title: title.trim() || item.title,
      type: type as typeof item.type,
      priority: priority as typeof item.priority,
      status: status as typeof item.status,
      notes: normalizeNotes(notes),
      all_day: allDay,
      due_at: dueDate ? composeRFC3339(dueDate, allDay ? '00:00' : dueTime) : null,
      remind_at: remindDate ? composeRFC3339(remindDate, remindTime) : null
    })
    const res = await commitItem(edited)
    setSaving(false)
    if (res.conflict) {
      Taro.showToast({ title: '检测到冲突，请选择合并方式', icon: 'none' })
      return
    }
    if (!res.ok) {
      Taro.showToast({ title: res.error || '保存失败', icon: 'none' })
      return
    }
    void reschedule({ force: true }).catch(() => undefined)
    Taro.showToast({ title: res.queued ? '已离线保存' : '已保存', icon: 'success' })
  }

  async function remove() {
    if (!item) return
    const r = await Taro.showModal({ title: '删除日程', content: `确定删除「${item.title}」？` })
    if (!r.confirm) return
    const res = await commitItem(item, 'delete')
    if (!res.ok && !res.queued) {
      Taro.showToast({ title: res.error || '删除失败', icon: 'none' })
      return
    }
    void reschedule({ force: true }).catch(() => undefined)
    Taro.navigateBack().catch(() => Taro.redirectTo({ url: '/pages/schedule/index' }))
  }

  async function onResolve(strategy: ConflictStrategy) {
    if (!item) return
    const res = await resolveConflict(item.id, strategy)
    if (res.ok) {
      setDismissed(true)
      void reschedule({ force: true }).catch(() => undefined)
      Taro.showToast({ title: '已合并', icon: 'none' })
    } else {
      Taro.showToast({ title: res.error || '处理失败', icon: 'none' })
    }
  }

  const remindPreview = item.remind_at
    ? '按你指定的时间提醒'
    : `未指定提醒时间时，按默认偏移（-24h / -2h / -15m）提醒；也可在设置页调整`

  return (
    <View className='page-root detail'>
      <PageHeader title='日程详情' subtitle={TYPE_META[item.type]?.label} back />

      <View className='page-scroll detail__scroll'>
        <View className='detail__group card'>
          <Text className='section-title'>标题</Text>
          <Input className='detail__input' value={title} onInput={(e) => setTitle(e.detail.value)} />
        </View>

        <View className='detail__group card'>
          <Text className='section-title'>属性</Text>

          <View className='detail__row'>
            <Text className='detail__label'>类型</Text>
            <Picker
              mode='selector'
              range={TYPES.map((t) => TYPE_META[t]?.label || t)}
              value={TYPES.indexOf(type)}
              onChange={(e) => setType(TYPES[Number(e.detail.value)] || 'other')}
            >
              <View className='detail__value'>
                <Text className='detail__value-text'>{TYPE_META[type]?.label || type}</Text>
                <Icon name='chevron' className='detail__value-arrow' strokeWidth={2} />
              </View>
            </Picker>
          </View>

          <View className='divider' />

          <View className='detail__row'>
            <Text className='detail__label'>优先级</Text>
            <Picker
              mode='selector'
              range={PRIORITIES.map((p) => PRIORITY_LABEL[p])}
              value={PRIORITIES.indexOf(priority)}
              onChange={(e) => setPriority(PRIORITIES[Number(e.detail.value)] || 'normal')}
            >
              <View className='detail__value'>
                <Text className='detail__value-text'>{PRIORITY_LABEL[priority]}</Text>
                <Icon name='chevron' className='detail__value-arrow' strokeWidth={2} />
              </View>
            </Picker>
          </View>

          <View className='divider' />

          <View className='detail__row'>
            <Text className='detail__label'>状态</Text>
            <Picker
              mode='selector'
              range={STATUSES.map((s) => STATUS_LABEL[s])}
              value={STATUSES.indexOf(status)}
              onChange={(e) => setStatus(STATUSES[Number(e.detail.value)] || 'todo')}
            >
              <View className='detail__value'>
                <Text className='detail__value-text'>{STATUS_LABEL[status]}</Text>
                <Icon name='chevron' className='detail__value-arrow' strokeWidth={2} />
              </View>
            </Picker>
          </View>
        </View>

        <View className='detail__group card'>
          <Text className='section-title'>时间</Text>

          <View className='detail__row'>
            <Text className='detail__label'>日期</Text>
            <View className='detail__inline'>
              <Picker
                mode='date'
                value={dueDate || '2026-01-01'}
                onChange={(e) => setDueDate(String(e.detail.value))}
              >
                <View className='detail__value'>
                  <Text className={`detail__value-text${dueDate ? '' : ' is-empty'}`}>
                    {dueDate || '选择日期'}
                  </Text>
                </View>
              </Picker>
              {!allDay ? (
                <Picker
                  mode='time'
                  value={dueTime}
                  onChange={(e) => setDueTime(String(e.detail.value))}
                >
                  <View className='detail__value'>
                    <Text className='detail__value-text'>{dueTime}</Text>
                  </View>
                </Picker>
              ) : null}
            </View>
          </View>

          <View className='detail__row'>
            <Text className='detail__label'>全天</Text>
            <Switch checked={allDay} color='#0a84ff' onChange={(e) => setAllDay(e.detail.value)} />
          </View>

          <View className='divider' />

          <View className='detail__row'>
            <Text className='detail__label'>提醒</Text>
            <View className='detail__inline'>
              <Picker
                mode='date'
                value={remindDate || '2026-01-01'}
                onChange={(e) => setRemindDate(String(e.detail.value))}
              >
                <View className='detail__value'>
                  <Text className={`detail__value-text${remindDate ? '' : ' is-empty'}`}>
                    {remindDate ? `${remindDate} ${remindTime}` : '按默认偏移'}
                  </Text>
                </View>
              </Picker>
            </View>
          </View>

          <View className='detail__hint-row'>
            <Text className='detail__hint'>{remindPreview}</Text>
            {remindDate ? (
              <Text
                className='detail__clear'
                onClick={() => {
                  setRemindDate('')
                  setRemindTime('')
                }}
              >
                清除
              </Text>
            ) : null}
          </View>

          <View className='detail__hint-row'>
            <Text className='detail__hint'>
              截止时间已过仍会保留，逾期未完成的条目会以红色高亮并在日历上标记。
            </Text>
            {dueDate ? (
              <Text
                className='detail__clear'
                onClick={() => {
                  setDueDate('')
                  setDueTime('09:00')
                }}
              >
                清除截止
              </Text>
            ) : null}
          </View>
        </View>

        <View className='detail__group card'>
          <Text className='section-title'>备注</Text>
          <Textarea
            className='detail__textarea'
            value={notes}
            placeholder='补充说明（只有你会看到）'
            maxlength={-1}
            onInput={(e) => setNotes(e.detail.value)}
          />
        </View>

        {item.source ? (
          <View className='detail__group-block'>
            <Text className='section-title'>来源</Text>
            <SourceCard source={item.source} />
          </View>
        ) : null}

        <View className='detail__buttons'>
          <View className='detail__btn pressable' onClick={() => void remove()}>
            <Text className='detail__btn-text is-danger'>删除</Text>
          </View>
          <View
            className={`detail__btn is-primary pressable${saving ? ' is-loading' : ''}`}
            onClick={() => {
              if (!saving) void save()
            }}
          >
            <Text className='detail__btn-text is-primary'>{saving ? '保存中…' : '保存修改'}</Text>
          </View>
        </View>

        <Text className='detail__meta'>
          条目标识 {item.id} · 版本 {item.revision}
          {item.locked_by_user ? ' · 已被你修改，AI 不会覆盖' : ''}
        </Text>
      </View>

      <ConflictSheet
        record={dismissed ? null : activeConflict}
        onChoose={(s) => void onResolve(s)}
        onClose={() => setDismissed(true)}
      />
    </View>
  )
}
