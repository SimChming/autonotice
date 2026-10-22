import { useCallback, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { LogoutIcon, WhaleMark } from "../components/Icons";
import { ToastHost, type ToastMessage } from "../components/Toast";

export type AdminNotify = (title: string, description?: string, tone?: "info" | "warn") => void;

export interface AdminOutletContext {
  notify: AdminNotify;
}

interface AdminNavItem {
  to: string;
  label: string;
  end?: boolean;
}

const NAV_ITEMS: AdminNavItem[] = [
  { to: "/admin", label: "概览", end: true },
  { to: "/admin/skills", label: "技能" },
  { to: "/admin/models", label: "模型" },
  { to: "/admin/users", label: "用户" },
  { to: "/admin/chat", label: "聊天" },
];

function AdminBrand() {
  return (
    <div className="admin-brand">
      <span className="brand__mark admin-brand__mark">
        <WhaleMark />
      </span>
      <span className="admin-brand__text">
        <strong>Autonotice</strong>
        <small>管理控制台</small>
      </span>
    </div>
  );
}

export function AdminLayout({ onLogout }: { onLogout: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastSequence = useRef(0);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback<AdminNotify>((title, description, tone = "info") => {
    toastSequence.current += 1;
    const next: ToastMessage = { id: toastSequence.current, title, description, tone };
    setToasts((current) => [...current, next].slice(-3));
  }, []);

  const activeItem =
    NAV_ITEMS.find((item) =>
      item.end ? location.pathname === item.to : location.pathname.startsWith(item.to),
    ) ?? NAV_ITEMS[0];

  const activePath = activeItem?.to ?? "/admin";

  const handleLogout = () => {
    if (!window.confirm("退出管理员登录？")) {
      return;
    }
    onLogout();
  };

  const renderTabs = (className: string) =>
    NAV_ITEMS.map((item) => (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.end}
        className={({ isActive }) => `${className}${isActive ? " is-active" : ""}`}
      >
        {item.label}
      </NavLink>
    ));

  return (
    <div className="admin-shell">
      <div className="ambient" aria-hidden="true" />

      <aside className="admin-sidebar">
        <AdminBrand />
        <nav className="admin-nav" aria-label="管理后台导航">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `admin-nav__link${isActive ? " is-active" : ""}`}
            >
              <span className="admin-nav__dot" aria-hidden="true" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="admin-sidebar__foot">
          <button type="button" className="btn btn--ghost btn--sm btn--block" onClick={handleLogout}>
            <LogoutIcon />
            退出管理员
          </button>
          <p className="admin-sidebar__hint">独立管理员会话 · 12 小时有效</p>
        </div>
      </aside>

      <div className="admin-main">
        <header className="admin-topbar">
          <div className="admin-topbar__brand">
            <span className="brand__mark admin-brand__mark">
              <WhaleMark />
            </span>
            <strong>Autonotice 管理</strong>
          </div>

          <nav className="admin-tabs" aria-label="管理后台导航">
            {renderTabs("admin-tab")}
          </nav>

          <label className="admin-select">
            <span className="admin-select__label">模块</span>
            <select
              value={activePath}
              aria-label="选择管理模块"
              onChange={(event) => navigate(event.target.value)}
            >
              {NAV_ITEMS.map((item) => (
                <option key={item.to} value={item.to}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="icon-btn admin-topbar__logout"
            onClick={handleLogout}
            aria-label="退出管理员登录"
            title="退出管理员登录"
          >
            <LogoutIcon />
          </button>
        </header>

        <main className="admin-content">
          <div className="admin-content__inner">
            <Outlet context={{ notify } satisfies AdminOutletContext} />
          </div>
        </main>
      </div>

      <ToastHost messages={toasts} onDismiss={dismissToast} />
    </div>
  );
}
