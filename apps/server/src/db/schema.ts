import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * 全量 schema（§5）。Phase 3 只使用 users/bindings/bind_codes/groups/messages，
 * 其余表先建好，后续阶段直接写入，避免反复迁移。
 */

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const bindings = sqliteTable("bindings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  qq: text("qq").notNull().unique(),
  verifiedAt: integer("verified_at").notNull(),
});

export const bindCodes = sqliteTable("bind_codes", {
  code: text("code").primaryKey(),
  qq: text("qq").notNull(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at").notNull(),
});

export const groups = sqliteTable("groups", {
  groupId: text("group_id").primaryKey(),
  name: text("name").notNull().default(""),
  avatar: text("avatar").notNull().default(""),
  updatedAt: integer("updated_at").notNull(),
});

/** 用户绑定的群聊（一个用户可绑定多个群，日程按群记录来源）。 */
export const userGroups = sqliteTable(
  "user_groups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: text("group_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    userGroupUnique: uniqueIndex("user_groups_user_group_idx").on(table.userId, table.groupId),
  }),
);

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupId: text("group_id").notNull(),
  senderQq: text("sender_qq").notNull(),
  senderName: text("sender_name").notNull().default(""),
  text: text("text").notNull(),
  rawJson: text("raw_json").notNull(),
  msgTime: integer("msg_time").notNull(),
});

export const contentAssets = sqliteTable("content_assets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  contentHash: text("content_hash").notNull().unique(),
  sourceUrl: text("source_url").notNull(),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
});

export const scheduleItems = sqliteTable("schedule_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  groupId: text("group_id"),
  title: text("title").notNull(),
  type: text("type").notNull().default("task"),
  priority: text("priority").notNull().default("normal"),
  status: text("status").notNull().default("pending"),
  dueAt: integer("due_at"),
  remindAt: integer("remind_at"),
  notes: text("notes").notNull().default(""),
  sourceMsgId: integer("source_msg_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  scheduleId: integer("schedule_id"),
  level: text("level").notNull().default("normal"),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  route: text("route").notNull().default("ws"),
  at: integer("at").notNull(),
  sentAt: integer("sent_at"),
});

