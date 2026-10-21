import type { SchedulePriority, ScheduleStatus, ScheduleType } from "@autonotice/shared";

const TYPE_LABELS: Record<ScheduleType, string> = {
  task: "任务",
  exam: "考试",
  meeting: "会议",
  other: "其他",
};

const PRIORITY_LABELS: Record<SchedulePriority, string> = {
  high: "高",
  normal: "中",
  low: "低",
};

const STATUS_LABELS: Record<ScheduleStatus, string> = {
  pending: "待办",
  done: "已完成",
  cancelled: "已取消",
};

const ALERT_LEVEL_LABELS: Record<string, string> = {
  high: "重要",
  normal: "普通",
  low: "轻提醒",
};

export const SCHEDULE_TYPE_OPTIONS: ReadonlyArray<{ value: ScheduleType; label: string }> = [
  { value: "task", label: TYPE_LABELS.task },
  { value: "exam", label: TYPE_LABELS.exam },
  { value: "meeting", label: TYPE_LABELS.meeting },
  { value: "other", label: TYPE_LABELS.other },
];

export const SCHEDULE_PRIORITY_OPTIONS: ReadonlyArray<{ value: SchedulePriority; label: string }> = [
  { value: "high", label: "高优先级" },
  { value: "normal", label: "普通" },
  { value: "low", label: "低优先级" },
];

export function scheduleTypeLabel(type: ScheduleType): string {
  return TYPE_LABELS[type];
}

export function schedulePriorityLabel(priority: SchedulePriority): string {
  return PRIORITY_LABELS[priority];
}

export function scheduleStatusLabel(status: ScheduleStatus): string {
  return STATUS_LABELS[status];
}

export function alertLevelLabel(level: string): string {
  return ALERT_LEVEL_LABELS[level] ?? "提醒";
}
