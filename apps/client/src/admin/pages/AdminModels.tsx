import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useOutletContext } from "react-router-dom";
import type { AdminSettingsUpdate } from "@autonotice/shared";
import { RefreshIcon } from "../../components/Icons";
import { AdminNotice, AdminPageHead } from "../AdminKit";
import type { AdminOutletContext } from "../AdminLayout";
import { adminApi, adminErrorMessage, type AdminSettings } from "../api";

interface SettingsForm {
  model: string;
  visionModel: string;
  embeddingModel: string;
  baseUrl: string;
  apiKey: string;
}

function toFormState(settings: AdminSettings): SettingsForm {
  return {
    model: settings.llm.model,
    visionModel: settings.llm.visionModel,
    embeddingModel: settings.llm.embeddingModel,
    baseUrl: settings.llm.baseUrl,
    apiKey: "",
  };
}

export function AdminModelsPage() {
  const { notify } = useOutletContext<AdminOutletContext>();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [form, setForm] = useState<SettingsForm>({
    model: "",
    visionModel: "",
    embeddingModel: "",
    baseUrl: "",
    apiKey: "",
  });
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

  useEffect(() => {
    void load();
  }, [load]);

  const update = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const payload: AdminSettingsUpdate = {};
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
    const apiKey = form.apiKey.trim();
    // 掩码值（含 *）不回传；留空则服务端保留旧密钥。
    if (apiKey && !apiKey.includes("*")) {
      payload.apiKey = apiKey;
    }

    if (Object.keys(payload).length === 0) {
      notify("没有可保存的修改", "请填写需要更新的字段后再保存。", "warn");
      return;
    }

    setSaving(true);
    try {
      const next = await adminApi.updateSettings(payload);
      setSettings(next);
      setForm(toFormState(next));
      notify("模型设置已保存", "新的模型配置已即时生效。");
    } catch (saveError) {
      setError(adminErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <AdminPageHead
        eyebrow="MODELS"
        title="模型设置"
        subtitle="配置大语言模型、视觉模型、向量模型与 OpenAI 兼容网关。"
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
            <h2 id="admin-models-form">LLM 运行时</h2>
            <p>密钥只以掩码形式返回；不修改时请保持输入框为空。</p>
          </div>

          <form className="form" onSubmit={handleSubmit} aria-busy={saving} noValidate>
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
                <label htmlFor="llm-vision">视觉模型</label>
                <input
                  id="llm-vision"
                  value={form.visionModel}
                  onChange={(event) => update("visionModel", event.target.value)}
                  placeholder="例如 gpt-4o"
                  maxLength={120}
                />
              </div>
            </div>

            <div className="form-row">
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
          修改会写入服务端运行时设置，并立即影响后续消息处理。Base URL 必须包含协议与路径，
          例如 https://api.openai.com/v1。
        </p>
      </section>
    </>
  );
}
