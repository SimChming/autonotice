import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SERVICE_VERSION } from "@autonotice/shared";
import { useAuthStore } from "../stores/auth";
import { BrandIcon } from "../components/Icons";

type Mode = "login" | "register";

export function LoginPage() {
  const login = useAuthStore((state) => state.login);
  const register = useAuthStore((state) => state.register);
  const navigate = useNavigate();

  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchMode = (next: Mode) => {
    if (next === mode) {
      return;
    }
    setMode(next);
    setError(null);
    setPassword("");
    setConfirmPassword("");
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = username.trim();

    if (!name) {
      setError("请填写用户名");
      return;
    }
    if (mode === "register") {
      if (!/^[a-zA-Z0-9_]{3,32}$/.test(name)) {
        setError("用户名需为 3-32 位字母、数字或下划线");
        return;
      }
      if (password.length < 8) {
        setError("密码至少 8 位");
        return;
      }
      if (password !== confirmPassword) {
        setError("两次输入的密码不一致");
        return;
      }
    } else if (!password) {
      setError("请填写密码");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      if (mode === "login") {
        await login({ username: name, password });
      } else {
        await register({ username: name, password });
      }
      navigate("/schedule", { replace: true });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "操作失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="ambient" aria-hidden="true" />
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand">
          <span className="brand__mark brand__mark--large">
            <BrandIcon />
          </span>
          <span className="auth-brand__text">
            <strong>Autonotice {SERVICE_VERSION}</strong>
            <small>群消息 · 日程 · 提醒</small>
          </span>
        </div>

        <p className="eyebrow">WELCOME ABOARD</p>
        <h1 id="auth-title">{mode === "login" ? "回到你的 Autonotice" : "创建一枚新账号"}</h1>
        <p className="auth-subtitle">
          {mode === "login"
            ? "群消息里的时间与任务已经替你收好，登录即可查看。"
            : "注册后绑定 QQ，机器人会把群消息整理成不会错过的日程。"}
        </p>

        <div className="segmented segmented--full" role="group" aria-label="登录或注册">
          <button
            type="button"
            className={mode === "login" ? "is-active" : ""}
            aria-pressed={mode === "login"}
            onClick={() => switchMode("login")}
          >
            登录
          </button>
          <button
            type="button"
            className={mode === "register" ? "is-active" : ""}
            aria-pressed={mode === "register"}
            onClick={() => switchMode("register")}
          >
            注册
          </button>
        </div>

        <form className="form" onSubmit={handleSubmit} aria-busy={loading} noValidate>
          <div className="field">
            <label htmlFor="auth-username">用户名</label>
            <input
              id="auth-username"
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="输入用户名"
              maxLength={32}
            />
            {mode === "register" ? (
              <span className="field__hint">3-32 位字母、数字或下划线。</span>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="auth-password">密码</label>
            <input
              id="auth-password"
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder={mode === "login" ? "输入密码" : "至少 8 位"}
              maxLength={72}
            />
          </div>

          {mode === "register" ? (
            <div className="field">
              <label htmlFor="auth-confirm">确认密码</label>
              <input
                id="auth-confirm"
                name="confirm"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                placeholder="再输入一次密码"
                maxLength={72}
              />
            </div>
          ) : null}

          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn btn--primary btn--block" disabled={loading}>
            {loading ? <span className="spinner" aria-hidden="true" /> : null}
            {loading ? "处理中…" : mode === "login" ? "进入 Autonotice" : "创建账号"}
          </button>
        </form>

        <p className="auth-foot">登录后即可查看群消息生成的日程与多端提醒。</p>
        <p className="auth-foot">
          <Link to="/admin">管理员入口</Link>
        </p>
      </section>
    </div>
  );
}
