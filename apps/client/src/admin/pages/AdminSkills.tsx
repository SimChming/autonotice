import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useOutletContext } from "react-router-dom";
import type {
  CreateSkillRequest,
  SkillManifest,
  SkillPermission,
  SkillType,
  UpdateSkillRequest,
} from "@autonotice/shared";
import { EmptyState } from "../../components/EmptyState";
import { PlusIcon, TrashIcon } from "../../components/Icons";
import { Sheet } from "../../components/Sheet";
import { formatDateTime } from "../../utils/date";
import { AdminNotice, AdminPageHead, AdminSwitch, AdminTag } from "../AdminKit";
import type { AdminNotify, AdminOutletContext } from "../AdminLayout";
import {
  adminApi,
  adminErrorMessage,
  type SkillHandlerInfo,
} from "../api";

const TYPE_LABELS: Record<SkillType, string> = {
  persona: "人格",
  tool: "工具",
  instruction: "指令",
};

const PERMISSION_LABELS: Record<SkillPermission, string> = {
  all: "所有人",
  bound: "已绑定",
  owner: "仅主人",
};

const TYPE_OPTIONS: SkillType[] = ["persona", "tool", "instruction"];
const PERMISSION_OPTIONS: SkillPermission[] = ["all", "bound", "owner"];

interface SkillFormState {
  id: string;
  name: string;
  description: string;
  type: SkillType;
  enabled: boolean;
  prompt: string;
  handler: string;
  permissions: SkillPermission;
  paramsSchemaText: string;
  version: string;
}

function toFormState(skill?: SkillManifest): SkillFormState {
  return {
    id: skill?.id ?? "",
    name: skill?.name ?? "",
    description: skill?.description ?? "",
    type: skill?.type ?? "instruction",
    enabled: skill?.enabled ?? true,
    prompt: skill?.prompt ?? "",
    handler: skill?.handler ?? "",
    permissions: skill?.permissions ?? "all",
    paramsSchemaText: JSON.stringify(skill?.paramsSchema ?? {}, null, 2),
    version: skill?.version ?? "1.0.0",
  };
}

interface SkillEditorProps {
  mode: "create" | "edit";
  skill?: SkillManifest;
  handlers: SkillHandlerInfo[];
  notify: AdminNotify;
  onClose: () => void;
  onSaved: (skill: SkillManifest) => void;
}

