import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { EmptyState } from "../../components/EmptyState";
import { RefreshIcon, TrashIcon } from "../../components/Icons";
import { UserAvatar } from "../../components/UserAvatar";
import { formatDateTime } from "../../utils/date";
import { AdminNotice, AdminPageHead, AdminTag } from "../AdminKit";
import type { AdminOutletContext } from "../AdminLayout";
import { adminApi, adminErrorMessage, type AdminUser } from "../api";

export function AdminUsersPage() {
  const { notify } = useOutletContext<AdminOutletContext>();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

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
  }, [load]);

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

  return (
    <>
      <AdminPageHead
        eyebrow="USERS"
        title="用户管理"
        subtitle="查看注册账号、QQ 绑定状态与角色，并清理不再需要的账号。"
        actions={
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()} disabled={loading}>
            <RefreshIcon />
            刷新
          </button>
        }
      />

      {error ? <AdminNotice>{error}</AdminNotice> : null}

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
            <caption className="admin-table__caption">共 {users.length} 个账号</caption>
            <thead>
              <tr>
                <th scope="col">用户</th>
                <th scope="col">QQ</th>
                <th scope="col">角色</th>
                <th scope="col">绑定时间</th>
                <th scope="col">注册时间</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td data-label="用户">
                    <div className="admin-user-name">
                      <UserAvatar qq={user.qq} name={user.username} />
                      <div>
                        <strong>{user.username}</strong>
                        <span>#{user.id}</span>
                      </div>
                    </div>
                  </td>
                  <td data-label="QQ" className="admin-mono">
                    {user.qq ?? "未绑定"}
                  </td>
                  <td data-label="角色">
                    <AdminTag tone={user.role === "owner" ? "owner" : "default"}>
                      {user.role === "owner" ? "主人" : "普通用户"}
                    </AdminTag>
                  </td>
                  <td data-label="绑定时间" className="admin-muted">
                    {user.verifiedAt ? formatDateTime(user.verifiedAt) : "未验证"}
                  </td>
                  <td data-label="注册时间" className="admin-muted">
                    {formatDateTime(user.createdAt)}
                  </td>
                  <td data-label="操作">
                    <button
                      type="button"
                      className="icon-btn icon-btn--danger admin-user-delete"
                      onClick={() => void removeUser(user)}
                      disabled={busyId === user.id}
                      aria-label={`删除用户 ${user.username}`}
                      title="删除用户"
                    >
                      <TrashIcon />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
