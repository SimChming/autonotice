import { useEffect, useId, useState, type FormEvent } from "react";
import type { GroupItem, SchedulePriority, ScheduleType } from "@autonotice/shared";
import { useScheduleStore } from "../stores/schedule";
import { api } from "../services/api";
import { fromDatetimeLocal } from "../utils/date";
import {
  SCHEDULE_PRIORITY_OPTIONS,
  SCHEDULE_TYPE_OPTIONS,
} from "../utils/labels";
import { Sheet } from "./Sheet";

interface NewScheduleSheetProps {
  onClose: () => void;
}

export function NewScheduleSheet({ onClose }: NewScheduleSheetProps) {
  const createSchedule = useScheduleStore((state) => state.createSchedule);
  const fieldId = useId();

  const [title, setTitle] = useState("");
  const [type, setType] = useState<ScheduleType>("task");
  const [priority, setPriority] = useState<SchedulePriority>("normal");
  const [dueAt, setDueAt] = useState("");
  const [notes, setNotes] = useState("");
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [groupId, setGroupId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listGroups()
      .then(({ items }) => setGroups(items))
      .catch(() => undefined);
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("请填写日程标题");
      return;
    }
    if (trimmedTitle.length > 120) {
      setError("标题最多 120 个字符");
      return;
    }
    if (notes.length > 1000) {
      setError("备注最多 1000 个字符");
      return;
    }
    const dueIso = dueAt ? fromDatetimeLocal(dueAt) : null;
    if (dueAt && !dueIso) {
      setError("截止时间格式不正确");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await createSchedule({
        title: trimmedTitle,
        type,
        priority,
        dueAt: dueIso,
        notes: notes.trim(),
        groupId: groupId || null,
      });
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "创建失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet
      title="新建日程"
      subtitle="手动补充一条日程，到点会通过提醒推送。"
      onClose={onClose}
    >
      <form className="form" onSubmit={handleSubmit} aria-busy={submitting}>
        <div className="field">
          <label htmlFor={`${fieldId}-title`}>标题</label>
          <input
            id={`${fieldId}-title`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            placeholder="例如：周三交数据结构实验报告"
            autoComplete="off"
          />
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor={`${fieldId}-type`}>类型</label>
            <select
              id={`${fieldId}-type`}
              value={type}
              onChange={(event) => setType(event.target.value as ScheduleType)}
            >
              {SCHEDULE_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${fieldId}-priority`}>优先级</label>
            <select
              id={`${fieldId}-priority`}
              value={priority}
              onChange={(event) => setPriority(event.target.value as SchedulePriority)}
            >
              {SCHEDULE_PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label htmlFor={`${fieldId}-due`}>截止时间</label>
          <input
            id={`${fieldId}-due`}
            type="datetime-local"
            value={dueAt}
            onChange={(event) => setDueAt(event.target.value)}
          />
          <span className="field__hint">留空表示不设置截止时间；提醒默认提前 30 分钟。</span>
        </div>

        <div className="field">
          <label htmlFor={`${fieldId}-notes`}>备注</label>
          <textarea
            id={`${fieldId}-notes`}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={1000}
            placeholder="补充地点、提交方式或任何不想忘记的细节"
          />
        </div>

        {groups.length > 0 ? (
          <div className="field">
            <label htmlFor={`${fieldId}-group`}>来源群聊</label>
            <select
              id={`${fieldId}-group`}
              value={groupId}
              onChange={(event) => setGroupId(event.target.value)}
            >
              <option value="">手动创建（不关联群聊）</option>
              {groups.map((group) => (
                <option key={group.groupId} value={group.groupId}>
                  {group.name || `群 ${group.groupId}`}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="sheet__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? <span className="spinner" aria-hidden="true" /> : null}
            {submitting ? "创建中…" : "创建日程"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
