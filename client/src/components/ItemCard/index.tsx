import { View, Text } from '@tarojs/components'

import type { ScheduleItem } from '../../types'
import { fmtCountdown, fmtDate, fmtRelative, fmtTime, isPast } from '../../utils/date'
import { GroupChip } from '../GroupChip'
import { Icon } from '../Icon'
import { sourceGroupLabel } from '../SourceCard'
import './index.scss'

export const TYPE_META: Record<string, { label: string; className: string }> = {
  exam: { label: '考试', className: 'is-exam' },
  deadline: { label: '截止', className: 'is-deadline' },
  payment: { label: '缴费', className: 'is-payment' },
  event: { label: '活动', className: 'is-event' },
  other: { label: '日程', className: 'is-other' }
}

export interface ItemCardProps {
  item: ScheduleItem
  onToggle?: (item: ScheduleItem) => void
  onClick?: (item: ScheduleItem) => void
}

function timeText(item: ScheduleItem): string {
  if (!item.due_at) return '未定时间'
  if (item.all_day) return `${fmtDate(item.due_at)} 全天`
  return `${fmtDate(item.due_at)} ${fmtTime(item.due_at)}`
}

export function ItemCard({ item, onToggle, onClick }: ItemCardProps) {
  const meta = TYPE_META[item.type] || TYPE_META.other
  const done = item.status === 'done'
  const overdue = !done && isPast(item.due_at)
  const asset = item.source?.content_asset_id
  const groups = sourceGroupLabel(item.source)

  return (
    <View className={`item-card card pressable${done ? ' is-done' : ''}`} onClick={() => onClick?.(item)}>
      <View
        className={`item-card__check${done ? ' is-checked' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          onToggle?.(item)
        }}
      >
        {done ? <Icon name='check' className='item-card__check-icon' strokeWidth={2.6} /> : null}
      </View>

      <View className='item-card__main'>
        <Text className='item-card__title'>{item.title || '未命名日程'}</Text>

        <View className='item-card__meta'>
          <Text className={`item-card__chip ${meta.className}`}>{meta.label}</Text>
          <Text className={`item-card__time${overdue ? ' is-overdue' : ''}`}>{timeText(item)}</Text>
          {overdue ? <Text className='item-card__count'>{fmtCountdown(item.due_at)}</Text> : null}
        </View>

        {item.remind_at ? (
          <View className='item-card__remind'>
            <Icon name='bell' className='item-card__remind-icon' strokeWidth={1.8} />
            <Text className='item-card__remind-text'>提醒 {fmtRelative(item.remind_at)}</Text>
          </View>
        ) : null}

        {item.priority === 'high' ? <View className='item-card__flag'>高优先级</View> : null}

        {groups.length ? (
          <View className='item-card__group'>
            <GroupChip groupId={groups[0].group_id} name={groups[0].name} size='sm' />
            {groups.length > 1 ? (
              <Text className='item-card__group-more'>
                {groups
                  .slice(1)
                  .map((g) => g.name)
                  .join('、')}
                {`（${groups.length} 个群）`}
              </Text>
            ) : null}
          </View>
        ) : null}

        {asset ? (
          <View className='item-card__source'>
            <Icon
              name={item.source?.kind === 'file' ? 'file' : 'link'}
              className='item-card__source-icon'
              strokeWidth={1.7}
            />
            <Text className='item-card__source-text'>
              {item.source?.link_title || '来自群内内容'}
            </Text>
          </View>
        ) : null}
      </View>

      <Icon name='chevron' className='item-card__arrow' strokeWidth={2} />
    </View>
  )
}
