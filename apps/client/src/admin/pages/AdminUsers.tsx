import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { AdminUserChatResponse, AdminUserDetailResponse } from "@autonotice/shared";
import { EmptyState } from "../../components/EmptyState";
import { RefreshIcon, TrashIcon } from "../../components/Icons";
import { Sheet } from "../../components/Sheet";
import { UserAvatar } from "../../components/UserAvatar";
import { formatDateTime } from "../../utils/date";
import { AdminNotice, AdminPageHead, AdminTag } from "../AdminKit";
import type { AdminOutletContext } from "../AdminLayout";
import { adminApi, adminErrorMessage, type AdminUser } from "../api";

const PLATFORM_LABEL: Record<string, string> = {
  android: "安卓",
  desktop: "桌面",
  web: "网页",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "未完成",
  done: "已完成",
  cancelled: "已取消",
};

function PresenceChips({ user }: { user: AdminUser }) {
  if (!user.presence.length) {
    return <span className="admin-muted">离线</span>;
  }
  return (
    <div className="admin-presence">
      {user.presence.map((item, index) => (
        <span className="admin-presence__item" key={`${item.platform}-${item.connectedAt}-${index}`}>
          <span className="status-dot" aria-hidden="true" />
          {PLATFORM_LABEL[item.platform] ?? item.platform}
          {item.version ? ` v${item.version}` : ""}
        </span>
      ))}
    </div>
  );
}

