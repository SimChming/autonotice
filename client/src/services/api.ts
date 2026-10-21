import Taro from '@tarojs/taro'

import type {
  AdminAuditEntry,
  AdminDocFile,
  AdminLoginResult,
  AdminOwner,
  AdminSettings,
  AdminStatus,
  AdminUser,
  Alert,
  ApiErrorShape,
  AuthResult,
  BindCode,
  Binding,
  DeltaResult,
  LatestReplan,
  ReplanEvent,
  ScheduleDoc,
  ScheduleItem,
  SyncMutation,
  SyncResult
} from '../types'
import { KEYS, getRaw } from '../utils/storage'
import { silentRelogin, useAuthStore } from '../store/auth'

// H5 通过同源相对路径访问内嵌 server；若被显式覆盖（TARO_APP_API_BASE）
// 则优先用显式值，用于桌面端打包或本地联调。
const DEFAULT_BASE = '/api/v1'

function normalizeBase(raw?: string): string {
  if (!raw) return DEFAULT_BASE
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return DEFAULT_BASE
  // 绝对路径开头且已带版本尾 → 原样返回（例如 TARO_APP_API_BASE=/api/v1）
  if (trimmed.startsWith('/') && /\/api\/v\d+$/.test(trimmed)) return trimmed
  // 完整 URL 或域名：补 /api/v1 尾
  return /\/api\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/api/v1`
}

/** 服务端 REST 基地址；打包时可用 TARO_APP_API_BASE 覆盖 */
export const API_BASE = normalizeBase(process.env.TARO_APP_API_BASE)

const TIMEOUT_MS = 20000
const SYNC_TIMEOUT_MS = 30000

export class ApiError extends Error {
  status: number
  code?: string
  conflict?: ScheduleItem

  constructor(shape: ApiErrorShape) {
    super(shape.message)
    this.name = 'ApiError'
    this.status = shape.status
    this.code = shape.code
    this.conflict = shape.conflict
  }
}

/** 网络层失败（断网/超时/DNS）—— 用于判断是否应进入离线队列 */
export function isNetworkError(err: unknown): boolean {
  return err instanceof ApiError ? err.status === 0 : true
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  /** ETag 缓存键：命中时发送 If-None-Match */
  etagKey?: string
  /** 跳过 Authorization（auth 接口） */
  anonymous?: boolean
  timeout?: number
}

export interface EtagResponse<T> {
  notModified: boolean
  data?: T
  etag?: string | null
  status: number
}

function authHeader(anonymous?: boolean): Record<string, string> {
  if (anonymous) return {}
  const token = getRaw(KEYS.token) || useAuthStore.getState().token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** 401 处理：先尝试用本地保存的凭据静默重登一次，失败才登出跳登录页 */
let reauthing = false

function handleUnauthorized(): void {
  // 防止静默重登期间的 401（例如登录接口本身返回 401）再次触发，形成递归
  if (reauthing) return
  reauthing = true

  void silentRelogin()
    .then((ok) => {
      reauthing = false
      if (ok) return
      useAuthStore.getState().logout()
      const pages = Taro.getCurrentPages?.() || []
      const current = pages.length ? pages[pages.length - 1].route : ''
      if (current !== 'pages/login/index') {
        Taro.reLaunch({ url: '/pages/login/index' }).catch(() => undefined)
      }
    })
    .catch(() => {
      reauthing = false
    })
}

async function rawFetch(
  path: string,
  init: RequestInit,
  timeout = TIMEOUT_MS
): Promise<Response> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller
    ? setTimeout(() => controller.abort(), timeout)
    : null
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller ? controller.signal : undefined
    })
  } catch (err: any) {
    const aborted = err && (err.name === 'AbortError' || err.code === 20)
    throw new ApiError({
      status: 0,
      message: aborted ? '请求超时，请检查网络' : '网络不可用，请稍后重试'
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let message = `请求失败 (${res.status})`
  let code: string | undefined
  let conflict: ScheduleItem | undefined
  try {
    const text = await res.text()
    if (text) {
      const data = JSON.parse(text)
      message = data.message || data.error || data.msg || message
      code = data.code
      conflict = data.conflict
    }
  } catch {
    /* 非 JSON 错误体 */
  }
  if (res.status === 401) {
    handleUnauthorized()
    message = message === `请求失败 (401)` ? '登录已过期，请重新登录' : message
  }
  return new ApiError({ status: res.status, message, code, conflict })
}

/**
 * 流式请求：不设整体超时（外部 signal 负责取消），读 body 期间不会被超时打断。
 */
async function streamFetch(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, { ...init, signal })
  } catch (err: any) {
    if (err && err.name === 'AbortError') throw err
    throw new ApiError({ status: 0, message: '网络不可用，请稍后重试' })
  }
}

/** 解析 SSE 行块：把以 data: 开头的行拼成 JSON 文本 */
function parseSSEBlock(block: string): string | null {
  const lines = block.split('\n')
  let data = ''
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('data:')) continue
    data += trimmed.slice(5).trim()
  }
  return data || null
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, anonymous, timeout } = options
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...authHeader(anonymous)
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await rawFetch(
    path,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    },
    timeout
  )

  if (!res.ok) throw await parseError(res)
  if (res.status === 204) return undefined as unknown as T
  const text = await res.text()
  if (!text) return undefined as unknown as T
  return JSON.parse(text) as T
}

/** 带 ETag 的 GET；304 时 notModified=true */
async function requestWithEtag<T>(path: string, etagKey: string, force = false): Promise<EtagResponse<T>> {
  const etag = force ? null : getRaw(etagKey)
  const headers: Record<string, string> = { Accept: 'application/json', ...authHeader() }
  if (etag) headers['If-None-Match'] = etag

  const res = await rawFetch(path, { method: 'GET', headers })
  if (res.status === 304) return { notModified: true, status: 304, etag }

  if (!res.ok) throw await parseError(res)
  const text = await res.text()
  const data = text ? (JSON.parse(text) as T) : undefined
  return { notModified: false, data, etag: res.headers.get('ETag'), status: res.status }
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

export const api = {
  base: API_BASE,

  register: (name: string, password: string) =>
    request<AuthResult>('/auth/register', {
      method: 'POST',
      body: { name, password },
      anonymous: true
    }),

  login: (name: string, password: string) =>
    request<AuthResult>('/auth/login', {
      method: 'POST',
      body: { name, password },
      anonymous: true
    }),

  // -------------------------------------------------------------------------
  // QQ 绑定
  // -------------------------------------------------------------------------

  initiateBinding: (qq_uid: string, group_id: string) =>
    request<BindCode>('/bindings/qq/initiate', {
      method: 'POST',
      body: { qq_uid, group_id }
    }),

  /** 群内发 `#bind <code>` 后由服务端置 verified=1 */
  confirmBinding: (qq_uid: string, group_id: string) =>
    request<{ binding: Binding }>('/bindings/qq/confirm', {
      method: 'POST',
      body: { qq_uid, group_id }
    }),

  listBindings: () => request<{ bindings: Binding[] }>('/bindings'),

  deleteBinding: (qq_uid: string) =>
    request<void>(`/bindings/${encodeURIComponent(qq_uid)}`, { method: 'DELETE' }),

  // -------------------------------------------------------------------------
  // 日程
  // -------------------------------------------------------------------------

  /** 全量拉取；带 If-None-Match，304 时 notModified=true。force=true 跳过缓存强拉最新 */
  getScheduleDoc: (opts: { force?: boolean } = {}) =>
    requestWithEtag<ScheduleDoc>('/schedules/me', KEYS.etag, opts.force),

  getDelta: (since: number) =>
    request<DeltaResult>(`/schedules/me/delta?since=${encodeURIComponent(String(since))}`),

  getRevision: () => request<{ revision: number }>('/schedules/me/revision'),

  createItem: (item: ScheduleItem) =>
    request<ScheduleItem>('/schedules/me/items', { method: 'POST', body: item }),

  /** 乐观锁：冲突返回 ApiError(status=409).conflict */
  patchItem: (id: string, item: ScheduleItem) =>
    request<ScheduleItem>(`/schedules/me/items/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { ...item, base_revision: item.revision }
    }),

  deleteItem: (id: string) =>
    request<void>(`/schedules/me/items/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** 批量提交离线队列 */
  syncMutations: (last_revision: number, mutations: SyncMutation[]) =>
    request<SyncResult>('/schedules/me/sync', {
      method: 'POST',
      body: {
        last_revision,
        mutations: mutations.map((m) => ({ mutation_id: m.mutation_id, op: m.op, item: m.item }))
      },
      timeout: SYNC_TIMEOUT_MS
    }),

  // -------------------------------------------------------------------------
  // 告警（需人工查看）
  // -------------------------------------------------------------------------

  listAlerts: () => request<{ alerts: Alert[] }>('/alerts/me'),

  readAlert: (id: string) =>
    request<void>(`/alerts/me/${encodeURIComponent(id)}/read`, { method: 'POST' }),

  /** 提交一条「联系我们」反馈 */
  postFeedback: (body: { subject?: string; body: string; contact?: string }) =>
    request<{ id: string }>('/feedback', {
      method: 'POST',
      data: body
    }),

  // -------------------------------------------------------------------------
  // 一键实时排程（SSE 流式思考链）
  // -------------------------------------------------------------------------

  /**
   * 触发一次立即排程，并把 DeepSeek 思考链以 SSE 增量回调回来。
   * 用 fetch + ReadableStream 消费（EventSource 无法带 Authorization 头）。
   */
  replanStream: async (
    onEvent: (ev: ReplanEvent) => void,
    signal?: AbortSignal,
    lookback?: string
  ): Promise<void> => {
    const query = lookback ? `?lookback=${encodeURIComponent(lookback)}` : ''
    const res = await streamFetch(
      `/schedules/me/replan${query}`,
      {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          ...authHeader()
        },
        body: '{}'
      },
      signal
    )
    if (!res.ok) throw await parseError(res)
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new ApiError({ status: 0, message: '当前环境不支持实时流，请用浏览器或桌面端查看' })
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx = buffer.indexOf('\n\n')
        while (idx >= 0) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const payload = parseSSEBlock(block)
          if (payload) {
            try {
              onEvent(JSON.parse(payload) as ReplanEvent)
            } catch {
              /* 半截帧：忽略 */
            }
          }
          idx = buffer.indexOf('\n\n')
        }
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
    }
  },

  /** 最近一次留存的思考链（服务端只保留最近一条） */
  getLatestReplan: () => request<LatestReplan>('/schedules/me/replan/latest'),

  /** 当前账号是否为服务器主人（已绑定主人 QQ） */
  myPrivileges: () => request<{ is_owner: boolean; control_qq: string }>('/me/privileges'),

  /** 主人免密换取后台 token（服务端校验已绑定主人 QQ） */
  ownerSSO: () =>
    request<AdminLoginResult>('/admin/owner-sso', { method: 'POST', body: {} }),

  /** 健康检查在 API 前缀之外；用 `../../` 跳出 /api/v1 层 */
  healthz: () => request<{ status?: string }>('/../../healthz')
}