function SkillEditor({ mode, skill, handlers, notify, onClose, onSaved }: SkillEditorProps) {
  const [form, setForm] = useState<SkillFormState>(() => toFormState(skill));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const builtin = skill?.builtin === true;

  const update = <K extends keyof SkillFormState>(key: K, value: SkillFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const id = form.id.trim();
    const name = form.name.trim();
    const description = form.description.trim();
    const prompt = form.prompt;
    const version = form.version.trim() || "1.0.0";

    if (mode === "create" && !/^[a-z0-9_.-]{2,48}$/.test(id)) {
      setError("id 需为 2-48 位小写字母、数字、下划线、点或短横线");
      return;
    }
    if (!name) {
      setError("请填写技能名称");
      return;
    }
    if (!description) {
      setError("请填写技能描述");
      return;
    }
    if (prompt.length > 4000) {
      setError("提示词不能超过 4000 个字符");
      return;
    }

    let paramsSchema: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(form.paramsSchemaText.trim() || "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      paramsSchema = parsed as Record<string, unknown>;
    } catch {
      setError("paramsSchema 必须是合法的 JSON 对象");
      return;
    }

    setSaving(true);
    try {
      if (mode === "create") {
        const payload: CreateSkillRequest = {
          id,
          name,
          description,
          type: form.type,
          enabled: form.enabled,
          prompt,
          handler: form.handler.trim() ? form.handler.trim() : null,
          permissions: form.permissions,
          paramsSchema,
          version,
        };
        const created = await adminApi.createSkill(payload);
        onSaved(created);
        notify("技能已创建", created.name);
      } else if (skill) {
        const patch: UpdateSkillRequest = {
          name,
          description,
          prompt,
          permissions: form.permissions,
          paramsSchema,
          version,
        };
        // 内置技能的类型与 handler 由服务端锁定，请求里也不能出现这两个字段。
        if (!builtin) {
          patch.type = form.type;
          patch.handler = form.handler.trim() ? form.handler.trim() : null;
        }
        const updated = await adminApi.updateSkill(skill.id, patch);
        onSaved(updated);
        notify("技能已保存", updated.name);
      }
      onClose();
    } catch (saveError) {
      setError(adminErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      title={mode === "create" ? "新增技能" : `编辑技能 · ${skill?.name ?? ""}`}
      subtitle={
        builtin
          ? "内置技能已锁定类型与 handler，仅可修改名称、描述、提示词等配置。"
          : "技能配置会立即写入运行时，停用后不再参与消息处理。"
      }
      onClose={onClose}
    >
      <form className="form admin-editor" onSubmit={handleSubmit} aria-busy={saving} noValidate>
        <div className="form-row">
          <div className="field">
            <label htmlFor="skill-id">技能 ID</label>
            <input
              id="skill-id"
              value={form.id}
              onChange={(event) => update("id", event.target.value)}
              readOnly={mode === "edit"}
              placeholder="例如 weather.query"
              maxLength={48}
            />
            <span className="field__hint">仅小写字母、数字、下划线、点和短横线。</span>
          </div>
          <div className="field">
            <label htmlFor="skill-name">名称</label>
            <input
              id="skill-name"
              value={form.name}
              onChange={(event) => update("name", event.target.value)}
              placeholder="展示名称"
              maxLength={60}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="skill-description">描述</label>
          <input
            id="skill-description"
            value={form.description}
            onChange={(event) => update("description", event.target.value)}
            placeholder="一句话说明技能用途"
            maxLength={300}
          />
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="skill-type">类型</label>
            <select
              id="skill-type"
              value={form.type}
              onChange={(event) => update("type", event.target.value as SkillType)}
              disabled={builtin}
            >
              {TYPE_OPTIONS.map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABELS[type]}（{type}）
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="skill-handler">Handler</label>
            <select
              id="skill-handler"
              value={form.handler}
              onChange={(event) => update("handler", event.target.value)}
              disabled={builtin}
            >
              <option value="">无 handler</option>
              {handlers.map((handler) => (
                <option key={handler.id} value={handler.id}>
                  {handler.id} — {handler.description}
                </option>
              ))}
            </select>
            {builtin ? (
              <span className="field__hint">内置技能的 type 与 handler 不可修改。</span>
            ) : null}
          </div>
        </div>

        <div className="form-row">
          <div className="field">
            <label htmlFor="skill-permissions">可见范围</label>
            <select
              id="skill-permissions"
              value={form.permissions}
              onChange={(event) =>
                update("permissions", event.target.value as SkillPermission)
              }
            >
              {PERMISSION_OPTIONS.map((permission) => (
                <option key={permission} value={permission}>
                  {PERMISSION_LABELS[permission]}（{permission}）
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="skill-version">版本</label>
            <input
              id="skill-version"
              value={form.version}
              onChange={(event) => update("version", event.target.value)}
              placeholder="1.0.0"
            />
          </div>
        </div>

        <div className="field">
          <span className="admin-field-label">启用状态</span>
          <AdminSwitch
            checked={form.enabled}
            label="启用状态"
            onChange={() => update("enabled", !form.enabled)}
          />
        </div>

        <div className="field">
          <label htmlFor="skill-prompt">提示词</label>
          <textarea
            id="skill-prompt"
            value={form.prompt}
            onChange={(event) => update("prompt", event.target.value)}
            placeholder="为该技能补充人设或执行规则"
            maxLength={4000}
          />
          <span className="field__hint">{form.prompt.length} / 4000</span>
        </div>

        <div className="field admin-code">
          <label htmlFor="skill-params">paramsSchema（JSON）</label>
          <textarea
            id="skill-params"
            value={form.paramsSchemaText}
            onChange={(event) => update("paramsSchemaText", event.target.value)}
            spellCheck={false}
          />
          <span className="field__hint">必须是 JSON 对象，例如 {"{ \"city\": \"string\" }"}。</span>
        </div>

        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="sheet__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn--primary" disabled={saving}>
            {saving ? <span className="spinner" aria-hidden="true" /> : null}
            {saving ? "保存中…" : mode === "create" ? "创建技能" : "保存修改"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export function AdminSkillsPage() {
  const { notify } = useOutletContext<AdminOutletContext>();
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [handlers, setHandlers] = useState<SkillHandlerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SkillManifest | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [skillList, handlerList] = await Promise.all([
        adminApi.listSkills(),
        adminApi.listHandlers(),
      ]);
      setSkills(skillList.items);
      setHandlers(handlerList);
    } catch (loadError) {
      setError(adminErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upsertSkill = (next: SkillManifest) => {
    setSkills((current) =>
      current.some((item) => item.id === next.id)
        ? current.map((item) => (item.id === next.id ? next : item))
        : [...current, next],
    );
  };

  const toggleSkill = async (skill: SkillManifest) => {
    setBusyId(skill.id);
    try {
      const updated = await adminApi.updateSkill(skill.id, { enabled: !skill.enabled });
      upsertSkill(updated);
      notify(updated.enabled ? "技能已启用" : "技能已停用", updated.name);
    } catch (toggleError) {
      notify("操作失败", adminErrorMessage(toggleError), "warn");
    } finally {
      setBusyId(null);
    }
  };

  const removeSkill = async (skill: SkillManifest) => {
    if (skill.builtin) {
      notify("无法删除内置技能", "内置技能只能停用，不能删除。", "warn");
      return;
    }
    if (!window.confirm(`确认删除技能「${skill.name}」？此操作不可恢复。`)) {
      return;
    }
    setBusyId(skill.id);
    try {
      await adminApi.deleteSkill(skill.id);
      setSkills((current) => current.filter((item) => item.id !== skill.id));
      notify("技能已删除", skill.name);
    } catch (removeError) {
      notify("删除失败", adminErrorMessage(removeError), "warn");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <AdminPageHead
        eyebrow="SKILLS"
        title="技能管理"
        subtitle="启停、编辑或创建机器人技能；内置技能只允许停用与调整提示词。"
        actions={
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>
            <PlusIcon />
            新增技能
          </button>
        }
      />

      {error ? <AdminNotice>{error}</AdminNotice> : null}

      {loading ? (
        <div className="admin-skill-list" aria-label="正在加载技能">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : null}

      {!loading && !error && skills.length === 0 ? (
        <EmptyState
          title="还没有技能"
          description="创建第一个技能，让机器人在群消息里理解并执行你的指令。"
          action={
            <button type="button" className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>
              <PlusIcon />
              新增技能
            </button>
          }
        />
      ) : null}

      {!loading && skills.length > 0 ? (
        <div className="admin-skill-list">
          {skills.map((skill) => (
            <article key={skill.id} className="admin-skill">
              <div className="admin-skill__head">
                <div className="admin-skill__title">
                  <h2>{skill.name}</h2>
                  <code className="admin-skill__id">{skill.id}</code>
                  <AdminTag tone="accent">{TYPE_LABELS[skill.type]}</AdminTag>
                  {skill.builtin ? <AdminTag tone="builtin">内置</AdminTag> : null}
                </div>
                <AdminSwitch
                  checked={skill.enabled}
                  label={`${skill.enabled ? "停用" : "启用"}技能 ${skill.name}`}
                  disabled={busyId === skill.id}
                  onChange={() => void toggleSkill(skill)}
                />
              </div>

              <p className="admin-skill__desc">{skill.description}</p>

              {skill.prompt ? <p className="admin-skill__prompt">{skill.prompt}</p> : null}

              <dl className="admin-skill__meta">
                <div>
                  <dt>handler</dt>
                  <dd>{skill.handler ?? "无"}</dd>
                </div>
                <div>
                  <dt>可见范围</dt>
                  <dd>{PERMISSION_LABELS[skill.permissions]}</dd>
                </div>
                <div>
                  <dt>版本</dt>
                  <dd>{skill.version}</dd>
                </div>
                <div>
                  <dt>更新于</dt>
                  <dd>{formatDateTime(skill.updatedAt)}</dd>
                </div>
              </dl>

              <div className="admin-skill__actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setEditing(skill)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="btn btn--danger btn--sm"
                  onClick={() => void removeSkill(skill)}
                  disabled={skill.builtin || busyId === skill.id}
                  title={skill.builtin ? "内置技能不可删除，只能停用" : undefined}
                >
                  <TrashIcon />
                  删除
                </button>
              </div>

              {skill.builtin ? (
                <p className="admin-skill__lock">内置技能：不可删除，且类型与 handler 已锁定。</p>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}

      {creating ? (
        <SkillEditor
          mode="create"
          handlers={handlers}
          notify={notify}
          onClose={() => setCreating(false)}
          onSaved={upsertSkill}
        />
      ) : null}

      {editing ? (
        <SkillEditor
          mode="edit"
          skill={editing}
          handlers={handlers}
          notify={notify}
          onClose={() => setEditing(null)}
          onSaved={upsertSkill}
        />
      ) : null}
    </>
  );
}
