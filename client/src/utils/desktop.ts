/**
 * 桌面形态判定与 Hook。
 *
 * 判定优先级：
 *   1. **运行时壳优先**：Tauri 壳（Windows exe）一律走桌面；Capacitor 壳
 *      （Android/iOS apk）一律移动。
 *   2. **操作系统优先**：Windows / macOS / Linux（纯浏览器，非壳）默认
 *      走桌面 UI——哪怕浏览器分辨率低（如 1280×720、1366×768）也不会
 *      被误判成移动端。唯一的例外是：
 *        a. 窗口过窄（< 480 CSS px，典型是远程桌面或浏览器工具面板）
 *        b. 触屏设备（pointer: coarse，比如二合一平板开宽窗口）
 *   3. **移动端浏览器**：平板最短边（DPR 校正）≥ 600 + 横屏 → 笔记本
 *      版排版；否则手机版。
 *
 * 这样设计能避免「低分辨率电脑被误认为手机」的常见坑：OS 本身
 * 就是最强信号，像素尺寸只在移动端浏览器场景才参与判断。
 */
import { useEffect, useState } from 'react'

import { detectDeviceKind, detectRuntime } from './platform'

/** 浏览器工具面板等极端窄窗口才退移动端的阈值（CSS px） */
const DESKTOP_MIN_WIDTH = 480
/** 平板最短边阈值（DPR 校正后的物理像素） */
const TABLET_MIN_PHYSICAL = 600
/** 平板横屏最小宽度（CSS px） */
const TABLET_MIN_WIDTH = 900

/**
 * 取 CSS 像素窗口 + DPR 校正后的物理最短边。
 * DPR 越高（Retina / 高 DPI 屏），同样 CSS 尺寸对应的物理像素越多，
 * 平板 vs 手机的物理最短边差异（600px 分界）更准确。
 */
function physicalMinSide(): number {
  const w = window.innerWidth
  const h = window.innerHeight
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  return Math.round(Math.min(w, h) * dpr)
}

function computeDesktop(): boolean {
  if (typeof window === 'undefined') return false

  const runtime = detectRuntime()
  const kind = detectDeviceKind()

  // 1. 壳内运行时
  if (runtime === 'tauri') return true
  if (runtime === 'capacitor') return false // 只用于移动 apk

  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
  const w = window.innerWidth
  const h = window.innerHeight

  // 2. 桌面 OS（纯浏览器，非壳）
  if (kind === 'windows' || kind === 'macos' || kind === 'linux') {
    // 过窄窗口才退移动端（远程桌面 / 工具面板）
    if (w < DESKTOP_MIN_WIDTH) return false
    // 触屏二合一平板开宽窗口 → 用笔记本版（侧边栏收窄）
    if (coarse) {
      return physicalMinSide() >= TABLET_MIN_PHYSICAL && w >= TABLET_MIN_WIDTH
    }
    return true
  }

  // 3. 移动端浏览器（iOS Safari / Android Chrome）
  if (coarse) {
    // 触屏 + 物理最短边够大 = 平板浏览器（iPad / Android 平板）
    if (physicalMinSide() < TABLET_MIN_PHYSICAL) return false
    return w > h && w >= TABLET_MIN_WIDTH
  }
  // 非触屏 + 非桌面 OS（极罕见）→ 保险起见走移动
  return false
}

/** 是否启用桌面专用 UI（侧边栏外壳）；窗口跨断点变化（含旋转）时自动切换 */
export function useDesktopUI(): boolean {
  const [desktop, setDesktop] = useState(computeDesktop)
  useEffect(() => {
    const onResize = () => setDesktop(computeDesktop())
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])
  return desktop
}
