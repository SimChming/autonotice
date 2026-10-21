import { createElement } from 'react'

export type IconName =
  | 'list'
  | 'calendar'
  | 'bell'
  | 'gear'
  | 'check'
  | 'chevron'
  | 'alert'
  | 'refresh'
  | 'plus'
  | 'link'
  | 'file'
  | 'user'
  | 'clock'
  | 'shield'
  | 'copy'
  | 'sparkle'
  | 'groups'

/**
 * 极简线性图标（内联 SVG）。
 * 用 createElement 而非 JSX，避免 Taro 的 JSX 类型定义限制；
 * 尺寸交给 CSS（pxtransform 会按设计稿缩放），保证与排版比例一致。
 */
const PATHS: Record<IconName, string[]> = {
  list: ['M4 7h16', 'M4 12h16', 'M4 17h10'],
  calendar: [
    'M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
    'M4 9.5h16',
    'M8.5 4v3',
    'M15.5 4v3'
  ],
  bell: ['M6 16.5V10a6 6 0 1 1 12 0v6.5', 'M9.5 19.5a2.8 2.8 0 0 0 5 0', 'M12 4v-1.5'],
  gear: [
    'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z',
    'M12 3.2v2.4',
    'M12 18.4v2.4',
    'M3.2 12h2.4',
    'M18.4 12h2.4'
  ],
  check: ['M5 13l4.2 4.2L19 7'],
  chevron: ['M9.5 6l6 6-6 6'],
  alert: ['M12 3.4l8.6 15.2H3.4z', 'M12 9.5v4.4', 'M12 16.6h.01'],
  refresh: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 3.6v4.6h-4.6'],
  plus: ['M12 5.5v13', 'M5.5 12h13'],
  link: [
    'M10.2 13.8a5 5 0 0 1 0-7l1.8-1.8a5 5 0 0 1 7 7l-1.6 1.6',
    'M13.8 10.2a5 5 0 0 1 0 7l-1.8 1.8a5 5 0 0 1-7-7l1.6-1.6'
  ],
  file: ['M6.5 3.5h7l4 4v13h-11z', 'M13.5 3.5v4h4'],
  user: ['M12 12.2a3.9 3.9 0 1 0 0-7.8 3.9 3.9 0 0 0 0 7.8z', 'M4.5 20.2c1.4-3.9 4.6-5.4 7.5-5.4s6.1 1.5 7.5 5.4'],
  clock: ['M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z', 'M12 7.5v4.8l3 1.8'],
  shield: ['M12 3.4l8 3v5.6c0 4.8-3.4 7.9-8 9-4.6-1.1-8-4.2-8-9V6.4z'],
  copy: ['M9 9.5h8.5v9.5H9z', 'M6.5 15V5.5H15'],
  sparkle: [
    'M12 3.6l1.9 4.6 4.6 1.9-4.6 1.9L12 16.6l-1.9-4.6L5.5 10.1l4.6-1.9z',
    'M18.4 15.6l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z'
  ],
  groups: [
    'M8.4 11.4a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6z',
    'M2.6 19.2c.9-2.7 3-3.9 5.8-3.9s4.9 1.2 5.8 3.9',
    'M15.6 11.6a2.4 2.4 0 1 0 0-4.8',
    'M14.6 15.8c2.1.3 3.6 1.5 4.4 3.4'
  ]
}

export interface IconProps {
  name: IconName
  className?: string
  /** 描边粗细（SVG viewBox 单位） */
  strokeWidth?: number
  color?: string
}

export function Icon({ name, className, strokeWidth = 1.8, color }: IconProps) {
  const attrs: Record<string, unknown> = {
    viewBox: '0 0 24 24',
    className: `qqsa-icon${className ? ` ${className}` : ''}`,
    fill: 'none',
    stroke: color || 'currentColor',
    'stroke-width': strokeWidth,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true'
  }
  return createElement(
    'svg',
    attrs,
    ...PATHS[name].map((d, i) => createElement('path', { key: i, d }))
  )
}
