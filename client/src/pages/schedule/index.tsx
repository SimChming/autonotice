import { useEffect, useMemo, useState } from 'react'
import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'

import { ConflictSheet } from '../../components/ConflictSheet'
import { Empty } from '../../components/Empty'
import { Icon } from '../../components/Icon'
import { ItemCard } from '../../components/ItemCard'
import { PageHeader } from '../../components/PageHeader'
import { ReasoningPanel } from '../../components/ReasoningPanel'
import { TabBar } from '../../components/TabBar'
import { reschedule } from '../../services/notify/scheduler'
import { loadSavedReplan, runReplan } from '../../services/replan'
import { refreshNow, resolveConflict, syncStatus, toggleDone, type ConflictStrategy } from '../../services/sync'
import { useReplanStore } from '../../store/replan'
import { useScheduleStore, sortItems } from '../../store/schedule'
import { endOfWeek, isPast, isToday, isThisWeek, startOfDay, toMs } from '../../utils/date'
import { useAuthGuard } from '../../utils/useAuthGuard'
import './index.scss'

type Filter = 'today' | 'week' | 'all'

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'today', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'all', label: '全部' }
]

export default function SchedulePage() {
  useAuthGuard()

  const items = useScheduleStore((s) => s.items)
  const digest = useScheduleStore((s) => s.digest)
  const syncing = useScheduleStore((s) => s.syncing)
  const conflicts = useScheduleStore((s) => s.conflicts)
  const lastSyncAt = useScheduleStore((s) => s.lastSyncAt)

  const replanStatus = useReplanStore((s) => s.status)
  const replanPhase = useReplanStore((s) => s.phase)
  const replanBusy = useReplanStore((s) => s.busy)
  const reasoning = useReplanStore((s) => s.reasoning)
  const replanAnswer = useReplanStore((s) => s.answer)
  const replanExpanded = useReplanStore((s) => s.expanded)
  const replanError = useReplanStore((s) => s.error)
  const replanNewItems = useReplanStore((s) => s.newItems)
  const replanSavedAt = useReplanStore((s) => s.savedAt)
  const toggleReplanExpanded = useReplanStore((s) => s.toggleExpanded)

  const [filter, setFilter] = useState<Filter>('today')
  const [dismissedConflicts, setDismissedConflicts] = useState<string[]>([])

  // 首次进入时拉取「上次思考链」（服务端只保留最近一条）
  useEffect(() => {
    void loadSavedReplan()
  }, [])

  const activeConflict = conflicts.find((c) => !dismissedConflicts.includes(c.itemId)) || null

  const visible = useMemo(() => {
    const overdue = items.filter((it) => it.status !== 'done' && isPast(it.due_at))
    const pool =
      filter === 'today'
        ? items.filter((it) => isToday(it.due_at) || overdue.includes(it))
        : filter === 'week'
          ? items.filter((it) => isThisWeek(it.due_at) || overdue.includes(it))
          : items
    return sortItems(pool)
  }, [items, filter])

  const stats = useMemo(() => {
    const start = startOfDay(Date.now()).getTime()
    const weekEnd = endOfWeek(Date.now()).getTime()
    const todo = items.filter((it) => it.status !== 'done' && it.status !== 'ignored')
    return {
      todayCount: todo.filter((it) => {
        const ms = toMs(it.due_at)
        return ms !== null && ms >= start && ms < start + 86400000
      }).length,
      weekCount: todo.filter((it) => {
        const ms = toMs(it.due_at)
        return ms !== null && ms <= weekEnd
      }).length,
      overdue: todo.filter((it) => isPast(it.due_at)).length,
      done: items.filter((it) => it.status === 'done').length
    }
  }, [items])

  /** 手动刷新：立即强制拉最新（不等自动轮询），并重排提醒 */
  async function refresh() {
    await refreshNow()
    await reschedule({ force: true, includeAlerts: true }).catch(() => undefined)
    Taro.showToast({ title: '已刷新', icon: 'none' })
  }

  /** 一键实时排程：触发后由 ReasoningPanel 实时展示思考链 */
  function onReplan() {
    if (replanBusy) return
    void runReplan().catch(() => undefined)
  }

  async function onToggle(item: (typeof items)[number]) {
    const res = await toggleDone(item)
    if (res.conflict) {
      Taro.showToast({ title: '这条在别处被改过，请处理冲突', icon: 'none' })
    } else if (res.queued) {
      Taro.showToast({ title: '已离线保存，联网后自动同步', icon: 'none' })
    } else if (!res.ok) {
      Taro.showToast({ title: res.error || '保存失败', icon: 'none' })
    } else {
      void reschedule({ force: true }).catch(() => undefined)
    }
  }

  async function onResolve(strategy: ConflictStrategy) {
    if (!activeConflict) return
    const res = await resolveConflict(activeConflict.itemId, strategy)
    if (res.ok) {
      setDismissedConflicts((prev) => [...prev, activeConflict.itemId])
      Taro.showToast({ title: '已处理', icon: 'none' })
    } else {
      Taro.showToast({ title: res.error || '处理失败', icon: 'none' })
    }
  }

  const pending = syncStatus().pending
  const subtitle =
    digest ||
    (stats.todayCount
      ? `今天 ${stats.todayCount} 项待办${stats.overdue ? ` · ${stats.overdue} 项逾期` : ''}`
      : '今天没有到期日程')

  return (
    <View className='page-root schedule'>
      <PageHeader
        title='日程'
        subtitle={subtitle}
        right={
          <View className='schedule__actions'>
            <View
              className={`schedule__replan pressable${replanBusy ? ' is-busy' : ''}`}
              onClick={onReplan}
            >
              <Icon name='sparkle' className='schedule__replan-icon' strokeWidth={1.8} />
              <Text className='schedule__replan-text'>
                {replanBusy ? '排程中…' : '一键排程'}
              </Text>
            </View>
            <View className='schedule__refresh pressable' onClick={() => void refresh()}>
              <Icon
                name='refresh'
                className={`schedule__refresh-icon${syncing ? ' is-spinning' : ''}`}
                strokeWidth={2}
              />
            </View>
          </View>
        }
      />

      <View className='schedule__filters'>
        {FILTERS.map((f) => (
          <View
            key={f.key}
            className={`schedule__filter${filter === f.key ? ' is-active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            <Text className='schedule__filter-text'>{f.label}</Text>
          </View>
        ))}
      </View>

      {pending > 0 ? (
        <View className='schedule__banner'>
          <Icon name='refresh' className='schedule__banner-icon' strokeWidth={1.8} />
          <Text className='schedule__banner-text'>{pending} 条改动待同步（离线保存）</Text>
        </View>
      ) : null}

      <View className='schedule__stats'>
        <Text className='schedule__stat'>本周 {stats.weekCount}</Text>
        <Text className='schedule__stat'>已完成 {stats.done}</Text>
        {lastSyncAt ? (
          <Text className='schedule__stat is-muted'>
            同步于 {new Date(lastSyncAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
          </Text>
        ) : null}
      </View>

      <ReasoningPanel
        status={replanStatus}
        phase={replanPhase}
        reasoning={reasoning}
        answer={replanAnswer}
        expanded={replanExpanded}
        error={replanError}
        newItems={replanNewItems}
        savedAt={replanSavedAt}
        onToggle={toggleReplanExpanded}
      />

      <View className='page-scroll schedule__list'>
        {visible.length ? (
          visible.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              onToggle={onToggle}
              onClick={(it) =>
                Taro.navigateTo({ url: `/pages/detail/index?id=${encodeURIComponent(it.id)}` }).catch(
                  () => undefined
                )
              }
            />
          ))
        ) : (
          <Empty
            title={filter === 'today' ? '今天没有日程' : '这里还是空的'}
            hint='等群里出现考试、DDL、缴费或活动消息，AI 会自动整理成日程'
          />
        )}
      </View>

      <TabBar active='schedule' />

      <ConflictSheet
        record={activeConflict}
        onChoose={(s) => void onResolve(s)}
        onClose={() => activeConflict && setDismissedConflicts((p) => [...p, activeConflict.itemId])}
      />
    </View>
  )
}
