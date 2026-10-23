/**
 * 复制文本的跨端兜底实现。
 * `navigator.clipboard` 只在安全上下文（HTTPS / localhost）可用，
 * 通过 HTTP 访问管理后台或部分 WebView 时会直接拒绝，这里回退到
 * 临时 textarea + execCommand("copy")。
 */
export async function copyText(text: string): Promise<boolean> {
  const secure = typeof window !== "undefined" && window.isSecureContext;
  if (secure && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 继续走兜底方案。
    }
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
