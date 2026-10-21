import { View, Text } from '@tarojs/components'

import type { FetchStatus, SourceGroupInfo, SourceInfo } from '../../types'
import { copyText } from '../../utils/storage'
import { GroupChip } from '../GroupChip'
import { Icon } from '../Icon'
import './index.scss'

const STATUS_META: Record<string, { label: string; className: string }> = {
  ok: { label: '已抓取正文', className: 'is-ok' },
  pending: { label: '抓取中', className: 'is-pending' },
  blocked: { label: '被屏蔽 · 需人工查看', className: 'is-blocked' },
  unfetchable: { label: '无法抓取 · 需人工查看', className: 'is-blocked' },
  failed: { label: '抓取失败 · 需人工查看', className: 'is-blocked' },
  too_large: { label: '文件过大 · 未解析', className: 'is-muted' }
}

const KIND_LABEL: Record<string, string> = {
  file: '群文件',
  link: '网页链接',
  miniapp: '小程序',
  wechat_article: '微信文章'
}

export interface SourceGroupEntry {
  group_id: string
  name: string
}

/**
 * 汇总该条日程的全部来源群（多群重复发布时会列出多个）。
 * source.groups（每项可能带 group_name）与主群 source.group_id/group_name 合并去重。
 */
export function sourceGroupLabel(source?: SourceInfo | null): SourceGroupEntry[] {
  if (!source) return []
  const merged: SourceGroupInfo[] = []
  const seen = new Set<string>()
  if (source.group_id) {
    merged.push({ group_id: source.group_id, group_name: source.group_name })
    seen.add(source.group_id)
  }
  for (const g of source.groups || []) {
    if (!g?.group_id || seen.has(g.group_id)) continue
    seen.add(g.group_id)
    merged.push(g)
  }
  return merged.map((g) => ({
    group_id: g.group_id,
    name: g.group_name && g.group_name.trim() ? g.group_name : `群 ${g.group_id}`
  }))
}

export interface SourceCardProps {
  source?: SourceInfo | null
}

/** 详情页来源卡片：来源群 + 文件名/链接标题 + 抓取状态 + 摘要 + 复制入口 */
export function SourceCard({ source }: SourceCardProps) {
  if (!source) return null

  const status: FetchStatus | undefined = source.fetch_status
  const meta = (status && STATUS_META[status]) || STATUS_META.pending
  const kindLabel = KIND_LABEL[source.kind] || '群内内容'
  const title = source.link_title || '（无标题）'
  const copyTarget = source.link_title || source.excerpt
  const groupLabels = sourceGroupLabel(source)

  return (
    <View className='source-card card'>
      <View className='source-card__head'>
        <Icon
          name={source.kind === 'file' ? 'file' : 'link'}
          className='source-card__icon'
          strokeWidth={1.8}
        />
        <Text className='source-card__kind'>来源 · {kindLabel}</Text>
        <Text className={`source-card__status ${meta.className}`}>{meta.label}</Text>
      </View>

      {groupLabels.length ? (
        <View className='source-card__groups'>
          <Text className='source-card__groups-label'>来源群</Text>
          <View className='source-card__groups-list'>
            {groupLabels.map((g) => (
              <GroupChip key={g.group_id} groupId={g.group_id} name={g.name} size='sm' />
            ))}
          </View>
        </View>
      ) : null}

      <Text className='source-card__title'>{title}</Text>

      {source.excerpt ? (
        <View className='source-card__excerpt'>
          <Text className='source-card__excerpt-text'>{source.excerpt}</Text>
        </View>
      ) : null}

      <View className='source-card__actions'>
        <View className='source-card__btn pressable' onClick={() => copyTarget && copyText(copyTarget)}>
          <Icon name='copy' className='source-card__btn-icon' strokeWidth={1.8} />
          <Text className='source-card__btn-text'>复制标题 / 摘要</Text>
        </View>
        {source.message_ids?.length ? (
          <Text className='source-card__hint'>
            来自 {groupLabels.length ? groupLabels.map((g) => g.name).join('、') : `群 ${source.group_id}`}{' '}
            · {source.message_ids.length} 条消息
          </Text>
        ) : null}
      </View>

      {status === 'blocked' || status === 'unfetchable' || status === 'failed' ? (
        <Text className='source-card__notice'>
          该内容服务端无法完整读取，建议回到 QQ 群按标题查找原文件/链接自行查看。
        </Text>
      ) : null}
    </View>
  )
}
