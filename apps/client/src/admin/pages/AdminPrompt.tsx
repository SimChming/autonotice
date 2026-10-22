import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { AdminMemory, AdminPromptResponse } from "@autonotice/shared";
import { AdminNotice, AdminPageHead, AdminTag } from "../AdminKit";
import type { AdminOutletContext } from "../AdminLayout";
import { adminApi, adminErrorMessage } from "../api";
import { RefreshIcon, TrashIcon } from "../../components/Icons";
import { formatDateTime } from "../../utils/date";

/** 后台：查看/编辑初始 prompt 与记忆，保存后下一条消息立即生效。 */
export function AdminPromptPage() {
  const { notify } = useOutletContext<AdminOutletContext>();

  const [data, setData] = useState<AdminPromptResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editTags, setEditTags] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await adminApi.getPrompt();
      setData(response);
      setDraft(response.overridePrompt);
    } catch (loadError) {
      setError(adminErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const applyResponse = (response: AdminPromptResponse) => {
    setData(response);
    setDraft(response.overridePrompt);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await adminApi.updatePrompt(draft);
      applyResponse(response);
      notify("提示词已保存", "下一条机器人回复立即生效");
    } catch (saveError) {
      setError(adminErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!window.confirm("清空覆盖 prompt，恢复为代码内置的默认人格？")) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await adminApi.updatePrompt("");
      applyResponse(response);
      notify("已恢复默认 prompt", "覆盖值已清空");
    } catch (resetError) {
      setError(adminErrorMessage(resetError));
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (memory: AdminMemory) => {
    setEditingId(memory.id);
    setEditContent(memory.content);
    setEditTags(memory.tags.join(", "));
  };

  const handleSaveMemory = async (id: number) => {
    const content = editContent.trim();
    if (!content) {
      setError("记忆内容不能为空");
      return;
    }
    const tags = editTags
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 10);
    setBusyId(id);
    setError(null);
    try {
      await adminApi.updateMemory(id, { content, tags });
      setEditingId(null);
      await load();
      notify("记忆已更新", "向量会在下次召回时使用新内容");
    } catch (saveError) {
      setError(adminErrorMessage(saveError));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteMemory = async (memory: AdminMemory) => {
    if (!window.confirm(`删除记忆「${memory.content.slice(0, 30)}…」？`)) {
      return;
    }
    setBusyId(memory.id);
    setError(null);
    try {
      await adminApi.deleteMemory(memory.id);
      setData((current) =>
        current
          ? {
              ...current,
              items: current.items.filter((item) => item.id !== memory.id),
              memoryCount: Math.max(0, current.memoryCount - 1),
            }
          : current,
      );
      notify("记忆已删除");
    } catch (deleteError) {
      setError(adminErrorMessage(deleteError));
    } finally {
      setBusyId(null);
    }
  };

  const hasOverride = (data?.overridePrompt ?? "").trim().length > 0;

  return (
    <>
      <AdminPageHead
        eyebrow="PROMPT & MEMORY"
        title="初始 Prompt 与记忆"
        subtitle="展示当前人格的默认 prompt 和机器人记忆；覆盖编辑后保存，下一条消息立即生效。"
        actions={
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()}>
            <RefreshIcon />
            刷新
          </button>
        }
      />

      {error ? <AdminNotice tone="error">{error}</AdminNotice> : null}

      <section className="panel">
        <div className="panel-head">
          <h2>初始 Prompt</h2>
          <p>
            当前人格：<AdminTag tone="accent">{data?.personaName ?? "加载中…"}</AdminTag>
            {hasOverride ? <AdminTag tone="owner">使用覆盖值</AdminTag> : <AdminTag>使用默认值</AdminTag>}
          </p>
        </div>

        {loading && !data ? (
          <div className="skeleton" />
        ) : (
          <>
            <div className="field admin-prompt-editor">
              <label htmlFor="admin-prompt-override">覆盖 Prompt（留空 = 使用下面的默认值）</label>
              <textarea
                id="admin-prompt-override"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={20000}
                placeholder="留空则使用默认人格 prompt；填写后整段替换默认人格（仍会自动附加 JSON 输出契约）。"
                spellCheck={false}
              />
              <span className="field__hint">
                保存后不需要重启；机器人下一条回复立即使用新 prompt。长度上限 20000 字符。
              </span>
            </div>

            <div className="admin-head-actions">
              <button type="button" className="btn btn--primary" onClick={() => void handleSave()} disabled={saving}>
                {saving ? <span className="spinner" aria-hidden="true" /> : null}
                {saving ? "保存中…" : "保存并生效"}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => void handleReset()} disabled={saving}>
                恢复默认
              </button>
            </div>

            <details className="admin-prompt-default">
              <summary>查看默认 prompt（{data?.personaId ?? "-"}）</summary>
              <pre>{data?.defaultPrompt ?? ""}</pre>
            </details>
          </>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>记忆库</h2>
          <p>
            共 {data?.memoryCount ?? 0} 条，展示最近 {data?.items.length ?? 0} 条。编辑内容会重新计算 embedding。
          </p>
        </div>

        {data && data.items.length > 0 ? (
          <div className="admin-memory-list">
            {data.items.map((memory) => (
              <article className="admin-memory-item" key={memory.id}>
                <div className="admin-memory-meta">
                  <AdminTag>{memory.sessionKey}</AdminTag>
                  <span>QQ {memory.senderQq ?? "—"}</span>
                  <span>{formatDateTime(memory.createdAt)}</span>
                  {memory.tags.map((tag) => (
                    <AdminTag key={tag} tone="accent">
                      #{tag}
                    </AdminTag>
                  ))}
                </div>

                {editingId === memory.id ? (
                  <>
                    <div className="field">
                      <label htmlFor={`memory-content-${memory.id}`}>记忆内容</label>
                      <textarea
                        id={`memory-content-${memory.id}`}
                        value={editContent}
                        onChange={(event) => setEditContent(event.target.value)}
                        maxLength={500}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`memory-tags-${memory.id}`}>标签（逗号分隔）</label>
                      <input
                        id={`memory-tags-${memory.id}`}
                        value={editTags}
                        onChange={(event) => setEditTags(event.target.value)}
                      />
                    </div>
                    <div className="admin-memory-actions">
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() => void handleSaveMemory(memory.id)}
                        disabled={busyId === memory.id}
                      >
                        {busyId === memory.id ? "保存中…" : "保存记忆"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setEditingId(null)}
                        disabled={busyId === memory.id}
                      >
                        取消
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p>{memory.content}</p>
                    <div className="admin-memory-actions">
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => startEdit(memory)}>
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => void handleDeleteMemory(memory)}
                        disabled={busyId === memory.id}
                      >
                        <TrashIcon />
                        {busyId === memory.id ? "删除中…" : "删除"}
                      </button>
                    </div>
                  </>
                )}
              </article>
            ))}
          </div>
        ) : (
          <p className="panel-note">{loading ? "正在加载记忆…" : "还没有记忆；聊天中提到的喜好与约定会自动写入。"}</p>
        )}
      </section>
    </>
  );
}
