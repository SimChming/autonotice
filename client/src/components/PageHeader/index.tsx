import type { ReactNode } from 'react'
import { View, Text } from '@tarojs/components'
import Taro from '@tarojs/taro'

import { Icon } from '../Icon'
import './index.scss'

export interface PageHeaderProps {
  title: string
  subtitle?: string
  back?: boolean
  right?: ReactNode
}

/** 自定义导航栏（app.config 用 navigationStyle: custom） */
export function PageHeader({ title, subtitle, back, right }: PageHeaderProps) {
  return (
    <View className='page-header'>
      <View className='page-header__bar'>
        <View className='page-header__left'>
          {back ? (
            <View
              className='page-header__back pressable'
              onClick={() => {
                Taro.navigateBack().catch(() => Taro.redirectTo({ url: '/pages/schedule/index' }))
              }}
            >
              <Icon name='chevron' className='page-header__back-icon' strokeWidth={2.2} />
            </View>
          ) : null}
        </View>
        <View className='page-header__right'>{right}</View>
      </View>
      <View className='page-header__title-block'>
        <Text className='page-header__title'>{title}</Text>
        {subtitle ? <Text className='page-header__subtitle'>{subtitle}</Text> : null}
      </View>
    </View>
  )
}
