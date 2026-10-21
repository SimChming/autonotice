import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

export interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

interface TabBarProps {
  items: NavItem[];
}

/** 手机端底部 Tab，固定并在安全区内留白。 */
export function TabBar({ items }: TabBarProps) {
  return (
    <nav className="tabbar" aria-label="主导航">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) => `tabbar__item${isActive ? " is-active" : ""}`}
        >
          <span className="tabbar__icon" aria-hidden="true">
            {item.icon}
          </span>
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