export function AdminUsersPage() {
  const { notify } = useOutletContext<AdminOutletContext>();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [notifyAll, setNotifyAll] = useState(false);
  const [notifyText, setNotifyText] = useState("");
  const [useAi, setUseAi] = useState(true);
  const [sending, setSending] = useState(false);

  const [detail, setDetail] = useState<AdminUserDetailResponse | null>(null);
  const [chatView, setChatView] = useState<{ user: AdminUser; data: AdminUserChatResponse } | null>(null);
  const [modalLoading, setModalLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await adminApi.listUsers());
    } catch (loadError) {
      setError(adminErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // 在线状态需要接近实时，后台每 20 秒自动刷新一次。
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const toggleUser = (id: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const removeUser = async (user: AdminUser) => {
    if (
      !window.confirm(
        `确认删除用户「${user.username}」（#${user.id}）？其 QQ 绑定与关联数据将一并移除，操作不可恢复。`,
      )
    ) {
      return;
    }
    setBusyId(user.id);
    try {
      await adminApi.deleteUser(user.id);
      setUsers((current) => current.filter((item) => item.id !== user.id));
      notify("用户已删除", `#${user.id} ${user.username}`);
    } catch (removeError) {
      notify("删除失败", adminErrorMessage(removeError), "warn");
    } finally {
      setBusyId(null);
    }
  };

  const openDetail = async (user: AdminUser) => {
    setModalLoading(true);
    try {
      setDetail(await adminApi.getUserDetail(user.id));
    } catch (detailError) {
      notify("读取用户详情失败", adminErrorMessage(detailError), "warn");
    } finally {
      setModalLoading(false);
    }
  };

  const openChat = async (user: AdminUser) => {
    setModalLoading(true);
    try {
      const data = await adminApi.getUserChat(user.id, 300);
      setChatView({ user, data });
    } catch (chatError) {
      notify("读取对话失败", adminErrorMessage(chatError), "warn");
    } finally {
      setModalLoading(false);
    }
  };

  const sendNotification = async () => {
    const text = notifyText.trim();
    if (!text) {
      notify("请填写通知内容", "输入要发给用户的文字后再发送。", "warn");
      return;
    }
    if (!notifyAll && selectedIds.size === 0) {
      notify("请选择接收用户", "在列表勾选用户，或勾选「全体用户」。", "warn");
      return;
    }
    setSending(true);
    try {
      const result = await adminApi.notifyUsers({
        text,
        useAi,
        all: notifyAll || undefined,
        userIds: notifyAll ? undefined : Array.from(selectedIds),
      });
      notify(
        "通知已发送",
        `成功 ${result.sent}，跳过 ${result.skipped}，失败 ${result.failed}`,
        result.failed ? "warn" : "info",
      );
      setNotifyText("");
      setSelectedIds(new Set());
      setNotifyAll(false);
    } catch (sendError) {
      notify("通知发送失败", adminErrorMessage(sendError), "warn");
    } finally {
      setSending(false);
    }
  };

  const allSelected = users.length > 0 && selectedIds.size === users.length;

  return (
    <>
      <AdminPageHead
        eyebrow="USERS"
        title="用户管理"
        subtitle="实时查看在线端与版本、日程完成情况与 AI 私聊内容，并可精准发送通知。"
        actions={
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()} disabled={loading}>
            <RefreshIcon />
            刷新
          </button>
        }
      />

      {error ? <AdminNotice>{error}</AdminNotice> : null}

      <section className="panel" aria-labelledby="admin-notify-title">
        <div className="panel-head">
          <h2 id="admin-notify-title">精准通知</h2>
          <p>可让 AI 以鲸鱼娘口吻转达，也可原样发送。仅发送给被勾选的用户或全体。</p>
        </div>
        <textarea
          className="admin-notify-input"
          value={notifyText}
          onChange={(event) => setNotifyText(event.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="例如：今晚 23:00 服务器维护，机器人会短暂离线，请提前保存日程。"
        />
        <div className="admin-notify-foot">
          <label className="admin-check">
            <input
              type="checkbox"
              checked={notifyAll}
              onChange={(event) => setNotifyAll(event.target.checked)}
            />
            全体用户
          </label>
          <label className="admin-check">
            <input type="checkbox" checked={useAi} onChange={(event) => setUseAi(event.target.checked)} />
            AI 润色措辞
          </label>
          <span className="admin-muted">
            已选 {notifyAll ? users.length : selectedIds.size} 人
          </span>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => void sendNotification()}
            disabled={sending}
          >
            {sending ? <span className="spinner" aria-hidden="true" /> : null}
            {sending ? "发送中…" : "发送通知"}
          </button>
        </div>
      </section>

      {loading ? (
        <div className="admin-skill-list" aria-label="正在加载用户">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : null}

      {!loading && !error && users.length === 0 ? (
        <EmptyState title="暂无用户" description="当有人注册并绑定 QQ 后，账号会出现在这里。" />
      ) : null}

      {!loading && users.length > 0 ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <caption className="admin-table__caption">
              共 {users.length} 个账号 · 在线 {users.filter((user) => user.presence.length > 0).length} 个
            </caption>
            <thead>
              <tr>
                <th scope="col">
                  <input
                    type="checkbox"
                    aria-label="全选用户"
                    checked={allSelected}
                    onChange={(event) =>
                      setSelectedIds(event.target.checked ? new Set(users.map((user) => user.id)) : new Set())
                    }
                  />
                </th>
                <th scope="col">用户</th>
                <th scope="col">在线端</th>
                <th scope="col">日程</th>
                <th scope="col">QQ</th>
                <th scope="col">角色</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td data-label="选择">
                    <input
                      type="checkbox"
                      aria-label={`选择 ${user.username}`}
                      checked={selectedIds.has(user.id)}
                      onChange={() => toggleUser(user.id)}
                    />
                  </td>
                  <td data-label="用户">
                    <div className="admin-user-name">
                      <UserAvatar qq={user.qq} name={user.username} />
                      <div>
                        <strong>{user.username}</strong>
                        <span>#{user.id}</span>
                      </div>
                    </div>
                  </td>
                  <td data-label="在线端">
                    <PresenceChips user={user} />
                  </td>
                  <td data-label="日程" className="admin-muted">
                    {user.schedulePending} / {user.scheduleTotal} 未完成
                  </td>
                  <td data-label="QQ" className="admin-mono">
                    {user.qq ?? "未绑定"}
                  </td>
                  <td data-label="角色">
                    <AdminTag tone={user.role === "owner" ? "owner" : "default"}>
                      {user.role === "owner" ? "主人" : "普通用户"}
                    </AdminTag>
                  </td>
                  <td data-label="操作">
                    <div className="admin-user-actions">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => void openDetail(user)}
                        disabled={modalLoading}
                      >
                        详情
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => void openChat(user)}
                        disabled={modalLoading || !user.qq}
                      >
                        AI 对话
                      </button>
                      <button
                        type="button"
                        className="icon-btn icon-btn--danger"
                        onClick={() => void removeUser(user)}
                        disabled={busyId === user.id}
                        aria-label={`删除用户 ${user.username}`}
                        title="删除用户"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {detail ? (
        <Sheet
          title={`${detail.user.username} 的状态`}
          subtitle={`#${detail.user.id} · ${detail.presence.length ? "在线" : "离线"}`}
          onClose={() => setDetail(null)}
        >
          <div className="admin-detail">
            <p className="admin-detail__label">在线端</p>
            {detail.presence.length ? (
              <ul className="admin-detail__presence">
                {detail.presence.map((item, index) => (
                  <li key={`${item.platform}-${item.connectedAt}-${index}`}>
                    <strong>{PLATFORM_LABEL[item.platform] ?? item.platform}</strong>
                    <span>界面 v{item.version || "?"}</span>
                    <span>安装包 {item.shellVersion ? `v${item.shellVersion}` : "—"}</span>
                    <span>连接于 {formatDateTime(new Date(item.connectedAt).toISOString())}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="panel-note">当前没有在线客户端。</p>
            )}

            <p className="admin-detail__label">绑定群聊</p>
            {detail.groups.length ? (
              <div className="admin-group-chips">
                {detail.groups.map((item) => (
                  <span className="admin-group-chip" key={item.groupId}>
                    {item.name || item.groupId}
                    <small>{item.groupId}</small>
                  </span>
                ))}
              </div>
            ) : (
              <p className="panel-note">尚未关联群聊。</p>
            )}

            <p className="admin-detail__label">日程明细（{detail.schedules.length}）</p>
            {detail.schedules.length ? (
              <div className="admin-detail__schedules">
                {detail.schedules.map((item) => (
                  <article key={item.id} className="admin-schedule-row">
                    <div>
                      <strong>{item.title}</strong>
                      <span>
                        {item.groupName || item.groupId || "无来源群"}
                        {item.dueAt ? ` · 截止 ${formatDateTime(item.dueAt)}` : ""}
                      </span>
                    </div>
                    <AdminTag tone={item.status === "pending" ? "default" : "accent"}>
                      {STATUS_LABEL[item.status] ?? item.status}
                    </AdminTag>
                  </article>
                ))}
              </div>
            ) : (
              <p className="panel-note">暂无日程。</p>
            )}
          </div>
        </Sheet>
      ) : null}

      {chatView ? (
        <Sheet
          title={`${chatView.user.username} 与 AI 的私聊`}
          subtitle="AI 视角，只读；其他用户不可见这些内容"
          onClose={() => setChatView(null)}
        >
          {chatView.data.items.length ? (
            <div className="admin-chatlog">
              {chatView.data.items.map((item, index) => (
                <div key={`${item.at}-${index}`} className={`admin-chatlog__item admin-chatlog__item--${item.role}`}>
                  <div className="admin-chatlog__meta">
                    <strong>{item.role === "assistant" ? "鲸鱼娘" : chatView.user.username}</strong>
                    <span>{formatDateTime(item.at)}</span>
                  </div>
                  <p>{item.text}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="panel-note">还没有私聊记录。</p>
          )}
        </Sheet>
      ) : null}
    </>
  );
}
