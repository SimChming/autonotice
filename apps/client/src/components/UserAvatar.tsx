import { useState } from "react";
import { qqAvatarUrl } from "@autonotice/shared";

interface UserAvatarProps {
  qq?: string | null;
  name?: string | null;
  large?: boolean;
}

/**
 * 用户头像：优先使用已绑定 QQ 的头像，加载失败时回退到用户名首字母。
 */
export function UserAvatar({ qq, name, large = false }: UserAvatarProps) {
  const [failed, setFailed] = useState(false);
  const initial = name?.slice(0, 1).toUpperCase() ?? "?";
  const className = `avatar${large ? " avatar--large" : ""}`;

  if (qq && !failed) {
    return (
      <img
        className={`${className} avatar--img`}
        src={qqAvatarUrl(qq)}
        alt={name ? `${name} 的头像` : "用户头像"}
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span className={className} aria-hidden="true">
      {initial}
    </span>
  );
}
