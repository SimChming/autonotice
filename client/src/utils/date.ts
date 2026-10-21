/**
 * 日期/时间工具。
 *
 * 约定：服务端 cron 与生成时间均按 Asia/Shanghai，客户端假定设备已处于该时区；
 * 所有解析/格式化走本地时区，避免跨端（Tauri/Capacitor/浏览器）行为不一致。
 */

export const MINUTE = 60 * 1000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** 解析 RFC3339 / 时间戳 / Date 为 Date，失败返回 null */
export function parseDate(input?: string | number | Date | null): Date | null {
  if (input === null || input === undefined || input === '') return null
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input
  if (typeof input === 'number') {
    const d = new Date(input)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const d = new Date(input)
  return Number.isNaN(d.getTime()) ? null : d
}

export function toMs(input?: string | number | Date | null): number | null {
  const d = parseDate(input)
  return d ? d.getTime() : null
}

export function toRFC3339(input: Date | number): string {
  return new Date(input).toISOString()
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function startOfDay(input: Date | number = Date.now()): Date {
  const d = new Date(input)
  d.setHours(0, 0, 0, 0)
  return d
}

export function endOfDay(input: Date | number = Date.now()): Date {
  const d = new Date(input)
  d.setHours(23, 59, 59, 999)
  return d
}

/** 周一为一周起点 */
export function startOfWeek(input: Date | number = Date.now()): Date {
  const d = startOfDay(input)
  const day = d.getDay() // 0 = 周日
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d
}

export function endOfWeek(input: Date | number = Date.now()): Date {
  const s = startOfWeek(input)
  const e = new Date(s)
  e.setDate(e.getDate() + 6)
  e.setHours(23, 59, 59, 999)
  return e
}

export function isSameDay(a: Date | number, b: Date | number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  )
}

export function isToday(input?: string | number | Date | null): boolean {
  const ms = toMs(input)
  if (ms === null) return false
  return isSameDay(ms, Date.now())
}

export function isThisWeek(input?: string | number | Date | null): boolean {
  const ms = toMs(input)
  if (ms === null) return false
  return ms >= startOfWeek().getTime() && ms <= endOfWeek().getTime()
}

export function isPast(input?: string | number | Date | null): boolean {
  const ms = toMs(input)
  return ms !== null && ms < Date.now()
}

export function fmtDate(input?: string | number | Date | null, fallback = '未定时间'): string {
  const d = parseDate(input)
  if (!d) return fallback
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function fmtTime(input?: string | number | Date | null, fallback = ''): string {
  const d = parseDate(input)
  if (!d) return fallback
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtDateTime(input?: string | number | Date | null, fallback = '未定时间'): string {
  const d = parseDate(input)
  if (!d) return fallback
  const now = new Date()
  const yearPrefix = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}年`
  return `${yearPrefix}${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`
}

/** 相对时间：刚刚 / 3 分钟后 / 2 小时后 / 3 天后 / 3 天前 */
export function fmtRelative(input?: string | number | Date | null): string {
  const ms = toMs(input)
  if (ms === null) return ''
  const diff = ms - Date.now()
  const abs = Math.abs(diff)
  const suffix = diff >= 0 ? '后' : '前'
  if (abs < MINUTE) return '刚刚'
  if (abs < HOUR) return `${Math.round(abs / MINUTE)} 分钟${suffix}`
  if (abs < DAY) return `${Math.round(abs / HOUR)} 小时${suffix}`
  if (abs < 30 * DAY) return `${Math.round(abs / DAY)} 天${suffix}`
  return fmtDateTime(input)
}

/** 倒计时样式文案，用于「截止提醒」 */
export function fmtCountdown(input?: string | number | Date | null): string {
  const ms = toMs(input)
  if (ms === null) return ''
  const diff = ms - Date.now()
  if (diff < 0) return `已过期 ${fmtRelative(input)}`.replace(/^已过期 /, '已过期 ')
  const d = Math.floor(diff / DAY)
  const h = Math.floor((diff % DAY) / HOUR)
  const m = Math.floor((diff % HOUR) / MINUTE)
  if (d > 0) return `剩 ${d} 天 ${h} 小时`
  if (h > 0) return `剩 ${h} 小时 ${m} 分钟`
  return `剩 ${m} 分钟`
}

/** 生成日历网格：从本周（或指定月）起始补齐到整周 */
export interface CalendarCell {
  date: Date
  key: string
  inMonth: boolean
  isToday: boolean
}

export function dateKey(input: Date | number): string {
  const d = new Date(input)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function buildMonthGrid(year: number, month: number): CalendarCell[] {
  const first = new Date(year, month, 1)
  const start = startOfWeek(first)
  const cells: CalendarCell[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    cells.push({
      date: d,
      key: dateKey(d),
      inMonth: d.getMonth() === month,
      isToday: isSameDay(d, Date.now())
    })
  }
  return cells.slice(0, cells[35].date.getMonth() === month ? 35 : 42)
}

export function monthLabel(year: number, month: number): string {
  return `${year}年${month + 1}月`
}
