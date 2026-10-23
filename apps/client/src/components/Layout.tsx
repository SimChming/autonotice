import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { SERVICE_VERSION } from "@autonotice/shared";
import { useAuthStore } from "../stores/auth";
import { useScheduleStore } from "../stores/schedule";
import { buildAlertSocketUrl, UNAUTHORIZED_EVENT } from "../services/api";
import {
  platformKind,
  requestNotificationPermission,
  sendSystemNotification,
} from "../services/notify";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { BellIcon, BrandIcon, CalendarIcon, GroupsIcon, LinkIcon, ShieldIcon, UserIcon } from "./Icons";
import { TabBar, type NavItem } from "./TabBar";
import { ToastHost, type ToastMessage } from "./Toast";
import { UserAvatar } from "./UserAvatar";
import { ADMIN_TOKEN_KEY, ADMIN_UNAUTHORIZED_EVENT, getAdminToken } from "../admin/api";

const NAV_ITEMS: NavItem[] = [
  { to: "/schedule", label: "日程", icon: <CalendarIcon /> },
  { to: "/alerts", label: "提醒", icon: <BellIcon /> },
  { to: "/groups", label: "群聊", icon: <GroupsIcon /> },
  { to: "/bind", label: "绑定", icon: <LinkIcon /> },
  { to: "/settings", label: "我的", icon: <UserIcon /> },
];

const ADMIN_NAV_ITEM: NavItem = { to: "/admin", label: "管理", icon: <ShieldIcon /> };

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand${compact ? " brand--compact" : ""}`}>
      <span className="brand__mark">
        <BrandIcon />
      </span>
      <span className="brand__text">
        <strong>Autonotice {SERVICE_VERSION}</strong>
        <small>群消息 · 日程 · 提醒</small>
      </span>
    </div>
  );
}

interface AlertPush {
  type: "alert";
  id: number;
  scheduleId: number | null;
  level: string;
  title: string;
  body: string;
  at: string;
}

function isAlertPush(value: unknown): value is AlertPush {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === "alert" &&
    typeof record.id === "number" &&
    typeof record.title === "string" &&
    typeof record.body === "string"
  );
}

interface AlarmPush {
  type: "alarm";
  title: string;
  body: string;
  mode?: string;
}

function isAlarmPush(value: unknown): value is AlarmPush {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === "alarm" && typeof record.title === "string" && typeof record.body === "string"
  );
}

export function Layout() {
  const token = useAuthStore((state) => state.token);
  const user = useAuthStore((state) => state.user);
  const bound = useAuthStore((state) => state.bound);
  const mode = useLayoutMode();
  const navigate = useNavigate();
  const location = useLocation();
  const [adminToken, setAdminToken] = useState<string | null>(() => getAdminToken());

  // 管理员登录后（且仅此时）在用户端显示「管理」入口，覆盖 Web / 桌面 / 手机。
  useEffect(() => {
    const sync = () => setAdminToken(getAdminToken());
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === ADMIN_TOKEN_KEY) {
        sync();
      }
    };
    window.addEventListener(ADMIN_UNAUTHORIZED_EVENT, sync);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(ADMIN_UNAUTHORIZED_EVENT, sync);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const navItems = adminToken ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastSequence = useRef(0);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((message: Omit<ToastMessage, "id">) => {
    toastSequence.current += 1;
    const next = { ...message, id: toastSequence.current };
    setToasts((current) => [...current, next].slice(-3));
  }, []);

  const openAlerts = useCallback(
    (message: ToastMessage) => {
      dismissToast(message.id);
      navigate("/alerts");
    },
    [dismissToast, navigate],
  );

  // 移动端切换 Tab 时回到页面顶部。
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  // 原生端（Android/桌面）启动时申请系统通知权限；Web 需用户手势，交给设置页按钮。
  useEffect(() => {
    if (platformKind() !== "web") {
      void requestNotificationPermission();
    }
  }, []);

  useEffect(() => {
    if (!token) {
      return;
    }

    let stopped = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let attempts = 0;

    const connect = () => {
      if (stopped) {
        return;
      }
      socket = new WebSocket(buildAlertSocketUrl(token));

      socket.addEventListener("open", () => {
        attempts = 0;
      });

      socket.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data !== "string") {
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (isAlarmPush(payload)) {
          const body = payload.body || "闹铃时间到了，快起来看看！";
          pushToast({
            title: `闹铃 · ${payload.title}`,
            description: body,
            tone: "warn",
          });
          void sendSystemNotification({ title: payload.title, body, alarm: true });
          return;
        }
        if (!isAlertPush(payload)) {
          return;
        }
        const description = payload.body || "日程时间快到了，打开提醒列表查看详情。";
        pushToast({
          title: `提醒 · ${payload.title}`,
          description,
          tone: "warn",
        });
        void sendSystemNotification({
          title: `提醒 · ${payload.title}`,
          body: description,
          alarm: payload.level === "urgent",
        });
        void useScheduleStore.getState().fetchAlerts();
      });

      socket.addEventListener("close", (event: CloseEvent) => {
        if (stopped) {
          return;
        }
        if (event.code === 1008) {
          window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
          return;
        }
        attempts += 1;
        const delay = Math.min(1000 * 2 ** Math.min(attempts, 4), 15_000);
        retryTimer = window.setTimeout(connect, delay);
      });

      socket.addEventListener("error", () => {
        socket?.close();
      });
    };

    connect();

    return () => {
      stopped = true;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
      socket?.close();
    };
  }, [token, pushToast]);

  return (
    <div className={`app app--${mode}`}>
      <div className="ambient" aria-hidden="true" />

      {mode === "sidebar" ? (
        <aside className="sidebar">
          <Brand />
          <nav className="sidebar__nav" aria-label="主导航">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `sidebar__link${isActive ? " is-active" : ""}`}
              >
                <span className="sidebar__icon" aria-hidden="true">
                  {item.icon}
                </span>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar__foot">
            <NavLink to="/settings" className="sidebar__account">
              <UserAvatar qq={bound?.qq} name={user?.username} />
              <span className="sidebar__account-text">
                <strong>{user?.username ?? "未登录"}</strong>
                <small>账号设置</small>
              </span>
            </NavLink>
            <p className="sidebar__hint">群消息自动沉淀为日程</p>
          </div>
        </aside>
      ) : null}

      <div className="app-main">
        {mode === "tabs" ? (
          <header className="topbar">
            <Brand compact />
            <NavLink to="/settings" className="avatar-link" aria-label="账户设置">
              <UserAvatar qq={bound?.qq} name={user?.username} />
            </NavLink>
          </header>
        ) : null}

        <main className="content">
          <div className="content__inner">
            <Outlet />
          </div>
        </main>

        {mode === "tabs" ? <TabBar items={navItems} /> : null}
      </div>

      <ToastHost messages={toasts} onDismiss={dismissToast} onAction={openAlerts} />
    </div>
  );
}
