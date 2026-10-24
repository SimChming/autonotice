import { useCallback, useEffect, useState } from "react";
import { SERVICE_VERSION, type ReleaseResponse } from "@autonotice/shared";
import {
  applyUpdate,
  detectShell,
  fetchRelease,
  isOutdated,
  type ShellInfo,
} from "../services/update";

interface UpdateState {
  release: ReleaseResponse | null;
  shell: ShellInfo | null;
  outdated: boolean;
  currentVersion: string | null;
  loading: boolean;
  error: string | null;
}

/** 拉取服务端最新版本并与当前端版本比较。 */
export function useUpdateInfo(): UpdateState & { refresh: () => void } {
  const [release, setRelease] = useState<ReleaseResponse | null>(null);
  const [shell, setShell] = useState<ShellInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextRelease, nextShell] = await Promise.all([fetchRelease(), detectShell()]);
      setRelease(nextRelease);
      setShell(nextShell);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "检查更新失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 网页端版本即服务端版本；原生端以安装包版本为准。
  const currentVersion = shell ? (shell.platform === "web" ? SERVICE_VERSION : shell.shellVersion) : null;
  const outdated = Boolean(release && currentVersion && isOutdated(currentVersion, release.version));

  return { release, shell, outdated, currentVersion, loading, error, refresh: () => void load() };
}

/** 顶部更新横幅：安装包版本过低时提供一键更新入口。 */
export function UpdatePrompt() {
  const { release, shell, outdated, currentVersion } = useUpdateInfo();
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!release || !shell || !outdated || hidden) {
    return null;
  }

  const web = shell.platform === "web";

  const handleUpdate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await applyUpdate(release);
      setMessage(result.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="update-banner" role="status">
      <div className="update-banner__text">
        <strong>
          {web ? `发现新版本 v${release.version}` : `安装包版本过低（v${currentVersion ?? "?"}）`}
        </strong>
        <span>
          {web
            ? "刷新页面即可用上最新界面。"
            : `最新版本 v${release.version}，更新后即可使用新功能。`}
        </span>
        {message ? <span className="update-banner__hint">{message}</span> : null}
      </div>
      <div className="update-banner__actions">
        <button type="button" className="btn btn--primary btn--sm" onClick={() => void handleUpdate()} disabled={busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          {busy ? "处理中…" : web ? "立即刷新" : "立即更新"}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setHidden(true)}>
          稍后
        </button>
      </div>
    </div>
  );
}
