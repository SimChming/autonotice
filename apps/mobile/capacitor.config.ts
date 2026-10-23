import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Android 壳配置（Capacitor 6）。
 * 构建顺序：根目录构建 client（原生壳需带 VITE_API_BASE）→ pnpm --filter @autonotice/mobile sync:android → gradlew assembleDebug。
 * WebView 的 origin 设为 http://localhost，避免 https 页面加载 http 接口触发混合内容拦截。
 */
const config: CapacitorConfig = {
  appId: "com.qqsa.schedule",
  appName: "Autonotice 2.3.11",
  webDir: "../client/dist",
  server: {
    androidScheme: "http",
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
