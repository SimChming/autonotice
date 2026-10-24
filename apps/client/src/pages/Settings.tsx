import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { SERVICE_VERSION } from "@autonotice/shared";
import { useAuthStore } from "../stores/auth";
import { formatDateTime } from "../utils/date";
import { ArrowRightIcon, LogoutIcon } from "../components/Icons";
import { UserAvatar } from "../components/UserAvatar";
import {
  notificationPermissionState,
  platformKind,
  requestNotificationPermission,
  sendTestNotification,
  webNotificationsSupported,
  type NotificationPermissionState,
} from "../services/notify";
import { getAdminToken } from "../admin/api";
import { applyUpdate } from "../services/update";
import { useUpdateInfo } from "../components/UpdatePrompt";

export function SettingsPage() {
  const user = useAuthStore((state) => state.user);
  const bound = useAuthStore((state) => state.bound);
  const logout = useAuthStore((state) => state.logout);
  const navigate = useNavigate();
  const location = useLocation();

  // 后台入口只在显式带 ?admin=1 或本机已有管理员 token 时出现，普通用户看不到。
  const showAdminEntry =
    new URLSearchParams(location.search).get("admin") === "1" || Boolean(getAdminToken());

  const [permission, setPermission] = useState<NotificationPermissionState>(() =>
    notificationPermissionState(),
  );
  const [testing, setTesting] = useState(false);
  const update = useUpdateInfo();
  const [updating, setUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);

  useEffect(() => {
    if (platformKind() === "web") {
      setPermission(notificationPermissionState());
      return;
    }
    // 原生端权限是异步查询的：读取当前真实状态，已授权则直接显示「已开启」。
    let cancelled = false;
    void requestNotificationPermission().then((granted) => {
      if (!cancelled) {
        setPermission(granted ? "granted" : "denied");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const permissionLabel =
    permission === "granted"
      ? "已开启：系统弹窗、震动与铃声均可工作"
      : permission === "denied"
        ? "已被拒绝，请到系统/浏览器设置里允许 Autonotice 通知"
        : permission === "unsupported"
          ? "当前环境不支持系统通知"
          : "尚未授权";

  const enableNotifications = async () => {
    const granted = await requestNotificationPermission();
    setPermission(granted ? "granted" : notificationPermissionState());
  };

  const testNotification = async () => {
    setTesting(true);
    try {
      await sendTestNotification();
    } finally {
      setTesting(false);
    }
  };

  const runUpdate = async () => {
    if (!update.release) {
      update.refresh();
      return;
    }
    setUpdating(true);
    setUpdateMessage(null);
    try {
      const result = await applyUpdate(update.release);
      setUpdateMessage(result.message);
    } finally {
      setUpdating(false);
    }
  };

  const handleLogout = () => {
    if (!window.confirm("确认退出登录？")) {
      return;
    }
    logout();
    navigate("/login", { replace: true });
  };

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">ACCOUNT</p>
          <h1>设置</h1>
          <p className="page-subtitle">管理账号、QQ 绑定与当前设备的登录状态。</p>
        </div>
      </header>

      <section className="panel" aria-labelledby="settings-account">
        <h2 id="settings-account">账号</h2>
        <div className="account-row">
          <UserAvatar qq={bound?.qq} name={user?.username} large />
          <div>
            <strong>{user?.username ?? "未知用户"}</strong>
            <span>{user ? `用户 ID #${user.id}` : "正在读取账号信息"}</span>
          </div>
        </div>
      </section>

      <section className="panel" aria-labelledby="settings-bind">
        <h2 id="settings-bind">QQ 绑定</h2>
        {bound ? (
          <div className="bind-state">
            <div className="bind-state__main">
              <span className="status-dot" aria-hidden="true" />
              <div>
                <strong>已绑定 QQ {bound.qq}</strong>
                <span>确认于 {formatDateTime(bound.verifiedAt)}</span>
              </div>
            </div>
            <Link className="btn btn--ghost btn--sm" to="/bind">
              重新绑定
              <ArrowRightIcon />
            </Link>
          </div>
        ) : (
          <div className="bind-state bind-state--empty">
            <div className="bind-state__main">
              <span className="status-dot status-dot--idle" aria-hidden="true" />
              <div>
                <strong>尚未绑定 QQ</strong>
                <span>绑定后机器人才能识别你在群里发的消息。</span>
              </div>
            </div>
            <Link className="btn btn--primary btn--sm" to="/bind">
              去绑定
              <ArrowRightIcon />
            </Link>
          </div>
        )}
        <p className="panel-note">绑定关系保存在服务器；换设备登录同一账号会自动同步。</p>
      </section>

      <section className="panel" aria-labelledby="settings-notify">
        <h2 id="settings-notify">系统通知</h2>
        <div className="setting-row">
          <div>
            <strong>通知、震动与铃声</strong>
            <span>{permissionLabel}</span>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void enableNotifications()}
            disabled={permission === "granted" || permission === "unsupported"}
          >
            {permission === "granted" ? "已开启" : "开启通知权限"}
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>测试系统通知</strong>
            <span>发送一条带铃声与震动的测试提醒，确认系统链路。</span>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void testNotification()}
            disabled={testing}
          >
            {testing ? <span className="spinner" aria-hidden="true" /> : null}
            {testing ? "发送中…" : "发送测试"}
          </button>
        </div>
        {!webNotificationsSupported() && permission === "unsupported" ? (
          <p className="panel-note">
            浏览器要求 HTTPS（或 localhost）才允许系统通知；当前 HTTP 环境下会保留应用内提醒与提示音。
          </p>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="settings-update">
        <h2 id="settings-update">版本与更新</h2>
        <div className="setting-row">
          <div>
            <strong>界面版本 v{SERVICE_VERSION}</strong>
            <span>
              {update.loading
                ? "正在检查最新版本…"
                : update.shell?.platform === "web"
                  ? update.outdated
                    ? `服务端已更新到 v${update.release?.version}，刷新即可生效。`
                    : "网页端随服务端自动更新，始终为最新版本。"
                  : update.shell?.shellVersion
                    ? update.outdated
                      ? `安装包版本 v${update.shell.shellVersion}，可更新到 v${update.release?.version}。`
                      : `安装包版本 v${update.shell.shellVersion}，已是最新。`
                    : "正在读取安装包版本…"}
            </span>
            {updateMessage ? <span className="update-banner__hint">{updateMessage}</span> : null}
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void runUpdate()}
            disabled={updating || update.loading}
          >
            {updating ? <span className="spinner" aria-hidden="true" /> : null}
            {updating ? "处理中…" : update.outdated ? "立即更新" : "检查更新"}
          </button>
        </div>
        {update.error ? <p className="panel-note">{update.error}</p> : null}
        {update.shell?.platform === "android" ? (
          <p className="panel-note">
            更新会先申请安装权限，然后下载 APK 并调起系统安装；若系统拦截，请允许「安装未知应用」。
          </p>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="settings-session">
        <h2 id="settings-session">会话</h2>
        <div className="setting-row">
          <div>
            <strong>当前设备已登录</strong>
            <span>登录令牌仅保存在本机浏览器。</span>
          </div>
          <button type="button" className="btn btn--danger" onClick={handleLogout}>
            <LogoutIcon />
            退出登录
          </button>
        </div>
      </section>

      {showAdminEntry ? (
        <section className="panel" aria-labelledby="settings-admin">
          <h2 id="settings-admin">管理后台</h2>
          <div className="setting-row">
            <div>
              <strong>管理员控制台</strong>
              <span>使用独立管理员账号登录，管理技能、模型与用户。</span>
            </div>
            <Link className="btn btn--ghost btn--sm" to="/admin">
              进入后台
              <ArrowRightIcon />
            </Link>
          </div>
        </section>
      ) : null}

      <p className="version">AUTONOTICE v{SERVICE_VERSION}</p>
    </>
  );
}
