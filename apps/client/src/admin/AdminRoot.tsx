import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { SERVICE_VERSION } from "@autonotice/shared";
import { BrandIcon } from "../components/Icons";
import {
  ADMIN_TOKEN_KEY,
  ADMIN_UNAUTHORIZED_EVENT,
  adminApi,
  adminErrorMessage,
  getAdminToken,
  setAdminToken,
} from "./api";
import { AdminLayout } from "./AdminLayout";
import "./admin.css";

interface AdminLoginPageProps {
  onLoggedIn: (token: string) => void;
}

function AdminLoginPage({ onLoggedIn }: AdminLoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = username.trim();
    if (!name || !password) {
      setError("请填写管理员用户名和密码");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await adminApi.login({ username: name, password });
      onLoggedIn(response.token);
    } catch (submitError) {
      setError(adminErrorMessage(submitError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page admin-login">
      <div className="ambient" aria-hidden="true" />
      <section className="auth-card" aria-labelledby="admin-login-title">
        <div className="auth-brand">
          <span className="brand__mark brand__mark--large">
            <BrandIcon />
          </span>
          <span className="auth-brand__text">
            <strong>Autonotice {SERVICE_VERSION}</strong>
            <small>Admin Console</small>
          </span>
        </div>

        <p className="eyebrow">ADMIN CONSOLE</p>
        <h1 id="admin-login-title">管理员登录</h1>
        <p className="auth-subtitle">
          使用独立的管理员账号进入控制台。普通用户账号无法访问此页面。
        </p>

        <form className="form" onSubmit={handleSubmit} aria-busy={loading} noValidate>
          <div className="field">
            <label htmlFor="admin-username">管理员用户名</label>
            <input
              id="admin-username"
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="输入管理员用户名"
              maxLength={64}
            />
          </div>

          <div className="field">
            <label htmlFor="admin-password">密码</label>
            <input
              id="admin-password"
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="输入管理员密码"
              maxLength={128}
            />
          </div>

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn btn--primary btn--block" disabled={loading}>
            {loading ? <span className="spinner" aria-hidden="true" /> : null}
            {loading ? "验证中…" : "进入控制台"}
          </button>
        </form>

        <p className="auth-foot">管理员账号默认见服务器 .env（ADMIN_USERNAME / ADMIN_PASSWORD）。</p>
        <p className="auth-foot">
          <Link to="/">返回用户端</Link>
        </p>
      </section>
    </div>
  );
}

/**
 * 后台入口守卫：没有管理员 token 时直接渲染登录页，
 * 不依赖普通用户登录状态，也不挂载用户端 Layout。
 */
export function AdminRoot() {
  const [token, setToken] = useState<string | null>(() => getAdminToken());

  useEffect(() => {
    const handleUnauthorized = () => setToken(getAdminToken());
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === ADMIN_TOKEN_KEY) {
        setToken(getAdminToken());
      }
    };
    window.addEventListener(ADMIN_UNAUTHORIZED_EVENT, handleUnauthorized);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(ADMIN_UNAUTHORIZED_EVENT, handleUnauthorized);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const handleLoggedIn = (nextToken: string) => {
    setAdminToken(nextToken);
    setToken(nextToken);
  };

  const handleLogout = () => {
    setAdminToken(null);
    setToken(null);
  };

  if (!token) {
    return <AdminLoginPage onLoggedIn={handleLoggedIn} />;
  }

  return <AdminLayout onLogout={handleLogout} />;
}
