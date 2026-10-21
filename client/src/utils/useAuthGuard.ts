import { useEffect } from 'react'
import Taro from '@tarojs/taro'

import { useAuthStore } from '../store/auth'

/** 未登录直接踢回登录页 */
export function useAuthGuard(): boolean {
  const token = useAuthStore((s) => s.token)

  useEffect(() => {
    if (!token) {
      Taro.reLaunch({ url: '/pages/login/index' }).catch(() => undefined)
    }
  }, [token])

  return Boolean(token)
}