export const botHistory = sqliteTable("bot_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionKey: text("session_key").notNull(),
  role: text("role").notNull(),
  senderQq: text("sender_qq"),
  text: text("text").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const botSummary = sqliteTable("bot_summary", {
  sessionKey: text("session_key").primaryKey(),
  summary: text("summary").notNull(),
  coveredId: integer("covered_id").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

export const memories = sqliteTable("memories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionKey: text("session_key").notNull(),
  senderQq: text("sender_qq"),
  content: text("content").notNull(),
  tags: text("tags").notNull().default(""),
  embedding: text("embedding").notNull().default("[]"),
  kind: text("kind").notNull().default("chat"),
  scope: text("scope").notNull().default("peer"),
  createdAt: integer("created_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const admins = sqliteTable("admins", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
});

export const adminAudit = sqliteTable("admin_audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  adminId: integer("admin_id"),
  action: text("action").notNull(),
  detail: text("detail").notNull().default(""),
  createdAt: integer("created_at").notNull(),
});

export const agentActions = sqliteTable("agent_actions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionKey: text("session_key").notNull(),
  action: text("action").notNull(),
  params: text("params").notNull().default("{}"),
  result: text("result").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

export const docFiles = sqliteTable("doc_files", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  path: text("path").notNull(),
  quotaDate: text("quota_date").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** 机器人自建触发器：到点自动发消息/执行技能，或按群消息关键词触发。 */
export const triggers = sqliteTable("triggers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sessionKey: text("session_key").notNull(),
  kind: text("kind").notNull(),
  at: integer("at"),
  event: text("event"),
  action: text("action").notNull(),
  enabled: integer("enabled").notNull().default(1),
  lastFiredAt: integer("last_fired_at"),
  createdAt: integer("created_at").notNull(),
});

/**
 * V4.4.4 彩蛋版：赛博女儿的灵魂状态（固定一行，id=1）。
 * traits 是人格向量 JSON（0-100），会随每天接触的信息缓慢增减。
 */
export const soulState = sqliteTable("soul_state", {
  id: integer("id").primaryKey(),
  mood: text("mood").notNull().default("平静"),
  moodIntensity: integer("mood_intensity").notNull().default(50),
  /** 5.3.0：心情开始褪色的时间锚点，用于让情绪随真实时间回落。 */
  moodAt: integer("mood_at").notNull().default(0),
  energy: integer("energy").notNull().default(80),
  traits: text("traits").notNull().default("{}"),
  lastWakeAt: integer("last_wake_at"),
  updatedAt: integer("updated_at").notNull(),
});

/** 每天一篇日记，day 为 YYYY-MM-DD 唯一。 */
export const soulJournals = sqliteTable(
  "soul_journals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    day: text("day").notNull(),
    title: text("title").notNull().default(""),
    body: text("body").notNull(),
    mood: text("mood").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    soulJournalDayUnique: uniqueIndex("soul_journals_day_idx").on(table.day),
  }),
);

/** 她当天看到/读过的东西：热搜、搜索、网页摘要。 */
export const soulReadings = sqliteTable("soul_readings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull(),
  title: text("title").notNull().default(""),
  url: text("url").notNull().default(""),
  summary: text("summary").notNull().default(""),
  day: text("day").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** 主人翻看她日记的痕迹；toldAt 非空表示主人选择让她知道。 */
export const soulVisits = sqliteTable("soul_visits", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  day: text("day").notNull(),
  viewerQq: text("viewer_qq").notNull(),
  at: integer("at").notNull(),
  toldAt: integer("told_at"),
});

/** 自主活动流水：自言自语、冲浪、心情与人格演化，便于后台回看。 */
export const soulEvents = sqliteTable("soul_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  day: text("day").notNull(),
  createdAt: integer("created_at").notNull(),
});

/**
 * 内在驱力（0-100，越高越渴）。随时间自然上涨，被对应活动缓解。
 * 它是「她此刻为什么想做这件事」的来源，取代原先的随机权重。
 */
export const soulDrives = sqliteTable(
  "soul_drives",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    level: integer("level").notNull().default(50),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    soulDriveNameUnique: uniqueIndex("soul_drives_name_idx").on(table.name),
  }),
);

/**
 * 挂念：她想做的事 / 没搞懂的事 / 放不下的心事。
 * 跨天保留，是行为连续性的核心——她会记得昨天追到一半的线索。
 */
