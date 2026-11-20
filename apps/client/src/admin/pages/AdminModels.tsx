import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useOutletContext } from "react-router-dom";
import type { AdminLlmModel, AdminLlmModelsResponse, AdminSettingsUpdate } from "@autonotice/shared";
import { RefreshIcon } from "../../components/Icons";
import { AdminNotice, AdminPageHead } from "../AdminKit";
import type { AdminOutletContext } from "../AdminLayout";
import { adminApi, adminErrorMessage, type AdminSettings } from "../api";

interface SettingsForm {
  provider: "cloud" | "local";
  model: string;
  visionModel: string;
  embeddingModel: string;
  baseUrl: string;
  apiKey: string;
  localBaseUrl: string;
  localModel: string;
  groupLimit: string;
  ownerPrivateLimit: string;
  userPrivateLimit: string;
}

function toFormState(settings: AdminSettings): SettingsForm {
  return {
    provider: settings.llm.provider,
    model: settings.llm.model,
    visionModel: settings.llm.visionModel,
    embeddingModel: settings.llm.embeddingModel,
    baseUrl: settings.llm.baseUrl,
    apiKey: "",
    localBaseUrl: settings.llm.localBaseUrl,
    localModel: settings.llm.localModel,
    groupLimit: String(settings.reply.groupLimit),
    ownerPrivateLimit: String(settings.reply.ownerPrivateLimit),
    userPrivateLimit: String(settings.reply.userPrivateLimit),
  };
}

/** llama-server 的模型状态：unloaded 未加载 / loading 加载中 / loaded 已就绪 / sleeping 休眠。 */
function modelStatusLabel(status: string): string {
  switch (status) {
    case "loaded":
      return "已加载";
    case "loading":
      return "加载中";
    case "sleeping":
      return "休眠";
    case "unloaded":
      return "未加载";
    default:
      return status;
  }
}

function modelMetaLabel(model: AdminLlmModel): string {
  const parts = [modelStatusLabel(model.status)];
  if (typeof model.params === "number" && model.params > 0) {
    parts.push(`${(model.params / 1e9).toFixed(1)}B`);
  }
  if (typeof model.sizeBytes === "number" && model.sizeBytes > 0) {
    parts.push(`${(model.sizeBytes / 1024 ** 3).toFixed(1)}GB`);
  }
  return parts.join(" · ");
}

