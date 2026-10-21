import { View, Text } from '@tarojs/components'

import './index.scss'

export interface EmptyProps {
  title: string
  hint?: string
}

export function Empty({ title, hint }: EmptyProps) {
  return (
    <View className='empty'>
      <View className='empty__ring' />
      <Text className='empty__title'>{title}</Text>
      {hint ? <Text className='empty__hint'>{hint}</Text> : null}
    </View>
  )
}
