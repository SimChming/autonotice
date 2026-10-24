import { releaseResponseSchema, SERVICE_VERSION, type ReleaseResponse } from "@autonotice/shared";
import { API_BASE } from "./api";
import { platformKind } from "./notify";

/** 原生壳（APK/EXE）自身的版本；网页端没有壳，返回 null。 */
export interface ShellInfo {
  platform: "web" | "desktop" | "android";
  shellVersion: string | null;
}

interface CapacitorApp {
  getInfo?: () => Promise<{ version?: string; build?: string }>;
}

interface TauriInternals {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

let shellCache: ShellInfo | null = null;
let shellPromise: Promise<ShellInfo> | null = null;

function tauri(): TauriInternals | null {
  if (typeof window === "undefined") {
    return null;
  }
  return (window as Window & { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ ?? null;
}

function capacitorApp(): CapacitorApp | null {
  if (typeof window === "undefined") {
    return null;
  }
  const cap = (window as Window & {
    Capacitor?: { Plugins?: { App?: CapacitorApp } };
  }).Capacitor;
  return cap?.Plugins?.App ?? null;
}

async function readShellInfo(): Promise<ShellInfo> {
  const platform = platformKind();
  if (platform === "android") {
    try {
      const info = await capacitorApp()?.getInfo?.();
      return { platform, shellVersion: info?.version ?? null };
    } catch {
      return { platform, shellVersion: null };
    }
  }
  if (platform === "desktop") {
    try {
      const version = await tauri()?.invoke?.("app_version");
      return { platform, shellVersion: typeof version === "string" ? version : null };
    } catch {
      return { platform, shellVersion: null };
    }
  }
  return { platform: "web", shellVersion: null };
}

export function detectShell(): Promise<ShellInfo> {
  if (shellCache) {
    return Promise.resolve(shellCache);
  }
  shellPromise ??= readShellInfo().then((info) => {
    shellCache = info;
    return info;
  });
  return shellPromise;
}

/** 把服务端返回的相对下载地址补全为可直接访问的绝对地址。 */
export function resolveDownloadUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  if (/^https?:\/\//i.test(API_BASE)) {
    return `${new URL(API_BASE).origin}${path}`;
  }
  return new URL(path, window.location.origin).toString();
}

export async function fetchRelease(): Promise<ReleaseResponse> {
  const response = await fetch(`${API_BASE}/release`, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`获取更新信息失败（HTTP ${response.status}）`);
  }
  return releaseResponseSchema.parse(await response.json());
}

/** 语义化比较：a < b 返回 -1，相等 0，a > b 返回 1。 */
export function compareVersion(a: string, b: string): number {
  const left = a.split(/[.+-]/).map((part) => Number(part) || 0);
  const right = b.split(/[.+-]/).map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff < 0 ? -1 : 1;
    }
  }
  return 0;
}

export function isOutdated(shellVersion: string | null, latest: string): boolean {
  if (!shellVersion) {
    return false;
  }
  return compareVersion(shellVersion, latest) < 0;
}

export function downloadForPlatform(release: ReleaseResponse, platform: ShellInfo["platform"]): string | null {
  if (platform === "android") {
    return release.downloads.android;
  }
  if (platform === "desktop") {
    return release.downloads.windowsExe;
  }
  return null;
}

export interface UpdateResult {
  started: boolean;
  message: string;
}

/** 执行更新：网页刷新、Android 下载并调起安装、Windows 打开安装包下载页。 */
export async function applyUpdate(release: ReleaseResponse): Promise<UpdateResult> {
  const shell = await detectShell();
  if (shell.platform === "web") {
    window.location.reload();
    return { started: true, message: "正在刷新到最新版本…" };
  }

  const path = downloadForPlatform(release, shell.platform);
  if (!path) {
    return { started: false, message: "当前版本暂未提供安装包，请稍后再试。" };
  }
  const url = resolveDownloadUrl(path);

  if (shell.platform === "android") {
    const updater = (
      window as Window & {
        Capacitor?: { Plugins?: { AppUpdater?: { downloadAndInstall?: (options: { url: string }) => Promise<unknown> } } };
      }
    ).Capacitor?.Plugins?.AppUpdater;
    if (updater?.downloadAndInstall) {
      try {
        await updater.downloadAndInstall({ url });
        return { started: true, message: "已开始下载并准备安装，请按系统提示允许安装。" };
      } catch {
        // 插件失败时退回系统浏览器下载。
      }
    }
    window.open(url, "_system");
    return { started: true, message: "已打开下载页面，请安装下载完成的 APK。" };
  }

  try {
    await tauri()?.invoke?.("open_url", { url });
    return { started: true, message: "已在浏览器打开安装包下载页。" };
  } catch {
    window.open(url, "_blank");
    return { started: true, message: "已打开安装包下载页。" };
  }
}

/** 客户端连上 WS 后上报平台与版本，后台据此展示多端在线状态。 */
export async function sendPresenceHello(socket: WebSocket): Promise<void> {
  const shell = await detectShell();
  if (socket.readyState !== 1) {
    return;
  }
  socket.send(
    JSON.stringify({
      type: "hello",
      platform: shell.platform,
      version: SERVICE_VERSION,
      shellVersion: shell.shellVersion,
    }),
  );
}