export function AdminModelsPage() {
  const { notify } = useOutletContext<AdminOutletContext>();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [form, setForm] = useState<SettingsForm>({
    provider: "cloud",
    model: "",
    visionModel: "",
    embeddingModel: "",
    baseUrl: "",
    apiKey: "",
    localBaseUrl: "",
    localModel: "",
    groupLimit: "8",
    ownerPrivateLimit: "0",
    userPrivateLimit: "8",
  });
  const [models, setModels] = useState<AdminLlmModelsResponse | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await adminApi.getSettings();
      setSettings(next);
      setForm(toFormState(next));
    } catch (loadError) {
      setError(adminErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  /** 本地模型列表来自 llama-server，失败只影响下拉框，不影响其余设置。 */
  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      setModels(await adminApi.getLlmModels());
    } catch (modelsError) {
      setModels({ provider: "local", reachable: false, models: [], error: adminErrorMessage(modelsError) });
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadModels();
  }, [load, loadModels]);

  const update = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (form.provider === "local" && !form.localModel.trim()) {
      notify("还差一个本地模型", "请先在列表里选择一个模型，再切换到本地模式。", "warn");
      return;
    }

    const payload: AdminSettingsUpdate = { provider: form.provider };
    if (form.model.trim()) {
      payload.model = form.model.trim();
    }
    if (form.visionModel.trim()) {
      payload.visionModel = form.visionModel.trim();
    }
    if (form.embeddingModel.trim()) {
      payload.embeddingModel = form.embeddingModel.trim();
    }
    if (form.baseUrl.trim()) {
      payload.baseUrl = form.baseUrl.trim();
    }
    if (form.localBaseUrl.trim()) {
      payload.localBaseUrl = form.localBaseUrl.trim();
    }
    payload.localModel = form.localModel.trim();
    const apiKey = form.apiKey.trim();
    // 掩码值（含 *）不回传；留空则服务端保留旧密钥。
    if (apiKey && !apiKey.includes("*")) {
      payload.apiKey = apiKey;
    }

    const groupLimit = Number(form.groupLimit);
    if (Number.isFinite(groupLimit)) {
      payload.groupLimit = Math.min(50, Math.max(1, Math.trunc(groupLimit)));
    }
    const ownerPrivateLimit = Number(form.ownerPrivateLimit);
    if (Number.isFinite(ownerPrivateLimit)) {
      payload.ownerPrivateLimit = Math.min(200, Math.max(0, Math.trunc(ownerPrivateLimit)));
    }
    const userPrivateLimit = Number(form.userPrivateLimit);
    if (Number.isFinite(userPrivateLimit)) {
      payload.userPrivateLimit = Math.min(50, Math.max(1, Math.trunc(userPrivateLimit)));
    }

    setSaving(true);
    try {
      const next = await adminApi.updateSettings(payload);
      setSettings(next);
      setForm(toFormState(next));
      notify(
        "模型设置已保存",
        next.llm.provider === "local" ? "后续对话将使用本地 llama.cpp 模型。" : "后续对话将使用云端 API。",
      );
    } catch (saveError) {
      setError(adminErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const activeProvider = settings?.llm.provider ?? "cloud";
  const selectedModel = models?.models.find((model) => model.id === form.localModel) ?? null;

  return (
    <>
      <AdminPageHead
        eyebrow="MODELS"
        title="模型设置"
        subtitle="在云端 API 与本机 llama.cpp 之间切换对话模型；视觉与向量仍走云端。"
        actions={
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()} disabled={loading}>
            <RefreshIcon />
            重新读取
          </button>
        }
      />

      {error ? <AdminNotice>{error}</AdminNotice> : null}

      {loading ? (
        <div className="admin-skill-list" aria-label="正在加载模型设置">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : null}

      {!loading ? (
        <section className="panel" aria-labelledby="admin-models-form">
          <div className="panel-head">
            <h2 id="admin-models-form">对话模型运行位置</h2>
            <p>
              当前生效：{activeProvider === "local" ? "本地 llama.cpp" : "云端 API"}。切换后立即生效，无需重启服务。
            </p>
          </div>

          <form className="form" onSubmit={handleSubmit} aria-busy={saving} noValidate>
            <div className="admin-form-actions" style={{ justifyContent: "flex-start" }}>
              <button
                type="button"
                className={`btn ${form.provider === "cloud" ? "btn--primary" : "btn--ghost"}`}
                aria-pressed={form.provider === "cloud"}
                onClick={() => update("provider", "cloud")}
              >
                云端 API
              </button>
              <button
                type="button"
                className={`btn ${form.provider === "local" ? "btn--primary" : "btn--ghost"}`}
                aria-pressed={form.provider === "local"}
                onClick={() => update("provider", "local")}
              >
                本地 llama.cpp
              </button>
            </div>

            {form.provider === "cloud" ? (
              <>
                <div className="form-row">
                  <div className="field">
                    <label htmlFor="llm-model">对话模型</label>
                    <input
                      id="llm-model"
                      value={form.model}
                      onChange={(event) => update("model", event.target.value)}
                      placeholder="例如 gpt-4o-mini"
                      maxLength={120}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="llm-base-url">Base URL</label>
                    <input
                      id="llm-base-url"
                      value={form.baseUrl}
                      onChange={(event) => update("baseUrl", event.target.value)}
                      placeholder="https://api.example.com/v1"
                    />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="llm-api-key">API Key</label>
                  <input
                    id="llm-api-key"
                    type="password"
                    value={form.apiKey}
                    onChange={(event) => update("apiKey", event.target.value)}
                    autoComplete="off"
                    placeholder={settings?.llm.apiKeyMasked || "未配置 API Key"}
                  />
                  <span className="field__hint">
                    留空表示保留现有密钥；服务端当前掩码：{settings?.llm.apiKeyMasked || "未配置"}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="llm-local-model">本地模型</label>
                  <select
                    id="llm-local-model"
                    value={form.localModel}
                    onChange={(event) => update("localModel", event.target.value)}
                  >
                    <option value="">请选择模型…</option>
                    {form.localModel && !selectedModel ? (
                      <option value={form.localModel}>{form.localModel}（已保存，当前列表未找到）</option>
                    ) : null}
                    {models?.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id} · {modelMetaLabel(model)}
                      </option>
                    ))}
                  </select>
                  <span className="field__hint">
                    {modelsLoading
                      ? "正在读取 llama-server 模型列表…"
                      : "列表来自本机 llama-server 的 /v1/models：在 presets.ini 中新增模型并重启 llama-server 后，点右侧按钮刷新即可。"}
                  </span>
                  <div className="admin-form-actions" style={{ justifyContent: "flex-start", marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => void loadModels()}
                      disabled={modelsLoading}
                    >
                      <RefreshIcon />
                      刷新模型
                    </button>
                    {selectedModel ? <span className="admin-tag admin-tag--accent">{modelMetaLabel(selectedModel)}</span> : null}
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="llm-local-base-url">本地 Base URL</label>
                  <input
                    id="llm-local-base-url"
                    value={form.localBaseUrl}
                    onChange={(event) => update("localBaseUrl", event.target.value)}
                    placeholder="http://host.docker.internal:18081/v1"
                  />
                  <span className="field__hint">
                    容器内访问宿主 llama-server 的桥接地址；llama.cpp 仍只监听 127.0.0.1，由宿主 socat 转发。
                  </span>
                </div>

                {models && !models.reachable ? (
                  <AdminNotice tone="info">
                    连不上本地 llama-server：{models.error || "未知错误"}。请确认宿主上的 llama-server 与桥接服务正在运行。
                  </AdminNotice>
                ) : null}
              </>
            )}

            <div className="form-row">
              <div className="field">
                <label htmlFor="llm-vision">视觉模型</label>
                <input
                  id="llm-vision"
                  value={form.visionModel}
                  onChange={(event) => update("visionModel", event.target.value)}
                  placeholder="例如 gpt-4o"
                  maxLength={120}
                />
              </div>
              <div className="field">
                <label htmlFor="llm-embedding">向量模型</label>
                <input
                  id="llm-embedding"
                  value={form.embeddingModel}
                  onChange={(event) => update("embeddingModel", event.target.value)}
                  placeholder="例如 text-embedding-3-small"
                  maxLength={120}
                />
              </div>
            </div>
            <span className="field__hint">视觉与向量始终使用云端配置，本地模式只影响对话。</span>

            <div className="form-row">
              <div className="field">
                <label htmlFor="reply-group">群聊单轮消息上限</label>
                <input
                  id="reply-group"
                  type="number"
                  min={1}
                  max={50}
                  value={form.groupLimit}
                  onChange={(event) => update("groupLimit", event.target.value)}
                />
                <span className="field__hint">群内一轮最多发几条，默认 8。</span>
              </div>
              <div className="field">
                <label htmlFor="reply-owner">主人私聊上限（0 = 不限）</label>
                <input
                  id="reply-owner"
                  type="number"
                  min={0}
                  max={200}
                  value={form.ownerPrivateLimit}
                  onChange={(event) => update("ownerPrivateLimit", event.target.value)}
                />
                <span className="field__hint">主人私聊可发到任务完成；0 表示不设上限。</span>
              </div>
            </div>

            <div className="field">
              <label htmlFor="reply-user">普通用户私聊上限</label>
              <input
                id="reply-user"
                type="number"
                min={1}
                max={50}
                value={form.userPrivateLimit}
                onChange={(event) => update("userPrivateLimit", event.target.value)}
              />
              <span className="field__hint">非主人私聊一轮最多发几条，默认 8。</span>
            </div>

            <div className="admin-form-actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  if (settings) {
                    setForm(toFormState(settings));
                    setError(null);
                  }
                }}
                disabled={saving}
              >
                重置
              </button>
              <button type="submit" className="btn btn--primary" disabled={saving}>
                {saving ? <span className="spinner" aria-hidden="true" /> : null}
                {saving ? "保存中…" : "保存设置"}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      <section className="panel">
        <h2>说明</h2>
        <p className="panel-note">
          本地模型列表由 llama-server 维护：修改 ~/models/presets.ini 新增 [模型名] 段并重启 llama-server 后，
          回到本页点「刷新模型」即可选择，无需改动代码。云端 Base URL 必须包含协议与路径，例如 https://api.openai.com/v1。
        </p>
      </section>
    </>
  );
}
