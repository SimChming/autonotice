import { useState } from 'react'
import { Image, Text, View } from '@tarojs/components'

import { Icon } from '../Icon'
import './index.scss'

export interface GroupChipProps {
  groupId: string
  name?: string
  size?: 'sm' | 'md'
}

/** 群头像地址（QQ 群图标，100 为尺寸档位） */
function avatarUrl(groupId: string): string {
  return `https://p.qlogo.cn/gh/${groupId}/${groupId}/100`
}

/** 紧凑的「群」标识：圆形群头像 + 群名（头像加载失败时退化为图标占位） */
export function GroupChip({ groupId, name, size = 'md' }: GroupChipProps) {
  const [failed, setFailed] = useState(false)
  const label = name && name.trim() ? name : `群 ${groupId}`

  return (
    <View className={`group-chip group-chip--${size}`}>
      {failed ? (
        <View className='group-chip__fallback'>
          <Icon name='groups' className='group-chip__fallback-icon' strokeWidth={1.8} />
        </View>
      ) : (
        <Image
          className='group-chip__avatar'
          src={avatarUrl(groupId)}
          mode='aspectFill'
          onError={() => setFailed(true)}
        />
      )}
      <Text className='group-chip__name'>{label}</Text>
    </View>
  )
}
