import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 壳配置（iOS / Android）。
 *
 * ── 使用说明（构建流程）────────────────────────────────────────────────────
 * 1) 先在客户端根目录构建 H5：
 *      cd client
 *      npm install
 *      npm run build:h5          # 产出 client/dist
 *
 * 2) 本目录已含 capacitor.config.ts，`npx cap` 会以「当前工作目录」为工程根，
 *    因此在 client/capacitor 下执行（package.json 已封装为 npm script）：
 *      cd client
 *      npm run cap:add:android   # 首次：npx cap add android
 *      npm run cap:add:ios       # 首次：npx cap add ios（需 macOS + Xcode）
 *      npm run cap:sync          # 每次前端有新构建后同步 web 资源
 *      npm run cap:open:android  # 用 Android Studio 打开
 *      npm run cap:open:ios      # 用 Xcode 打开
 *
 * 3) 关键点：Taro 使用 hash 路由 + 相对 publicPath（见 client/config/index.ts），
 *    webDir 会被 WebView 以 file:// 加载，hash 路由可避免深链 404。
 *
 * 4) Android 12+ 精确定时：在 android/app/src/main/AndroidManifest.xml 声明
 *      <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />
 *      <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
 *      <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
 *    （Capacitor 6 的 local-notifications 插件会自动合并部分权限，但 SCHEDULE_EXACT_ALARM
 *      与开机自启需要显式声明；用户未授权时客户端会降级并提示，见 src/pages/settings。）
 *
 * 5) iOS：本地通知不需要推送证书；每 App pending 上限 64 条，由滚动排程（≤60）保证不超。
 */
const config: CapacitorConfig = {
  appId: 'com.qqsa.schedule',
  appName: '日程助手',
  webDir: '../dist',
  // 服务端是自建 http:// 地址：把 WebView 的 origin 设为 http://localhost，
  // 避免 https 页面加载 http 接口被判定为混合内容而被拦。
  server: {
    androidScheme: 'http'
  },
  android: {
    allowMixedContent: true,
    // 允许 http(s) 请求服务端（自建服务器可能使用 http）
    webContentsDebuggingEnabled: false
  },
  ios: {
    contentInset: 'always',
    limitsNavigationsToAppBoundDomains: false
  },
  plugins: {
    LocalNotifications: {
      // 通知渠道图标（Android）：放在 android/app/src/main/res/drawable/ic_stat_icon.png
      smallIcon: 'ic_stat_icon',
      iconColor: '#0a84ff',
      sound: 'beep.wav'
    }
  }
}

export default config
