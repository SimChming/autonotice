import type { ScheduleItem } from "@autonotice/shared";
import { GroupChip } from "./GroupChip";
import { CheckIcon, TrashIcon } from "./Icons";
import { formatDayLabel, formatTime, isOverdue } from "../utils/date";
import { schedulePriorityLabel, scheduleStatusLabel, scheduleTypeLabel } from "../utils/labels";

interface ScheduleCardProps {
  item: ScheduleItem;
  busy?: boolean;
  onToggle: (item: ScheduleItem) => void;
  onDelete: (item: ScheduleItem) => void;
}

export function ScheduleCard({ item, busy = false, onToggle, onDelete }: ScheduleCardProps) {
  const done = item.status === "done";
  const cancelled = item.status === "cancelled";
  const overdue = isOverdue(item.dueAt, item.status);
  const className = [
    "schedule-card",
    `priority--${item.priority}`,
    done ? "is-done" : "",
    cancelled ? "is-cancelled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={className}>
      <button
        type="button"
        className="schedule-check"
        aria-pressed={done}
        aria-label={done ? `将“${item.title}”恢复为待办` : `将“${item.title}”标记为完成`}
        onClick={() => onToggle(item)}
        disabled={busy}
      >
        {done ? <CheckIcon /> : null}
      </button>

      <div className="schedule-main">
        <div className="schedule-head">
          <h3>{item.title}</h3>
          <span className={`badge badge--priority-${item.priority}`}>
            {schedulePriorityLabel(item.priority)}优先级
          </span>
        </div>

        <div className="schedule-meta">
          <span className={`schedule-time${overdue ? " is-overdue" : ""}`}>
            {item.dueAt ? `${formatDayLabel(item.dueAt)} ${formatTime(item.dueAt)}` : "无截止时间"}
          </span>
          <span className="meta-dot" aria-hidden="true" />
          <span>{scheduleTypeLabel(item.type)}</span>
          <span className="meta-dot" aria-hidden="true" />
          <span className={`status-pill status-pill--${item.status}`}>
            {scheduleStatusLabel(item.status)}
          </span>
        </div>

        {item.notes ? <p className="schedule-notes">{item.notes}</p> : null}

        <div className="schedule-foot">
          <GroupChip
            groupId={item.groupId}
            groupName={item.groupName}
            groupAvatar={item.groupAvatar}
          />
          {overdue ? <span className="overdue-flag">已逾期</span> : null}
        </div>
      </div>

      <button
        type="button"
        className="icon-btn icon-btn--danger schedule-delete"
        aria-label={`删除日程“${item.title}”`}
        onClick={() => onDelete(item)}
        disabled={busy}
      >
        <TrashIcon />
      </button>
    </article>
  );
}
