import {
  alertListResponseSchema,
  authResponseSchema,
  bindConfirmResponseSchema,
  bindStartResponseSchema,
  scheduleItemSchema,
  scheduleListResponseSchema,
  type AlertItem,
  type AuthResponse,
  type BindConfirmRequest,
  type BindConfirmResponse,
  type BindStartRequest,
  type BindStartResponse,
  type CreateScheduleRequest,
  type LoginRequest,
  type RegisterRequest,
  type ScheduleItem,
  type UpdateScheduleRequest,
} from "@autonotice/shared";

/** token 的唯一持久化位置。 */
export const TOKEN_KEY = "autonotice_token";
export const UNAUTHORIZED_EVENT = "autonotice:unauthorized";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

interface Parser<T> {
  parse(input: unknown): T;
}

interface RawRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
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

export function getStoredToken(): string | null {
  try {
    return safeStorage()?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function storeToken(token: string | null): void {
  const storage = safeStorage();
  if (!storage) {
    return;
  }
  try {
    if (token) {
      storage.setItem(TOKEN_KEY, token);
    } else {
      storage.removeItem(TOKEN_KEY);
    }
  } catch {
    // 隐私模式下 localStorage 可能不可写，忽略即可。
  }
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

async function rawRequest(path: string, options: RawRequestOptions = {}): Promise<unknown> {
  const { method = "GET", body, token = getStoredToken() } = options;
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("network_error", "无法连接服务器，请检查网络后重试", 0);
  }

  const data: unknown = response.status === 204 ? null : await response.json().catch(() => null);

  if (!response.ok) {
    if (response.status === 401 && token) {
      storeToken(null);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      }
    }
    const error = readErrorPayload(data);
    throw new ApiError(
      error?.code ?? "http_error",
      error?.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
    );
  }

  return data;
}

async function request<T>(path: string, schema: Parser<T>, options: RawRequestOptions = {}): Promise<T> {
  const data = await rawRequest(path, options);
  try {
    return schema.parse(data);
  } catch {
    throw new ApiError("invalid_response", "服务端返回的数据格式异常", 0);
  }
}

export const api = {
  register(input: RegisterRequest): Promise<AuthResponse> {
    return request("/auth/register", authResponseSchema, { method: "POST", body: input, token: null });
  },

  login(input: LoginRequest): Promise<AuthResponse> {
    return request("/auth/login", authResponseSchema, { method: "POST", body: input, token: null });
  },

  startBind(input: BindStartRequest): Promise<BindStartResponse> {
    return request("/bind/start", bindStartResponseSchema, { method: "POST", body: input });
  },

  confirmBind(input: BindConfirmRequest): Promise<BindConfirmResponse> {
    return request("/bind/confirm", bindConfirmResponseSchema, { method: "POST", body: input });
  },

  listSchedules(): Promise<{ items: ScheduleItem[] }> {
    return request("/schedules", scheduleListResponseSchema);
  },

  createSchedule(input: CreateScheduleRequest): Promise<ScheduleItem> {
    return request("/schedules", scheduleItemSchema, { method: "POST", body: input });
  },

  updateSchedule(id: number, patch: UpdateScheduleRequest): Promise<ScheduleItem> {
    return request(`/schedules/${id}`, scheduleItemSchema, { method: "PATCH", body: patch });
  },

  async deleteSchedule(id: number): Promise<void> {
    await rawRequest(`/schedules/${id}`, { method: "DELETE" });
  },

  listAlerts(): Promise<{ items: AlertItem[] }> {
    return request("/alerts", alertListResponseSchema);
  },
};

/** WS 只读推送地址，始终同源，不写死主机。 */
export function buildAlertSocketUrl(token: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/v1/ws?token=${encodeURIComponent(token)}`;
}
