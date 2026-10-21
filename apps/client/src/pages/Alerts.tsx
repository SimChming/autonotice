import { useEffect, useMemo, useState } from "react";
import { useScheduleStore } from "../stores/schedule";
import { formatDayLabel, formatTime } from "../utils/date";
import { alertLevelLabel } from "../utils/labels";
import { EmptyState } from "../components/EmptyState";
import { RefreshIcon } from "../components/Icons";

type Filter = "all" | "pending" | "sent";

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待发送" },
  { value: "sent", label: "已发送" },
];

export function AlertsPage() {
  const alerts = useScheduleStore((state) => state.alerts);
  const alertsLoading = useScheduleStore((state) => state.alertsLoading);
  const alertsError = useScheduleStore((state) => state.alertsError);
  const fetchAlerts = useScheduleStore((state) => state.fetchAlerts);

  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    void fetchAlerts();
  }, [fetchAlerts]);

  const pendingCount = useMemo(() => alerts.filter((alert) => !alert.sentAt).length, [alerts]);
  const sentCount = alerts.length - pendingCount;

  const visible = useMemo(() => {
    if (filter === "pending") {
      return alerts.filter((alert) => !alert.sentAt);
    }
    if (filter === "sent") {
      return alerts.filter((alert) => Boolean(alert.sentAt));
    }
    return alerts;
  }, [alerts, filter]);

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">ALERTS</p>
          <h1>提醒</h1>
          <p className="page-subtitle">
            待发送 {pendingCount} 条 · 已发送 {sentCount} 条
            <span className="live-tag">
              <span className="pulse" aria-hidden="true" />
              实时推送
            </span>
          </p>
        </div>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void fetchAlerts()}
          disabled={alertsLoading}
        >
          <RefreshIcon className={alertsLoading ? "spin" : undefined} />
          {alertsLoading ? "刷新中…" : "刷新"}
        </button>
      </header>

      {alertsError ? (
        <p className="notice notice--error" role="alert">
          {alertsError}
        </p>
      ) : null}

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="筛选提醒">
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
        <span className="toolbar__hint">收到新提醒时会自动更新</span>
      </div>

      {alertsLoading && alerts.length === 0 ? (
        <div className="alert-list" aria-hidden="true">
          <div className="skeleton skeleton--alert" />
          <div className="skeleton skeleton--alert" />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          title="这里还没有提醒"
          description={
            filter === "pending"
              ? "没有待发送的提醒，说明一切都还从容。"
              : filter === "sent"
                ? "还没有已发送的提醒记录。"
                : "给日程设置截止时间后，到点提醒会出现在这里。"
          }
        />
      ) : (
        <div className="alert-list">
          {visible.map((alert) => (
            <article key={alert.id} className={`alert-card${alert.sentAt ? " is-sent" : ""}`}>
              <span className={`alert-level alert-level--${alert.level}`}>
                {alertLevelLabel(alert.level)}
              </span>
              <div className="alert-main">
                <div className="alert-head">
                  <h3>{alert.title || "日程提醒"}</h3>
                  <span
                    className={`status-pill ${
                      alert.sentAt ? "status-pill--done" : "status-pill--pending"
                    }`}
                  >
                    {alert.sentAt ? "已发送" : "待发送"}
                  </span>
                </div>
                {alert.body ? <p>{alert.body}</p> : null}
                <div className="alert-meta">
                  <span>
                    计划 {formatDayLabel(alert.at)} {formatTime(alert.at)}
                  </span>
                  {alert.scheduleId ? <span>日程 #{alert.scheduleId}</span> : null}
                  {alert.sentAt ? (
                    <span className="alert-sent-at">
                      发送于 {formatDayLabel(alert.sentAt)} {formatTime(alert.sentAt)}
                    </span>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
