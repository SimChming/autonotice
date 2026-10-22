import {
  adminLoginResponseSchema,
  adminOverviewResponseSchema,
  adminSettingsResponseSchema,
  adminUserListResponseSchema,
  skillListResponseSchema,
  skillManifestSchema,
  type AdminLoginRequest,
  type AdminOverviewResponse,
  type AdminSettingsUpdate,
  type CreateSkillRequest,
  type SkillManifest,
  type UpdateSkillRequest,
} from "@autonotice/shared";
import { ApiError } from "../services/api";

/** 管理员会话与普通用户会话完全隔离，使用独立存储键。 */
export const ADMIN_TOKEN_KEY = "autonotice_admin_token";
export const ADMIN_UNAUTHORIZED_EVENT = "autonotice:admin-unauthorized";

/** 共享包未导出设置响应类型，这里只描述服务端契约形状。 */
export interface AdminSettings {
  llm: {
    model: string;
    visionModel: string;
    embeddingModel: string;
    baseUrl: string;
    apiKeyMasked: string;
  };
}

export interface AdminUser {
  id: number;
  username: string;
  qq: string | null;
  role: "owner" | "user";
  verifiedAt: string | null;
  createdAt: string;
}

/** handlers 接口没有共享 schema，按约定形状做轻量校验。 */
export interface SkillHandlerInfo {
  id: string;
  description: string;
}

interface Parser<T> {
  parse(input: unknown): T;
}

interface RawOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** 传 null 表示匿名请求（登录），undefined 表示读取本地管理员 token。 */
  token?: string | null;
}

function safeStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getAdminToken(): string | null {
  try {
    return safeStorage()?.getItem(ADMIN_TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setAdminToken(token: string | null): void {
  const storage = safeStorage();
  if (!storage) {
    return;
  }
  try {
    if (token) {
      storage.setItem(ADMIN_TOKEN_KEY, token);
    } else {
      storage.removeItem(ADMIN_TOKEN_KEY);
    }
  } catch {
    // 隐私模式可能禁止写入，忽略即可。
  }
}

export function adminErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

function readErrorPayload(data: unknown): { code: string; message: string } | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.code === "string" && typeof record.message === "string") {
    return { code: record.code, message: record.message };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function rawRequest(path: string, options: RawOptions = {}): Promise<unknown> {
  const token = options.token === undefined ? getAdminToken() : options.token;
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("network_error", "无法连接服务器，请检查网络后重试", 0);
  }

  const data: unknown = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    // 管理员 token 失效（含权限不足）立即清空，回到登录页。
    if ((response.status === 401 || response.status === 403) && token) {
      setAdminToken(null);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(ADMIN_UNAUTHORIZED_EVENT));
      }
    }
    const payload = readErrorPayload(data);
    throw new ApiError(
      payload?.code ?? "http_error",
      payload?.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
    );
  }

  return data;
}

async function request<T>(path: string, schema: Parser<T>, options: RawOptions = {}): Promise<T> {
  const data = await rawRequest(path, options);
  try {
    return schema.parse(data);
  } catch {
    throw new ApiError("invalid_response", "服务端返回的数据格式异常", 0);
  }
}

function parseHandlers(data: unknown): SkillHandlerInfo[] {
  if (!isRecord(data) || !Array.isArray(data.items)) {
    throw new ApiError("invalid_response", "服务端返回的数据格式异常", 0);
  }
  return data.items.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.description !== "string") {
      throw new ApiError("invalid_response", "服务端返回的数据格式异常", 0);
    }
    return { id: item.id, description: item.description };
  });
}

const skillPath = (id: string) => `/admin/skills/${encodeURIComponent(id)}`;

export const adminApi = {
  login(input: AdminLoginRequest): Promise<{ token: string }> {
    return request("/admin/login", adminLoginResponseSchema, {
      method: "POST",
      body: input,
      token: null,
    });
  },

  overview(): Promise<AdminOverviewResponse> {
    return request("/admin/overview", adminOverviewResponseSchema);
  },

  listSkills(): Promise<{ items: SkillManifest[] }> {
    return request("/admin/skills", skillListResponseSchema);
  },

  async listHandlers(): Promise<SkillHandlerInfo[]> {
    return parseHandlers(await rawRequest("/admin/skills/handlers"));
  },

  createSkill(input: CreateSkillRequest): Promise<SkillManifest> {
    return request("/admin/skills", skillManifestSchema, { method: "POST", body: input });
  },

  updateSkill(id: string, patch: UpdateSkillRequest): Promise<SkillManifest> {
    return request(skillPath(id), skillManifestSchema, { method: "PATCH", body: patch });
  },

  async deleteSkill(id: string): Promise<void> {
    await rawRequest(skillPath(id), { method: "DELETE" });
  },

  async getSettings(): Promise<AdminSettings> {
    return (await request("/admin/settings", adminSettingsResponseSchema)) as AdminSettings;
  },

  async updateSettings(patch: AdminSettingsUpdate): Promise<AdminSettings> {
    return (await request("/admin/settings", adminSettingsResponseSchema, {
      method: "PUT",
      body: patch,
    })) as AdminSettings;
  },

  async listUsers(): Promise<AdminUser[]> {
    const data = await request("/admin/users", adminUserListResponseSchema);
    return data.items as AdminUser[];
  },

  async deleteUser(id: number): Promise<void> {
    await rawRequest(`/admin/users/${id}`, { method: "DELETE" });
  },
};
