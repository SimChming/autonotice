import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Android 壳配置（Capacitor 6）。
 * 通过 `server.url` 直接加载服务端最新界面：服务端部署后 App 无需重新编译即可更新。
 * WebView 的 origin 设为 http，避免 https 页面加载 http 接口触发混合内容拦截。
 */
const config: CapacitorConfig = {
  appId: "com.qqsa.schedule",
  appName: "Autonotice 3.2.1",
  webDir: "../client/dist",
  server: {
    url: "http://120.26.224.86:8080",
    androidScheme: "http",
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    LocalNotifications: {
      smallIcon: "ic_stat_icon",
      iconColor: "#0a84ff",
      sound: "beep.wav",
    },
  },
};

export default config;