export const soulIntentions = sqliteTable("soul_intentions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
  /** goal 想做的事 | question 没搞懂的事 | worry 放不下的心事 | promise 答应过的事 */
  kind: text("kind").notNull().default("goal"),
  /** active 进行中 | done 已经完成 | dropped 自己放弃了 */
  status: text("status").notNull().default("active"),
  /** 进展流水，每行一句，累积 */
  progress: text("progress").notNull().default(""),
  priority: integer("priority").notNull().default(50),
  day: text("day").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** 自我认知：从经历里沉淀出的更高层认识，会反过来影响她怎么看待自己。 */
export const soulReflections = sqliteTable("soul_reflections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  content: text("content").notNull(),
  importance: integer("importance").notNull().default(50),
  day: text("day").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** 她亲手在服务器上执行过的命令：她做过什么、结果如何，都留在这里。 */
export const soulCommands = sqliteTable("soul_commands", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  command: text("command").notNull(),
  output: text("output").notNull().default(""),
  ok: integer("ok").notNull().default(1),
  durationMs: integer("duration_ms").notNull().default(0),
  /** self 自己想的 | owner 主人让她做的 */
  trigger: text("trigger").notNull().default("self"),
  reason: text("reason").notNull().default(""),
  day: text("day").notNull(),
  createdAt: integer("created_at").notNull(),
});

/** 可插拔技能：persona（人格）/ tool（LLM 可调用动作）/ instruction（附加提示词）。 */
export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  type: text("type").notNull(),
  enabled: integer("enabled").notNull().default(1),
  prompt: text("prompt").notNull().default(""),
  handler: text("handler"),
  permissions: text("permissions").notNull().default("all"),
  paramsSchema: text("params_schema").notNull().default("{}"),
  version: text("version").notNull().default("1.0.0"),
  builtin: integer("builtin").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/* ------------------------------------------------------------------ 5.4.0
 * 仿人闭环：环境事件 → 触发器（分类器决定是否携带信息唤醒）→ 思考 → 效应器 → 环境。
 * 这四张表把「一次醒来」从内存里的随机掷骰变成可持久化、可打断、可续跑的状态机。
 */

/** 环境事件流：群消息、私聊、定时 tick、驱力越线、命令输出都从这里进入。 */
export const agentEvents = sqliteTable("agent_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull(),
  type: text("type").notNull(),
  sessionKey: text("session_key"),
  /** 1 表示这条消息直接指向她（@、私聊、后台聊天）。 */
  addressed: integer("addressed").notNull().default(0),
  payload: text("payload").notNull().default("{}"),
  importance: integer("importance").notNull().default(50),
  createdAt: integer("created_at").notNull(),
  consumedAt: integer("consumed_at"),
});

/**
 * 触发器：她可以自己建的「环境条件」。
 * kind=condition 时由条件求值器扫描；条件满足后创建一次激活。
 */
export const agentTriggers = sqliteTable("agent_triggers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("condition"),
  sessionKey: text("session_key"),
  /** 条件 JSON：time / keyword / event / drive / idle / shell。 */
  condition: text("condition").notNull().default("{}"),
  /** 条件满足时给她的提示词：她醒来后要围绕什么想。 */
  prompt: text("prompt").notNull().default(""),
  enabled: integer("enabled").notNull().default(1),
  oneShot: integer("one_shot").notNull().default(0),
  cooldownMs: integer("cooldown_ms").notNull().default(300_000),
  priority: integer("priority").notNull().default(50),
  expiresAt: integer("expires_at"),
  lastCheckedAt: integer("last_checked_at"),
  lastFiredAt: integer("last_fired_at"),
  fireCount: integer("fire_count").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * 激活：一次「她真的开始想这件事」的工作会话。
 * kind=self 是自激触发器：用来维持多轮对话/未完成的工作；
 * status=sleeping 表示她决定过一会儿接着说，status=done 表示她闭嘴了。
 */
export const agentActivations = sqliteTable("agent_activations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionKey: text("session_key"),
  /** chat 走对话通道；free 走独处思考通道。 */
  mode: text("mode").notNull().default("free"),
  /** user | self | condition | event | tick */
  kind: text("kind").notNull(),
  triggerId: integer("trigger_id"),
  eventId: integer("event_id"),
  status: text("status").notNull().default("active"),
  task: text("task").notNull().default(""),
  context: text("context").notNull().default(""),
  nextRunAt: integer("next_run_at"),
  leaseUntil: integer("lease_until"),
  continueCount: integer("continue_count").notNull().default(0),
  maxContinues: integer("max_continues").notNull().default(40),
  startedAt: integer("started_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  finishedAt: integer("finished_at"),
  lastError: text("last_error").notNull().default(""),
});

/** 每一轮「分类 → 思考 → 效应」的审计记录，后台可以看到她为什么动。 */
export const agentCycles = sqliteTable("agent_cycles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  activationId: integer("activation_id"),
  eventId: integer("event_id"),
  classifier: text("classifier").notNull().default("{}"),
  thought: text("thought").notNull().default(""),
  actions: text("actions").notNull().default("[]"),
  result: text("result").notNull().default(""),
  createdAt: integer("created_at").notNull(),
});
