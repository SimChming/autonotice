import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { AdminOverviewResponse } from "@autonotice/shared";
import { RefreshIcon } from "../../components/Icons";
import { AdminNotice, AdminPageHead } from "../AdminKit";
import type { AdminOutletContext } from "../AdminLayout";
import { adminApi, adminErrorMessage } from "../api";

function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) {
    return `${days} 天 ${hours} 小时`;
  }
  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分`;
  }
  return `${minutes} 分钟`;
}

interface StatCard {
  label: string;
  value: string;
  hint: string;
}

export function AdminOverviewPage() {
  const { notify } = useOutletContext<AdminOutletContext>();
  const [data, setData] = useState<AdminOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await adminApi.overview());
    } catch (loadError) {
      setError(adminErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => {
    void load();
    notify("正在刷新概览", "数据会即时更新。");
  };

  const stats: StatCard[] = data
    ? [
        { label: "用户", value: String(data.users), hint: "已注册账号总数" },
        { label: "绑定", value: String(data.bindings), hint: "已完成 QQ 绑定" },
        { label: "日程", value: String(data.schedules), hint: "全部日程条目" },
        { label: "消息", value: String(data.messages), hint: "机器人已收录消息" },
        { label: "技能", value: String(data.skills), hint: "含内置技能" },
        {
          label: "OneBot",
          value: data.onebotConnected ? "在线" : "离线",
          hint: data.onebotConnected ? "WebSocket 已连接" : "等待机器人接入",
        },
        { label: "运行时长", value: formatUptime(data.uptime), hint: `服务版本 v${data.version}` },
      ]
    : [];

  return (
    <>
      <AdminPageHead
        eyebrow="OVERVIEW"
        title="运行概览"
        subtitle="查看服务在线状态、数据规模与当前运行时信息。"
        actions={
          <button type="button" className="btn btn--ghost btn--sm" onClick={refresh} disabled={loading}>
            <RefreshIcon />
            刷新
          </button>
        }
      />

      {error ? <AdminNotice>{error}</AdminNotice> : null}

      {loading && !data ? (
        <div className="admin-stat-grid" aria-label="正在加载概览">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : null}

      {data ? (
        <>
          <section className="admin-stat-grid" aria-label="服务统计">
            {stats.map((stat) => (
              <article
                key={stat.label}
                className={`admin-stat${
                  stat.label === "OneBot" ? (data.onebotConnected ? " is-online" : " is-offline") : ""
                }`}
              >
                <span className="admin-stat__label">{stat.label}</span>
                <strong className="admin-stat__value">{stat.value}</strong>
                <span className="admin-stat__hint">{stat.hint}</span>
              </article>
            ))}
          </section>

          <div className="admin-split">
            <section className="panel" aria-labelledby="admin-overview-connection">
              <h2 id="admin-overview-connection">连接状态</h2>
              <div className="admin-status-row">
                <span
                  className={`status-dot${data.onebotConnected ? "" : " status-dot--idle"}`}
                  aria-hidden="true"
                />
                <div>
                  <strong>{data.onebotConnected ? "OneBot 已连接" : "OneBot 未连接"}</strong>
                  <span>
                    {data.onebotConnected
                      ? "机器人正在接收群消息，日程抽取链路可用。"
                      : "请检查 OneBot WebSocket 配置与反向连接状态。"}
                  </span>
                </div>
              </div>
            </section>

            <section className="panel" aria-labelledby="admin-overview-runtime">
              <h2 id="admin-overview-runtime">运行时</h2>
              <dl className="admin-facts">
                <div>
                  <dt>服务版本</dt>
                  <dd>v{data.version}</dd>
                </div>
                <div>
                  <dt>已运行</dt>
                  <dd>{formatUptime(data.uptime)}</dd>
                </div>
                <div>
                  <dt>技能总数</dt>
                  <dd>{data.skills}</dd>
                </div>
                <div>
                  <dt>用户总数</dt>
                  <dd>{data.users}</dd>
                </div>
              </dl>
            </section>
          </div>
        </>
      ) : null}
    </>
  );
}
