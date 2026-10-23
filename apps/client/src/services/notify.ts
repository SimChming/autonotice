/**
 * 跨端系统通知：Web Notification / Android LocalNotifications / Tauri 原生通知。
 * 三者都不可用时，界面内仍会显示 Toast，保证至少能看到提醒。
 */

type PlatformKind = "android" | "desktop" | "web";

interface CapacitorLocalNotifications {
  requestPermissions?: () => Promise<{ display?: string }>;
  schedule?: (options: { notifications: Array<Record<string, unknown>> }) => Promise<unknown>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: {
    LocalNotifications?: CapacitorLocalNotifications;
  };
}

interface TauriInternals {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

interface NotificationOptionsLike {
  body?: string;
  icon?: string;
  tag?: string;
  renotify?: boolean;
}

function capacitor(): CapacitorGlobal | null {
  if (typeof window === "undefined") {
    return null;
  }
  return (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor ?? null;
}

function tauri(): TauriInternals | null {
  if (typeof window === "undefined") {
    return null;
  }
  return (window as Window & { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ ?? null;
}

export function platformKind(): PlatformKind {
  const cap = capacitor();
  if (cap?.isNativePlatform?.()) {
    return cap.getPlatform?.() === "android" ? "android" : "android";
  }
  if (tauri()) {
    return "desktop";
  }
  return "web";
}

/** 浏览器只在安全上下文（HTTPS / localhost）允许系统通知。 */
export function webNotificationsSupported(): boolean {
  return typeof window !== "undefined" && typeof Notification !== "undefined" && window.isSecureContext;
}

export type NotificationPermissionState = "granted" | "denied" | "default" | "unsupported";

export function notificationPermissionState(): NotificationPermissionState {
  const kind = platformKind();
  if (kind === "desktop") {
    return "granted";
  }
  if (kind === "android") {
    return "default";
  }
  if (!webNotificationsSupported()) {
    return "unsupported";
  }
  if (Notification.permission === "granted") {
    return "granted";
  }
  if (Notification.permission === "denied") {
    return "denied";
  }
  return "default";
}

/** 申请通知权限；Web 端必须在用户点击等手势中调用。 */
export async function requestNotificationPermission(): Promise<boolean> {
  const kind = platformKind();
  if (kind === "android") {
    const plugin = capacitor()?.Plugins?.LocalNotifications;
    try {
      const result = await plugin?.requestPermissions?.();
      return result?.display === "granted";
    } catch {
      return false;
    }
  }
  if (kind === "desktop") {
    return true;
  }
  if (!webNotificationsSupported()) {
    return false;
  }
  if (Notification.permission === "granted") {
    return true;
  }
  if (Notification.permission === "denied") {
    return false;
  }
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // 桌面浏览器通常不支持震动，忽略即可。
  }
}

let audioContext: AudioContext | null = null;

/** 网页/桌面兜底铃声：两声短促提示音。 */
export function playBeep(times = 2): void {
  if (typeof window === "undefined") {
    return;
  }
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    return;
  }
  try {
    audioContext ??= new Ctor();
    void audioContext.resume();
    const start = audioContext.currentTime;
    for (let i = 0; i < times; i += 1) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = 880;
      oscillator.type = "sine";
      const begin = start + i * 0.35;
      gain.gain.setValueAtTime(0.001, begin);
      gain.gain.exponentialRampToValueAtTime(0.22, begin + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, begin + 0.24);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(begin);
      oscillator.stop(begin + 0.26);
    }
  } catch {
    // 浏览器未授权音频播放时静默失败。
  }
}

let notificationId = 0;

interface SystemNotificationInput {
  title: string;
  body: string;
  alarm?: boolean;
}

/** 发送系统级通知；失败时静默回退到界面内 Toast。 */
export async function sendSystemNotification({
  title,
  body,
  alarm = false,
}: SystemNotificationInput): Promise<void> {
  const kind = platformKind();

  if (kind === "android") {
    const plugin = capacitor()?.Plugins?.LocalNotifications;
    if (plugin?.schedule) {
      notificationId = (notificationId + 1) % 2_000_000_000;
      try {
        await plugin.requestPermissions?.();
        await plugin.schedule({
          notifications: [
            {
              id: notificationId,
              title,
              body,
              smallIcon: "ic_stat_icon",
              sound: alarm ? "beep.wav" : undefined,
              schedule: { at: new Date(Date.now() + 250), allowWhileIdle: true },
              extra: { alarm },
            },
          ],
        });
        if (alarm) {
          vibrate([300, 150, 300, 150, 500]);
        }
        return;
      } catch {
        // 插件失败时继续尝试 WebView 能力。
      }
    }
    vibrate(alarm ? [300, 150, 300, 150, 500] : [120]);
    if (alarm) {
      playBeep(2);
    }
    return;
  }

  if (kind === "desktop") {
    const internals = tauri();
    try {
      await internals?.invoke?.("send_now", { title, body });
      if (alarm) {
        vibrate([300, 150, 300]);
        playBeep(2);
      }
      return;
    } catch {
      // 继续尝试 Web Notification。
    }
  }

  if (webNotificationsSupported() && Notification.permission === "granted") {
    try {
      const options: NotificationOptionsLike = {
        body,
        icon: "/app-icon.png",
        tag: alarm ? "autonotice-alarm" : "autonotice-alert",
        renotify: alarm,
      };
      const notification = new Notification(title, options as NotificationOptions);
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch {
      // 某些浏览器禁止页面构造通知。
    }
  }

  vibrate(alarm ? [300, 150, 300, 150, 500] : [120]);
  if (alarm) {
    playBeep(2);
  }
}

/** 设置页「发送测试通知」用。 */
export async function sendTestNotification(): Promise<void> {
  await sendSystemNotification({
    title: "Autonotice 通知测试",
    body: "如果你看到这条系统通知，说明提醒链路正常。",
    alarm: true,
  });
}
