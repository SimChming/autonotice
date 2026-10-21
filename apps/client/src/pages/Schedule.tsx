import { useCallback, useEffect, useMemo, useState } from "react";
import type { ScheduleItem } from "@autonotice/shared";
import { useScheduleStore } from "../stores/schedule";
import { groupSchedules } from "../utils/date";
import { EmptyState } from "../components/EmptyState";
import { NewScheduleSheet } from "../components/NewScheduleSheet";
import { ScheduleCard } from "../components/ScheduleCard";
import { PlusIcon } from "../components/Icons";

type Filter = "all" | "pending" | "done";

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待办" },
  { value: "done", label: "已完成" },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

export function SchedulePage() {
  const items = useScheduleStore((state) => state.items);
  const loading = useScheduleStore((state) => state.loading);
  const error = useScheduleStore((state) => state.error);
  const fetchSchedules = useScheduleStore((state) => state.fetchSchedules);
  const updateSchedule = useScheduleStore((state) => state.updateSchedule);
  const deleteSchedule = useScheduleStore((state) => state.deleteSchedule);

  const [filter, setFilter] = useState<Filter>("all");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    void fetchSchedules();
  }, [fetchSchedules]);

  const closeSheet = useCallback(() => setSheetOpen(false), []);

  const pendingCount = useMemo(
    () => items.filter((item) => item.status === "pending").length,
    [items],
  );
  const doneCount = useMemo(() => items.filter((item) => item.status === "done").length, [items]);

  const visibleItems = useMemo(() => {
    if (filter === "pending") {
      return items.filter((item) => item.status === "pending");
    }
    if (filter === "done") {
      return items.filter((item) => item.status === "done");
    }
    return items;
  }, [filter, items]);

  const groups = useMemo(() => groupSchedules(visibleItems), [visibleItems]);

  const handleToggle = async (item: ScheduleItem) => {
    setPendingId(item.id);
    setActionError(null);
    try {
      await updateSchedule(item.id, { status: item.status === "done" ? "pending" : "done" });
    } catch (toggleError) {
      setActionError(errorMessage(toggleError));
    } finally {
      setPendingId(null);
    }
  };

  const handleDelete = async (item: ScheduleItem) => {
    if (!window.confirm(`删除“${item.title}”？删除后不可恢复。`)) {
      return;
    }
    setPendingId(item.id);
    setActionError(null);
    try {
      await deleteSchedule(item.id);
    } catch (deleteError) {
      setActionError(errorMessage(deleteError));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">SCHEDULE</p>
          <h1>我的日程</h1>
          <p className="page-subtitle">
            {loading && items.length === 0
              ? "正在同步日程…"
              : `共 ${items.length} 条 · ${pendingCount} 条待办 · ${doneCount} 条已完成`}
          </p>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setSheetOpen(true)}>
          <PlusIcon />
          新建日程
        </button>
      </header>

      {error ? (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      ) : null}
      {actionError ? (
        <p className="notice notice--error" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="筛选日程">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={filter === option.value ? "is-active" : ""}
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="toolbar__hint">按截止日期分组</span>
      </div>

      {loading && items.length === 0 ? (
        <div className="schedule-list" aria-hidden="true">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : visibleItems.length === 0 ? (
        items.length === 0 ? (
          <EmptyState
            title="还没有日程"
            description="群消息里的时间与任务会自动出现在这里，也可以先手动记录一条。"
            action={
              <button type="button" className="btn btn--primary" onClick={() => setSheetOpen(true)}>
                <PlusIcon />
                新建第一条日程
              </button>
            }
          />
        ) : (
          <EmptyState
            title={filter === "pending" ? "没有待办日程" : "这个筛选下没有日程"}
            description={
              filter === "pending"
                ? "所有日程都已完成，去深海透口气吧。"
                : "切换到其他筛选，看看别的日程安排。"
            }
          />
        )
      ) : (
        <div className="schedule-groups">
          {groups.map((group) => (
            <section key={group.key} className="day-group">
              <header className="day-group__head">
                <h2>{group.label}</h2>
                <span>{group.items.length} 条</span>
              </header>
              <div className="schedule-list">
                {group.items.map((item) => (
                  <ScheduleCard
                    key={item.id}
                    item={item}
                    busy={pendingId === item.id}
                    onToggle={(target) => void handleToggle(target)}
                    onDelete={(target) => void handleDelete(target)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {sheetOpen ? <NewScheduleSheet onClose={closeSheet} /> : null}
    </>
  );
}
