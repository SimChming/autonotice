import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { GroupItem } from "@autonotice/shared";
import { api } from "../services/api";
import { formatDateTime } from "../utils/date";
import { GroupsIcon, TrashIcon } from "../components/Icons";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

/** 多群聊管理：一个 QQ 可以绑定多个群，日程按群记录来源。 */
export function GroupsPage() {
  const [items, setItems] = useState<GroupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [groupId, setGroupId] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { items: list } = await api.listGroups();
      setItems(list);
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = groupId.trim();
    if (!/^\d{5,12}$/.test(value)) {
      setError("请输入 5-12 位数字群号");
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const group = await api.bindGroup(value);
      setItems((current) => [
        ...current.filter((item) => item.groupId !== group.groupId),
        group,
      ]);
      setGroupId("");
    } catch (addError) {
      setError(messageOf(addError));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (target: GroupItem) => {
    if (!window.confirm(`不再从“${target.name || `群 ${target.groupId}`}”收集日程？`)) {
      return;
    }
    setRemoving(target.groupId);
    setError(null);
    try {
      await api.unbindGroup(target.groupId);
      setItems((current) => current.filter((item) => item.groupId !== target.groupId));
    } catch (removeError) {
      setError(messageOf(removeError));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">GROUPS</p>
          <h1>我的群聊</h1>
          <p className="page-subtitle">
            绑定后的 QQ 在哪个群发言，系统就会自动把那个群加入列表；也可以手动添加机器人所在的群。
          </p>
        </div>
      </header>

      {error ? (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <h2>添加群聊</h2>
          <p>填写群号，机器人必须已经加入该群，才能读取群名称并收集群里的日程。</p>
        </div>

        <form className="form" onSubmit={handleAdd} aria-busy={adding}>
          <div className="field">
            <label htmlFor="group-id">群号</label>
            <input
              id="group-id"
              value={groupId}
              onChange={(event) => setGroupId(event.target.value)}
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={12}
              placeholder="例如 1130297603"
              autoComplete="off"
            />
            <span className="field__hint">5-12 位数字；群名会自动从 QQ 群信息同步。</span>
          </div>
          <button type="submit" className="btn btn--primary" disabled={adding}>
            {adding ? <span className="spinner" aria-hidden="true" /> : <GroupsIcon />}
            {adding ? "添加中…" : "添加群聊"}
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>已绑定群聊</h2>
          <p>{loading ? "正在同步…" : `共 ${items.length} 个群 · 日程卡片会标注来源群名称`}</p>
        </div>

        {items.length === 0 && !loading ? (
          <p className="panel-note">还没有绑定群聊。先完成 QQ 绑定，或在上方手动添加。</p>
        ) : (
          <div className="group-list">
            {items.map((item) => (
              <div className="bind-state" key={item.groupId}>
                <div className="bind-state__main">
                  <img className="avatar" src={item.avatar} alt="" loading="lazy" />
                  <div>
                    <strong>{item.name || `群 ${item.groupId}`}</strong>
                    <span>
                      群号 {item.groupId}
                      {item.boundAt ? ` · 绑定于 ${formatDateTime(item.boundAt)}` : ""}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => void handleRemove(item)}
                  disabled={removing === item.groupId}
                >
                  <TrashIcon />
                  {removing === item.groupId ? "移除中…" : "移除"}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
