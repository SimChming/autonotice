import { useCallback, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import type { AdminOpsResponse } from "@autonotice/shared";
import { CopyIcon, ExternalIcon, RefreshIcon, TerminalIcon } from "../../components/Icons";
import { AdminNotice, AdminPageHead, AdminTag } from "../AdminKit";
import type { AdminOutletContext } from "../AdminLayout";
import { adminApi, adminErrorMessage } from "../api";
import { API_BASE } from "../../services/api";
import { copyText } from "../../utils/clipboard";

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

/** 原生壳里 WebUI 需要绝对地址，Web 端可以直接用同源路径。 */
function napcatUrl(path: string): string {
  if (/^https?:\/\//i.test(API_BASE)) {
    return `${new URL(API_BASE).origin}${path}`;
  }
  return path;
}

/** 后台运维：NapCat 入口、OneBot 实时状态与 QQ 风控处理。 */
export function AdminOpsPage() {
  const { notify } = useOutletContext<AdminOutletContext>();
  const [data, setData] = useState<AdminOpsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
    }
    setError(null);
    try {
      setData(await adminApi.getOps());
    } catch (loadError) {
      setError(adminErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      void load(true);
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const copyToken = async () => {
    if (!data?.napcat.webuiToken) {
      return;
    }
    const ok = await copyText(data.napcat.webuiToken);
    if (!ok) {
      setError("复制失败，请手动选择 Token");
      return;
    }
    setCopied(true);
    notify("已复制 NapCat Token", "在 NapCat WebUI 登录页粘贴即可");
  };

  const webui = data ? napcatUrl(data.napcat.webuiPath) : "/webui/";

  return (
    <>
      <AdminPageHead
        eyebrow="OPERATIONS"
        title="NapCat / OneBot 运维"
        subtitle="查看机器人连接状态，打开 NapCat 面板处理 QQ 风控、重新登录与协议端配置。"
        actions={
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshIcon />
            刷新
          </button>
        }
      />

      {error ? <AdminNotice>{error}</AdminNotice> : null}

      {loading && !data ? (
        <div className="admin-split">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : null}

      {data ? (
        <>
          <div className="admin-split">
            <section className="panel" aria-labelledby="admin-onebot">
              <div className="admin-panel-head">
                <h2 id="admin-onebot">OneBot 连接</h2>
                <AdminTag tone={data.onebot.selfId ? "accent" : "default"}>
                  {data.service.onebotConnected ? "在线" : "离线"}
                </AdminTag>
              </div>
              <div className="admin-status-row">
                <span
                  className={`status-dot${data.service.onebotConnected ? "" : " status-dot--idle"}`}
                  aria-hidden="true"
                />
                <div>
                  <strong>
                    {data.onebot.nickname ?? "机器人"} {data.onebot.selfId ? `(${data.onebot.selfId})` : ""}
                  </strong>
                  <span>
                    {data.service.onebotConnected
                      ? "反向 WebSocket 已连接，群消息与指令链路正常。"
                      : "尚未连接；请在 NapCat 面板确认已登录并启用反向 WS。"}
                  </span>
                </div>
              </div>
              <dl className="admin-facts">
                <div>
                  <dt>机器人 QQ</dt>
                  <dd>{data.onebot.selfId ?? "—"}</dd>
                </div>
                <div>
                  <dt>昵称</dt>
                  <dd>{data.onebot.nickname ?? "—"}</dd>
                </div>
                <div>
                  <dt>协议端版本</dt>
                  <dd>{data.onebot.appVersion ?? "—"}</dd>
                </div>
                <div>
                  <dt>协议版本</dt>
                  <dd>{data.onebot.protocolVersion ?? "—"}</dd>
                </div>
              </dl>
            </section>

            <section className="panel" aria-labelledby="admin-napcat">
              <div className="admin-panel-head">
                <h2 id="admin-napcat">NapCat 面板</h2>
                <AdminTag tone="builtin">入口</AdminTag>
              </div>
              <p className="panel-note">
                已通过 8080 反向代理到 <code>/webui/</code>，无需额外开放 6099 端口。
              </p>
              <dl className="admin-facts">
                <div>
                  <dt>Bot 账号</dt>
                  <dd>{data.napcat.account}</dd>
                </div>
                <div>
                  <dt>容器</dt>
                  <dd>{data.napcat.container}</dd>
                </div>
                <div>
                  <dt>服务版本</dt>
                  <dd>v{data.service.version}</dd>
                </div>
                <div>
                  <dt>运行时长</dt>
                  <dd>{formatUptime(data.service.uptime)}</dd>
                </div>
              </dl>
              <div className="admin-ops-token">
                <div>
                  <span>WebUI Token</span>
                  <code>{data.napcat.webuiToken || "未读取到 webui.json"}</code>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void copyToken()}
                  disabled={!data.napcat.webuiToken}
                >
                  <CopyIcon />
                  {copied ? "已复制" : "复制"}
                </button>
              </div>
              <div className="admin-ops-actions">
                <a className="btn btn--primary btn--sm" href={webui} target="_blank" rel="noreferrer">
                  <ExternalIcon />
                  打开 NapCat 面板
                </a>
                <Link className="btn btn--ghost btn--sm" to="/admin/shell">
                  <TerminalIcon />
                  前往 Shell
                </Link>
              </div>
            </section>
          </div>

          {!data.service.onebotConnected ? (
            <section className="panel" aria-labelledby="admin-qr">
              <div className="admin-panel-head">
                <h2 id="admin-qr">扫码重新登录</h2>
                <AdminTag tone={data.napcat.qrUpdatedAt ? "accent" : "default"}>
                  {data.napcat.qrUpdatedAt ? "二维码已就绪" : "等待二维码"}
                </AdminTag>
              </div>
              {data.napcat.qrImage ? (
                <>
                  <img
                    className="admin-qr"
                    src={`data:image/png;base64,${data.napcat.qrImage}`}
                    alt="NapCat 登录二维码"
                  />
                  <p className="panel-note">
                    用手机 QQ（账号 {data.napcat.account}）扫码授权。二维码约每 2 分钟自动刷新，
                    本页每 20 秒同步一次。
                  </p>
                </>
              ) : (
                <p className="panel-note">
                  暂未读到登录二维码。NapCat 可能正在重建登录服务，稍等片刻会自动出现。
                </p>
              )}
            </section>
          ) : null}

          <section className="panel" aria-labelledby="admin-ops-runbook">
            <h2 id="admin-ops-runbook">QQ 误封 / 掉线处理</h2>
            <ol className="admin-ops-steps">
              <li>打开 NapCat 面板，用上面的 Token 登录。</li>
              <li>在「账号」页重新扫码登录；若提示风控，先停止登录冷却一段时间。</li>
              <li>确认反向 WebSocket 指向 <code>ws://server:8080/onebot/v11/ws</code> 并已启用。</li>
              <li>需要重启容器时，在 Shell 执行 <code>docker restart autonotice-napcat</code>。</li>
            </ol>
          </section>
        </>
      ) : null}
    </>
  );
}
