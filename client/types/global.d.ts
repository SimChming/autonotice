/// <reference types="@tarojs/taro" />

declare module '*.scss'
declare module '*.css'
declare module '*.png'
declare module '*.gif'
declare module '*.jpg'
declare module '*.jpeg'
declare module '*.svg'

declare namespace NodeJS {
  interface ProcessEnv {
    /** 当前构建端：h5 / weapp / ... */
    TARO_ENV: 'weapp' | 'swan' | 'alipay' | 'h5' | 'rn' | 'tt' | 'quickapp' | 'qq' | 'jd'
    /** 服务端 REST 基地址（含 /api/v1），构建时注入 */
    TARO_APP_API_BASE?: string
    NODE_ENV: 'development' | 'production'
  }
}

/** 壳内注入的平台标记（Tauri / Capacitor 运行时会在 window 上挂载） */
interface Window {
  __TAURI__?: unknown
  __TAURI_INTERNALS__?: unknown
  Capacitor?: {
    isNativePlatform?: () => boolean
    getPlatform?: () => string
    platform?: string
  }
}
