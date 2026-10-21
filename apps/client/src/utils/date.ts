import type { ScheduleItem, ScheduleStatus } from "@autonotice/shared";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (value: number): string => String(value).padStart(2, "0");

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function parseIso(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTime(iso: string | null | undefined): string {
  const date = parseIso(iso);
  return date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : "--:--";
}

/** 今天 / 明天 / 昨天 / 10月22日 周三；跨年时补上年份。 */
export function formatDayLabel(iso: string | null | undefined): string {
  const date = parseIso(iso);
  if (!date) {
    return "未定日期";
  }
  const now = new Date();
  const diff = Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / DAY_MS);
  if (diff === 0) {
    return "今天";
  }
  if (diff === 1) {
    return "明天";
  }
  if (diff === -1) {
    return "昨天";
  }
  const weekday = WEEKDAYS[date.getDay()] ?? "";
  const year = date.getFullYear() === now.getFullYear() ? "" : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${weekday}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  const date = parseIso(iso);
  if (!date) {
    return "未定时间";
  }
  const year = date.getFullYear() === new Date().getFullYear() ? "" : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${formatTime(iso)}`;
}

/** datetime-local 的本地时间字符串 → 带时区的 ISO 字符串。 */
export function fromDatetimeLocal(value: string): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function isOverdue(iso: string | null, status: ScheduleStatus): boolean {
  if (status !== "pending" || !iso) {
    return false;
  }
  const date = parseIso(iso);
  return date !== null && date.getTime() < Date.now();
}

export interface ScheduleGroup {
  key: string;
  label: string;
  items: ScheduleItem[];
}

const STATUS_RANK: Record<ScheduleStatus, number> = {
  pending: 0,
  done: 1,
  cancelled: 2,
};

function startOfLocalDayKey(iso: string | null): string {
  const date = parseIso(iso);
  if (!date) {
    return "unscheduled";
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function compareItems(left: ScheduleItem, right: ScheduleItem): number {
  const statusDiff = STATUS_RANK[left.status] - STATUS_RANK[right.status];
  if (statusDiff !== 0) {
    return statusDiff;
  }
  const leftTime = left.dueAt ? Date.parse(left.dueAt) : Number.POSITIVE_INFINITY;
  const rightTime = right.dueAt ? Date.parse(right.dueAt) : Number.POSITIVE_INFINITY;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.createdAt.localeCompare(right.createdAt);
}

/** 按本地日期分组；无截止时间的日程排在最后。 */
export function groupSchedules(items: ScheduleItem[]): ScheduleGroup[] {
  const buckets = new Map<string, ScheduleItem[]>();
  for (const item of items) {
    const key = startOfLocalDayKey(item.dueAt);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(key, [item]);
    }
  }

  return [...buckets.entries()]
    .map(([key, groupItems]) => {
      const firstDueAt = groupItems[0]?.dueAt ?? null;
      return {
        key,
        label: key === "unscheduled" ? "无截止时间" : formatDayLabel(firstDueAt),
        items: [...groupItems].sort(compareItems),
      };
    })
    .sort((left, right) => {
      if (left.key === "unscheduled") {
        return 1;
      }
      if (right.key === "unscheduled") {
        return -1;
      }
      return left.key.localeCompare(right.key);
    });
}