/** 从任意错误中抽取人类可读信息 */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return '未知错误'
}

// ---------------------------------------------------------------------------
// 后台管理（独立 token，401 不触发普通用户的静默重登）
// ---------------------------------------------------------------------------

export class AdminApiError extends Error {
  status: number
  code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'AdminApiError'
    this.status = status
    this.code = code
  }
}

interface AdminRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  anonymous?: boolean
  timeout?: number
}

async function adminRequest<T>(path: string, options: AdminRequestOptions = {}): Promise<T> {
  const { method = 'GET', body, anonymous, timeout } = options
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (!anonymous) {
    const token = getRaw(KEYS.adminToken)
    if (token) headers.Authorization = `Bearer ${token}`
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await rawFetch(
      path,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      timeout
    )
  } catch (err) {
    if (err instanceof ApiError) throw new AdminApiError(err.status, err.message)
    throw err
  }

  if (!res.ok) {
    let message = `请求失败 (${res.status})`
    let code: string | undefined
    try {
      const text = await res.text()
      if (text) {
        const data = JSON.parse(text)
        message = data.error || data.message || message
        code = data.code
      }
    } catch {
      /* 非 JSON 错误体 */
    }
    if (res.status === 401) message = '登录已过期，请重新登录'
    throw new AdminApiError(res.status, message, code)
  }
  if (res.status === 204) return undefined as unknown as T
  const text = await res.text()
  if (!text) return undefined as unknown as T
  return JSON.parse(text) as T
}

