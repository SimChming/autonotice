import { useMemo, useState } from 'react'
import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'

import { Empty } from '../../components/Empty'
import { Icon } from '../../components/Icon'
import { ItemCard } from '../../components/ItemCard'
import { PageHeader } from '../../components/PageHeader'
import { TabBar } from '../../components/TabBar'
import { reschedule } from '../../services/notify/scheduler'
import { toggleDone } from '../../services/sync'
import { sortItems, useScheduleStore } from '../../store/schedule'
import { buildMonthGrid, dateKey, monthLabel, toMs } from '../../utils/date'
import { useAuthGuard } from '../../utils/useAuthGuard'
import './index.scss'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

export default function CalendarPage() {
  useAuthGuard()

  const items = useScheduleStore((s) => s.items)
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth())
  const [selected, setSelected] = useState(dateKey(today))

  const cells = useMemo(() => buildMonthGrid(year, month), [year, month])

  /** 日期 → 该日条目（含逾期的当天，用于点标记） */
  const byDay = useMemo(() => {
    const map = new Map<string, typeof items>()
    for (const it of items) {
      const ms = toMs(it.due_at)
      if (ms === null) continue
      const key = dateKey(ms)
      const arr = map.get(key) || []
      arr.push(it)
      map.set(key, arr)
    }
    return map
  }, [items])

  const dayItems = useMemo(() => sortItems(byDay.get(selected) || []), [byDay, selected])

  function shift(delta: number) {
    const d = new Date(year, month + delta, 1)
    setYear(d.getFullYear())
    setMonth(d.getMonth())
  }

  function gotoToday() {
    const d = new Date()
    setYear(d.getFullYear())
    setMonth(d.getMonth())
    setSelected(dateKey(d))
  }

  async function onToggle(item: (typeof items)[number]) {
    const res = await toggleDone(item)
    if (!res.ok && !res.queued) Taro.showToast({ title: res.error || '保存失败', icon: 'none' })
    else void reschedule({ force: true }).catch(() => undefined)
  }

  return (
    <View className='page-root calendar'>
      <PageHeader
        title='日历'
        subtitle='按天查看已有日程'
        right={
          <View className='calendar__today pressable' onClick={gotoToday}>
            <Text className='calendar__today-text'>今天</Text>
          </View>
        }
      />

      <View className='calendar__panel card'>
        <View className='calendar__month-bar'>
          <View className='calendar__nav pressable' onClick={() => shift(-1)}>
            <Icon name='chevron' className='calendar__nav-icon is-prev' strokeWidth={2.2} />
          </View>
          <Text className='calendar__month'>{monthLabel(year, month)}</Text>
          <View className='calendar__nav pressable' onClick={() => shift(1)}>
            <Icon name='chevron' className='calendar__nav-icon' strokeWidth={2.2} />
          </View>
        </View>

        <View className='calendar__weekdays'>
          {WEEKDAYS.map((w) => (
            <Text key={w} className='calendar__weekday'>
              {w}
            </Text>
          ))}
        </View>

        <View className='calendar__grid'>
          {cells.map((cell) => {
            const dayList = byDay.get(cell.key) || []
            const hasOpen = dayList.some((it) => it.status !== 'done' && it.status !== 'ignored')
            const isSelected = cell.key === selected
            return (
              <View
                key={cell.key}
                className={`calendar__cell${cell.inMonth ? '' : ' is-out'}${
                  isSelected ? ' is-selected' : ''
                }${cell.isToday ? ' is-today' : ''}`}
                onClick={() => setSelected(cell.key)}
              >
                <Text className='calendar__day'>{cell.date.getDate()}</Text>
                {dayList.length ? (
                  <View className={`calendar__dot${hasOpen ? ' is-open' : ''}`} />
                ) : null}
              </View>
            )
          })}
        </View>
      </View>

      <View className='page-scroll calendar__list'>
        <Text className='section-title'>
          {selected.replace(/-/g, '/')} · {dayItems.length} 条
        </Text>
        {dayItems.length ? (
          dayItems.map((item) => (
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
          <Empty title='这一天没有日程' hint='点其它日期看看，或回到日程页查看今日待办' />
        )}
      </View>

      <TabBar active='calendar' />
    </View>
  )
}
