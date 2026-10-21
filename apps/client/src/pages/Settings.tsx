import { Link, useNavigate } from "react-router-dom";
import { SERVICE_VERSION } from "@autonotice/shared";
import { useAuthStore } from "../stores/auth";
import { formatDateTime } from "../utils/date";
import { ArrowRightIcon, LogoutIcon } from "../components/Icons";

export function SettingsPage() {
  const user = useAuthStore((state) => state.user);
  const bound = useAuthStore((state) => state.bound);
  const logout = useAuthStore((state) => state.logout);
  const navigate = useNavigate();

  const initial = user?.username.slice(0, 1).toUpperCase() ?? "?";

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
          <span className="avatar avatar--large">{initial}</span>
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
        <p className="panel-note">绑定状态保存在本机；更换设备后需要重新完成一次绑定确认。</p>
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

      <p className="version">AUTONOTICE v{SERVICE_VERSION}</p>
    </>
  );
}
