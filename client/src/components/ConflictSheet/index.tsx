import { View, Text } from '@tarojs/components'

import type { ConflictStrategy } from '../../services/sync'
import type { ConflictRecord } from '../../store/schedule'
import { fmtDateTime } from '../../utils/date'
import './index.scss'

export interface ConflictSheetProps {
  record: ConflictRecord | null
  onChoose: (strategy: ConflictStrategy) => void
  onClose: () => void
}

/** 409 冲突处理：保留我的 / 用服务端 / 手动合并 */
export function ConflictSheet({ record, onChoose, onClose }: ConflictSheetProps) {
  if (!record) return null
  const { local, server } = record

  return (
    <View className='conflict'>
      <View className='conflict__mask' onClick={onClose} />
      <View className='conflict__sheet'>
        <View className='conflict__handle' />
        <Text className='conflict__title'>这条日程在其它设备上被改过</Text>
        <Text className='conflict__subtitle'>
          服务端版本 {server.revision} · 我的修改已暂存本地，请选择如何合并
        </Text>

        <View className='conflict__compare'>
          <View className='conflict__col'>
            <Text className='conflict__col-title'>我的版本</Text>
            <Text className='conflict__col-line'>{local.title || '未命名'}</Text>
            <Text className='conflict__col-line'>状态：{local.status === 'done' ? '已完成' : '待办'}</Text>
            <Text className='conflict__col-line'>截止：{fmtDateTime(local.due_at)}</Text>
            {local.notes ? <Text className='conflict__col-line'>备注：{local.notes}</Text> : null}
          </View>
          <View className='conflict__col'>
            <Text className='conflict__col-title'>服务端版本</Text>
            <Text className='conflict__col-line'>{server.title || '未命名'}</Text>
            <Text className='conflict__col-line'>状态：{server.status === 'done' ? '已完成' : '待办'}</Text>
            <Text className='conflict__col-line'>截止：{fmtDateTime(server.due_at)}</Text>
            {server.notes ? <Text className='conflict__col-line'>备注：{server.notes}</Text> : null}
          </View>
        </View>

        <View className='conflict__actions'>
          <View className='conflict__btn is-primary pressable' onClick={() => onChoose('mine')}>
            <Text className='conflict__btn-text is-primary'>保留我的</Text>
          </View>
          <View className='conflict__btn pressable' onClick={() => onChoose('merge')}>
            <Text className='conflict__btn-text'>手动合并</Text>
          </View>
          <View className='conflict__btn pressable' onClick={() => onChoose('server')}>
            <Text className='conflict__btn-text'>用服务端</Text>
          </View>
        </View>

        <Text className='conflict__cancel' onClick={onClose}>
          稍后处理
        </Text>
      </View>
    </View>
  )
}
