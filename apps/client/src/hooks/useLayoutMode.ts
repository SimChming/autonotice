import { useEffect, useState } from "react";

export type LayoutMode = "tabs" | "sidebar";

/**
 * 手机（宽 < 900 或最短边 < 600）用底部 Tab；
 * 平板横屏与桌面用左侧导航。只依赖视口尺寸，不判断 UA。
 */
function resolveMode(): LayoutMode {
  if (typeof window === "undefined") {
    return "sidebar";
  }
  const width = window.innerWidth;
  const height = window.innerHeight;
  const shortestEdge = Math.min(width, height);
  return width >= 900 && shortestEdge >= 600 ? "sidebar" : "tabs";
}

export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(resolveMode);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setMode(resolveMode()));
    };

    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    update();

    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return mode;
}
