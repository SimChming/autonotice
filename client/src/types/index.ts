/**
 * 与 Go 服务端共享的数据契约（务必与服务端实现保持一致）。
 * 时间一律使用 RFC3339 字符串。
 */

export type ItemType = 'exam' | 'deadline' | 'payment' | 'event' | 'other'

export type ItemStatus = 'todo' | 'doing' | 'done' | 'ignored'

export type ItemPriority = 'high' | 'normal' | 'low'

/** 服务端下发给本客户端的 Agent 动作（大模型 / QQ 机器人触发） */
export interface AgentAction {
  id: string
  user_id: string
  user_qq?: string
  /** notify.send | client.alarm */
  action: string
  title: string
  body: string
  /** 动作附加参数：level / vibrate / route / mode ... */
  payload?: Record<string, unknown>
  source: string
  due_at?: string | null
  created_at: string
}

export type FetchStatus = 'pending' | 'ok' | 'blocked' | 'unfetchable' | 'failed' | 'too_large'

export type AssetKind = 'file' | 'link' | 'miniapp' | 'wechat_article'

/** 贡献了该条日程的某个群聊 */
export interface SourceGroupInfo {
  group_id: string
  group_name?: string
}

/** 日程条目的来源信息（AI 生成，客户端只读） */
export interface SourceInfo {
  kind: string
  group_id: string
  /** 首个来源群的可读名称 */
  group_name?: string
  /** 全部来源群（同一日程被多个群重复发布时会有一条列出多个群） */
  groups?: SourceGroupInfo[]
  message_ids: string[]
  excerpt: string
  confidence: number
  content_asset_id?: string
  link_title?: string
  fetch_status?: FetchStatus
}

export interface ScheduleItem {
  id: string
  title: string
  type: ItemType
  status: ItemStatus
  priority: ItemPriority
  /** RFC3339，可为空（无明确时间） */
  due_at: string | null
  /** RFC3339，用户/AI 指定的提醒时间，可为空 */
  remind_at: string | null
  all_day: boolean
  notes: string
  /** 用户手改过 → AI 不再覆盖 */
  locked_by_user: boolean
  /** 乐观锁版本号 */
  revision: number
  source?: SourceInfo | null
  created_at: string
  updated_at: string
}

export interface Alert {
  id: string
  user_qq: string
  group_id: string
  content_asset_id: string
  level: 'high' | 'normal' | string
  title: string
  summary: string
  context_excerpt: string
  review_reason: string
  read_at: string | null
  created_at: string
  /** "group" | "private" — 区分群聊告警还是私聊告警 */
  message_type?: string
  /** 群名或对方昵称 */
  source_name?: string
  /** 头像 URL（QQ 公开头像） */
  source_avatar?: string
}

export interface Binding {
  qq_uid: string
  group_id: string
  verified: boolean
  created_at: string
}

export interface User {
  id: string
  name: string
}

export interface AuthResult {
  token: string
  user: User
}

export interface BindCode {
  code: string
  expires_at: string
}

/** GET /schedules/me 返回的日程文档 */
export interface ScheduleDoc {
  user_id: string
  qq_uid: string
  generated_at: string
  revision: number
  digest: string
  items: ScheduleItem[]
}

export interface DeltaResult {
  revision: number
  changed: ScheduleItem[]
  deleted: string[]
}

export type MutationOp = 'upsert' | 'delete'

export interface SyncMutation {
  /** 客户端生成的幂等 ID（服务端据此去重） */
  mutation_id: string
  op: MutationOp
  item: ScheduleItem
  /** 本地入队时间，用于排序 */
  queued_at: number
}

export interface SyncResult {
  revision: number
  changed: ScheduleItem[]
  conflicts: ScheduleItem[]
}

export interface ApiErrorShape {
  status: number
  message: string
  code?: string
  /** PATCH 409 时服务端返回的最新条目 */
  conflict?: ScheduleItem
}

/**
 * 一键实时排程（POST /schedules/me/replan，SSE）推送的事件。
 * 与服务端 internal/httpapi/replan.go 的事件契约保持一致。
 */
export type ReplanEvent =
  | {
      type: 'start'
      bindings: Array<{ qq_uid: string; group_id: string }>
      model: string
      lookback: string
    }
  | { type: 'phase'; phase: 'reasoning' | 'summarizing' | 'persisting' | 'done'; message: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'answer'; delta: string }
  | {
      type: 'run'
      qq_uid: string
      revision: number
      new_items: number
      messages: number
      skipped: boolean
    }
  | { type: 'done'; revision: number; elapsed_ms: number }
  | { type: 'error'; message: string }

/** GET /schedules/me/replan/latest：留存的最近一次思考链 */
export interface LatestReplan {
  run_id?: string
  reasoning: string
  model?: string
  at?: string | null
  revision?: number
  item_count?: number
}

/** 通知点击后需要跳转的目标 */
export interface NotifyExtra {
  itemId?: string
  due_at?: string | null
  alertId?: string
  /** 排程归属的用户 id，用于「取消该用户全部已排通知」 */
  owner?: string
}

// ---------------------------------------------------------------------------
// 后台管理（/api/v1/admin，独立管理员 token）
// ---------------------------------------------------------------------------

export interface AdminUser {
  id: string
  username: string
  last_login_at?: string | null
}

export interface AdminLoginResult {
  token: string
  expires_at: string
  admin: AdminUser
}

export type CapabilityKey = 'image' | 'sticker' | 'voice' | 'video' | 'file' | 'recall' | 'at_all'

export type Capabilities = Record<CapabilityKey, boolean>

export interface AutoSegmentSettings {
  enabled: boolean
  targets: string[]
  min_delay_ms: number
  max_delay_ms: number
  max_segments: number
  start_index: number
}

export interface AdminSettings {
  deepseek: {
    api_key: string
    api_key_set: boolean
    base_url: string
    model: string
    enable_thinking: boolean | null
  }
  capabilities: Capabilities
  auto_segment: AutoSegmentSettings
  docs: { quota_per_day: number }
  control_qq: string
  owners: string[]
  pdf_font_ready: boolean
  docs_enabled: boolean
}

export interface AdminOwner {
  qq: string
  note: string
  created_at: string
}

export interface AdminStatus {
  version: string
  uptime: string
  onebot_connected: boolean
  onebot_self_id: string
  onebot_nickname: string
  onebot_error?: string
  llm_configured: boolean
  llm_model: string
  llm_base_url: string
  pdf_font_ready: boolean
  docs_today: number
  docs_quota: number
  owners: number
  auto_segment_enabled: boolean
  capabilities: Capabilities
}

export interface AdminDocFile {
  id: string
  user_qq: string
  chat_key: string
  filename: string
  type: string
  size_bytes: number
  created_at: string
}

export interface AdminAuditEntry {
  id: number
  admin_id: string
  username: string
  action: string
  detail: string
  created_at: string
}