/** 后台 REST 客户端 */
export const adminApi = {
  login: (username: string, password: string) =>
    adminRequest<AdminLoginResult>('/admin/login', {
      method: 'POST',
      body: { username, password },
      anonymous: true
    }),

  me: () => adminRequest<{ admin: AdminUser }>('/admin/me'),

  getSettings: () => adminRequest<AdminSettings>('/admin/settings'),

  updateSettings: (patch: Record<string, unknown>) =>
    adminRequest<AdminSettings>('/admin/settings', { method: 'PUT', body: patch }),

  testLLM: () =>
    adminRequest<{ ok: boolean; model: string; reply: string; tested: string }>(
      '/admin/settings/test-llm',
      { method: 'POST', body: {}, timeout: 45000 }
    ),

  listOwners: () =>
    adminRequest<{ control_qq: string; owners: AdminOwner[] }>('/admin/owners'),

  addOwner: (qq: string, note: string) =>
    adminRequest<{ control_qq: string; owners: AdminOwner[] }>('/admin/owners', {
      method: 'POST',
      body: { qq, note }
    }),

  deleteOwner: (qq: string) =>
    adminRequest<{ control_qq: string; owners: AdminOwner[] }>(
      `/admin/owners/${encodeURIComponent(qq)}`,
      { method: 'DELETE' }
    ),

  status: () => adminRequest<AdminStatus>('/admin/status', { timeout: 15000 }),

  docFiles: (limit = 50) => adminRequest<{ files: AdminDocFile[] }>(`/admin/doc-files?limit=${limit}`),

  resendDoc: (id: string) =>
    adminRequest<{ file: AdminDocFile }>(`/admin/doc-files/${encodeURIComponent(id)}/resend`, {
      method: 'POST',
      body: {},
      timeout: 45000
    }),

  audit: (limit = 50) => adminRequest<{ audit: AdminAuditEntry[] }>(`/admin/audit?limit=${limit}`)
}
