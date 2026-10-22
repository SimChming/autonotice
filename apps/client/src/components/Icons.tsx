import type { ReactNode } from "react";

interface IconProps {
  className?: string;
}

interface SvgIconProps extends IconProps {
  children: ReactNode;
  viewBox?: string;
  filled?: boolean;
}

function SvgIcon({ children, className, viewBox = "0 0 24 24", filled = false }: SvgIconProps) {
  return (
    <svg
      viewBox={viewBox}
      className={className}
      aria-hidden="true"
      focusable="false"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={filled ? undefined : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** 简洁的鲸鱼侧影：品牌标识，也是深色主题的视觉锚点。 */
export function WhaleMark({ className }: IconProps) {
  return (
    <SvgIcon className={className} viewBox="0 0 48 48" filled>
      <path d="M25 8.5c-9.4 0-17 6.7-18.4 15.4l-4.4-3.6-1.2 6.2 5.6 4.1c2.1 6.2 8.4 10.9 16.8 10.9 10.4 0 18.6-7.9 18.6-17.2S35.4 8.5 25 8.5Z" />
      <path d="M7.4 33.1 3 35.5l1.1 6.9 6.1-4.6-2.8-4.7Z" opacity=".55" />
      <circle cx="31.2" cy="22.7" r="2.1" fill="var(--bg, #0b1220)" />
      <path
        d="M16.5 29.5c3.7 2 8.1 2.1 11.8.3"
        fill="none"
        stroke="var(--bg, #0b1220)"
        strokeWidth="1.7"
        strokeLinecap="round"
        opacity=".55"
      />
    </SvgIcon>
  );
}

export function CalendarIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
      <path d="M3.5 9.5h17M8 3.2v3.6M16 3.2v3.6" />
      <path d="M8 13.2h2.2M13.8 13.2H16M8 16.7h2.2" />
    </SvgIcon>
  );
}

export function BellIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="M18.2 16.3H5.8c1-1.4 1.6-3 1.6-4.8v-1.4a4.6 4.6 0 0 1 9.2 0v1.4c0 1.8.6 3.4 1.6 4.8Z" />
      <path d="M9.8 18.8a2.3 2.3 0 0 0 4.4 0M12 3.2V2" />
    </SvgIcon>
  );
}

export function LinkIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="M10.2 13.8a3.6 3.6 0 0 0 5.1 0l2.5-2.5a3.6 3.6 0 0 0-5.1-5.1l-1.4 1.4" />
      <path d="M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-2.5 2.5a3.6 3.6 0 0 0 5.1 5.1l1.4-1.4" />
    </SvgIcon>
  );
}

export function UserIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <circle cx="12" cy="8.2" r="3.7" />
      <path d="M4.8 20.2c.7-3.6 3.6-5.8 7.2-5.8s6.5 2.2 7.2 5.8" />
    </SvgIcon>
  );
}

/** 群聊：两个重叠的对话气泡。 */
export function GroupsIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="M4.5 5.5h10.8v8.2H9.2L5.6 17v-3.3H4.5Z" />
      <path d="M9.8 16.6v1.9h5.6l3 2.4v-2.4h1.1V9.6h-3.1" />
    </SvgIcon>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="M12 5v14M5 12h14" />
    </SvgIcon>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="M4.5 7h15M9.5 7V4.8h5V7M7 7l.8 12.2h8.4L17 7" />
      <path d="M10.2 10.6v5.2M13.8 10.6v5.2" />
    </SvgIcon>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className} viewBox="0 0 24 24">
      <path d="m5.5 12.5 4.2 4.2 8.8-9.4" />
    </SvgIcon>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </SvgIcon>
  );
}

export function CopyIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <rect x="9" y="9" width="11" height="11" rx="2.4" />
      <path d="M15 9V6.4A2.4 2.4 0 0 0 12.6 4H6.4A2.4 2.4 0 0 0 4 6.4v6.2A2.4 2.4 0 0 0 6.4 15H9" />
    </SvgIcon>
  );
}

export function LogoutIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="M14.5 8V5.8A1.8 1.8 0 0 0 12.7 4H6.3a1.8 1.8 0 0 0-1.8 1.8v12.4A1.8 1.8 0 0 0 6.3 20h6.4a1.8 1.8 0 0 0 1.8-1.8V16" />
      <path d="M10 12h10M17 8.5l3.5 3.5-3.5 3.5" />
    </SvgIcon>
  );
}

export function RefreshIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.8 4.8v4.4h-4.4" />
    </SvgIcon>
  );
}

export function ArrowRightIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="M5 12h14M14 6.5l5.5 5.5-5.5 5.5" />
    </SvgIcon>
  );
}

/** 管理后台：盾牌。 */
export function ShieldIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="M12 3.2 19 6v5.4c0 4.4-2.9 7.6-7 9.4-4.1-1.8-7-5-7-9.4V6Z" />
      <path d="m9.2 11.8 1.9 1.9 3.7-4" />
    </SvgIcon>
  );
}

/** Shell：终端窗口。 */
export function TerminalIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.6" />
      <path d="m7.2 9 2.6 3-2.6 3M12.4 15h4.4" />
    </SvgIcon>
  );
}

/** 外部链接：从后台打开 NapCat 等独立页面。 */
export function ExternalIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="M13.5 4.5H19v5.5M19 4.5 11 12.5" />
      <path d="M18 14.2v3.3A2.5 2.5 0 0 1 15.5 20h-9A2.5 2.5 0 0 1 4 17.5v-9A2.5 2.5 0 0 1 6.5 6h3.2" />
    </SvgIcon>
  );
}
