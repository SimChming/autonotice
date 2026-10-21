import { ScrollView, Text, View } from '@tarojs/components'

import { fmtDateTime } from '../../utils/date'
import type { ReplanStatus } from '../../store/replan'
import { Icon } from '../Icon'
import './index.scss'

export interface ReasoningPanelProps {
  status: ReplanStatus
  /** 服务端推送的阶段文案 */
  phase: string
  /** DeepSeek 思考链累计文本 */
  reasoning: string
  /** reasoner 正文结论累计文本 */
  answer: string
  expanded: boolean
  error: string
  newItems: number
  savedAt: string | null
  onToggle: () => void
}

function subtitleOf(status: ReplanStatus, phase: string, newItems: number, savedAt: string | null): string {
  if (status === 'running') return phase || '正在运行…'
  if (status === 'error') return phase || '排程失败'
  if (newItems > 0) return `本次新增 ${newItems} 项`
  if (savedAt) return `保存于 ${fmtDateTime(savedAt)}`
  return phase || '已完成'
}

/** 一键排程的思考链面板：默认折叠，运行中逐步增长 */
export function ReasoningPanel({
  status,
  phase,
  reasoning,
  answer,
  expanded,
  error,
  newItems,
  savedAt,
  onToggle
}: ReasoningPanelProps) {
  if (status === 'idle' && !reasoning && !answer) return null

  const running = status === 'running'

  return (
    <View className={`reasoning-panel card${expanded ? ' is-open' : ''} is-${status}`}>
      <View className='reasoning-panel__head pressable' onClick={onToggle}>
        <View className='reasoning-panel__dot' />
        <View className='reasoning-panel__meta'>
          <Text className='reasoning-panel__title'>AI 思考链</Text>
          <Text className='reasoning-panel__sub'>
            {subtitleOf(status, phase, newItems, savedAt)}
          </Text>
        </View>
        <Icon name='chevron' className='reasoning-panel__arrow' strokeWidth={2} />
      </View>

      {error ? <Text className='reasoning-panel__error'>{error}</Text> : null}

      {expanded ? (
        <ScrollView
          scrollY
          className='reasoning-panel__scroll'
          scrollTop={running ? 100000 : 0}
          scrollWithAnimation
        >
          {reasoning ? (
            <View className='reasoning-panel__block'>
              <Text className='reasoning-panel__label'>思考链</Text>
              <Text className='reasoning-panel__text'>{reasoning}</Text>
            </View>
          ) : null}

          {answer ? (
            <View className='reasoning-panel__block'>
              <Text className='reasoning-panel__label'>结论</Text>
              <Text className='reasoning-panel__text'>{answer}</Text>
            </View>
          ) : null}

          {running && !reasoning ? (
            <Text className='reasoning-panel__hint'>正在等待模型输出…</Text>
          ) : null}
        </ScrollView>
      ) : null}
    </View>
  )
}
