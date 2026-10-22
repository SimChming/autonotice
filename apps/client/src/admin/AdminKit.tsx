import type { ReactNode } from "react";

interface AdminPageHeadProps {
  eyebrow: string;
  title: string;
  subtitle: string;
  actions?: ReactNode;
}

/** 管理后台统一页头：与用户端视觉一致，只通过 eyebrow 区分模块。 */
export function AdminPageHead({ eyebrow, title, subtitle, actions }: AdminPageHeadProps) {
  return (
    <header className="page-head">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
      {actions ? <div className="admin-head-actions">{actions}</div> : null}
    </header>
  );
}

type NoticeTone = "error" | "success" | "info";

export function AdminNotice({ tone = "error", children }: { tone?: NoticeTone; children: ReactNode }) {
  return (
    <p className={`notice notice--${tone}`} role={tone === "error" ? "alert" : undefined}>
      {children}
    </p>
  );
}

type TagTone = "default" | "accent" | "owner" | "builtin";

export function AdminTag({ tone = "default", children }: { tone?: TagTone; children: ReactNode }) {
  return <span className={`admin-tag admin-tag--${tone}`}>{children}</span>;
}

interface AdminSwitchProps {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: () => void;
}

/** 原生按钮实现的可访问开关，避免引入 UI 库。 */
export function AdminSwitch({ checked, label, disabled, onChange }: AdminSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`admin-switch${checked ? " is-on" : ""}`}
      disabled={disabled}
      onClick={onChange}
    >
      <span className="admin-switch__track" aria-hidden="true">
        <span className="admin-switch__knob" />
      </span>
      <span className="admin-switch__label">{checked ? "已启用" : "已停用"}</span>
    </button>
  );
}
