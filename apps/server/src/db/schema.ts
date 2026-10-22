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
