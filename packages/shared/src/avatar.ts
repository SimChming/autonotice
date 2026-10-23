/**
 * 已绑定 QQ 的头像地址（QQ 官方头像 CDN）。
 * 客户端与后台统一从这里取，避免各自拼接；QQ 换头像后自动更新。
 */
export function qqAvatarUrl(qq: string, size = 640): string {
  const digits = qq.replace(/\D/g, "");
  return `https://q1.qlogo.cn/g?b=qq&nk=${digits}&s=${size}`;
}
