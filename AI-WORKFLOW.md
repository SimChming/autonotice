# Autonotice v2 — 从零重建 · AI Workflow 交接文档

> **本文档是重建工程的唯一权威执行手册**，面向零上下文的执行 AI。
> 旧系统（Go 单体 `qqsched`，仓库 `SimChming/autonotice` main 分支）已决定退役：服务器重置、代码从零重写、部署方式彻底更换。
> 阅读顺序：§1 元指令 → §2 北极星 → §3 资产盘点 → §4 新架构 → §5\~6 契约 → §7 分阶段 Workflow → §8 部署 → §9 坑清单 → §10 状态表。

***

## 1. 元指令（执行 AI 必读）

1. **权威优先级**：本文档 > 项目记忆 > 执行 AI 自行判断。文档没写的决策，选择最简单能过验收标准的方案，并把它补充回本文档 §10 状态表下方的「决策日志」。
2. **阶段纪律**：严格按 §7 的 Phase 0 → 8 顺序执行。每个 Phase 的「验收标准」全部通过后，在 §10 状态表勾掉该行，才能开始下一个 Phase。禁止跳阶段、禁止提前做后续阶段的任务「顺手一起做」。
3. **每个 Phase 结束时**：commit（信息格式 `phase(N): <摘要>`）、push、更新 §10 状态表。
4. **遇到与旧经验冲突**：§9 坑清单来自旧项目真实事故，视为硬约束。与任何教程/最佳实践冲突时，坑清单优先。
5. **禁止事项**：每阶段末尾的「禁止」小节是防跑偏清单，逐条遵守。

***

## 2. 北极星目标（最终要实现什么）

按主人原话归纳，重建完成后的系统必须同时满足：

1. **核心功能**：机器人小号挂在 QQ 群里，群消息（含链接/文件/图片）自动抓取 → LLM 提取日程 → 多端客户端（Windows exe / Android APK / 浏览器）查看管理 → 到点强提醒（客户端震动/响铃）。
2. **鲸鱼娘人格机器人**：群里 @ 或私聊均可对话；只有主人（QQ `3874095145`）可称呼「主人」并触发服务器 root shell；普通用户限流；支持调用 OneBot 全接口与 Autonotice 自身能力。
3. **记忆不费劲**：机器人的上下文记忆要「聊过的能想起来」。这是上一代被反复返工的核心痛点，§4.5 有专门设计。
4. **部署零负担（本次重建的直接动因）**：本地零交叉编译、服务器零编译、零 scp。`git push` 之后一切自动化。服务器上永远只有 `docker compose pull && up -d` 级别的操作。
5. **后台管理**：在线改模型/API 密钥/能力开关/用户权限，热生效；主人 QQ 免密 SSO 进后台。
6. **AI 可维护性**：类型在前后端共享、结构自解释、每个模块有明确验收口径，让后续任何 AI 接手成本最低。

***

## 3. 资产盘点

### 3.1 初始资产

| 资产                     | 去向                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| LLM API Key（dashscope） | <已移除：请通过服务器 .env 配置> |
| 后台管理员密码                | <已移除：见服务器 .env>                                                                                                         |
| 服务器公网 IP               | 120.26.224.86                                                                                                          |
| 本地已有产物                 | 保留作参考                                                                                                                  |

### 3.2 天然保留（不在服务器上）

| 资产        | 值                                                                                   |
| --------- | ----------------------------------------------------------------------------------- |
| 机器人小号     | QQ `3754609823`（**腾讯风控：NapCat 每次重启都要扫码重登，无法免扫码**）                                   |
| 主人控制大号    | QQ `3874095145`（唯一 shell 授权、后台 SSO）                                                 |
| 主群        | `1130297603`（绑定码必须由大号本人在此群发送）                                                       |
| GitHub 仓库 | `SimChming/autonotice`（保留历史，v2 在 `v2` 分支开发，最终合回 main）                               |
| LLM 供应商   | 阿里云 dashscope compatible-mode，默认模型 `deepseek-v4.1-flash`，视觉模型 `deepseek-v4.1-flash` |

### 3.3 明确丢弃

- Go 服务端全部代码（仅作行为参考：人格 prompt、权限规则、绑定流程、坑清单已提炼进本文档）。
- Taro 4 客户端（页面结构与样式可搬运，框架换 Vite + React）。
- 「本地交叉编译 → scp → systemctl restart」部署流程。
- 服务器上一切手工痕迹（systemd unit、sudoers、screen、@reboot 脚本）——新服务器全部由 Docker Compose + 单个 `deploy.sh` 取代。

***

## 4. 新架构总设计

### 4.1 技术选型与理由

| 维度     | 选择                                                                                 | 理由                                                                    |
| ------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 语言     | **TypeScript 全栈**（Node 20 + React 18）                                              | 前后端共享 API 类型（单一契约，AI 开发不再两头对 DTO）；无编译产物；AI 对 TS 生态最熟，迭代最快             |
| 服务端框架  | **Fastify 4** + `@fastify/cors` + `@fastify/websocket` + `@fastify/static`         | 内置 schema 校验、生态全、性能足够                                                 |
| 校验/契约  | **zod**（schema 即类型，放 `packages/shared`）                                            | 一处定义，server 路由校验 + client 请求共用                                        |
| 数据库    | **SQLite**（`better-sqlite3`）+ **drizzle-orm** + drizzle-kit 迁移                     | 数据量小；同步 API 简单；ORM 管 schema 与迁移，告别手写 SQL 文件                           |
| 客户端    | **Vite 5 + React 18 + zustand + react-router** + scss                              | 去掉 Taro 抽象层（本项目从不发小程序）；样式与页面结构从旧版迁移，设计语言不变                            |
| 三端壳    | 浏览器（内嵌静态托管）+ **Capacitor 6**（Android）+ **Tauri 2**（Windows）                        | 沿用旧版成熟方案，坑已趟平                                                         |
| QQ 接入  | **NapCat 官方 Docker 镜像** + OneBot v11 反向 WebSocket                                  | NapCat 容器化，与 server 同一 compose 编排                                     |
| LLM    | openai SDK → dashscope compatible-mode；JSON 输出模式模拟 tool calling                    | 沿用；视觉用 `qwen3-vl-plus`；embedding 用 `text-embedding-v4`（记忆语义召回，见 §4.5） |
| **部署** | **GitHub Actions 构建 Docker 镜像 → ghcr.io → 服务器** **`docker compose pull && up -d`** | 本地零编译、服务器零编译零语言环境；push main 即上线                                       |
| 版本     | monorepo 根 `package.json` 单一版本号，v2.0.0 起步                                          | 三端 + 服务端同版本发布                                                         |

### 4.2 系统架构图

```
┌──────────────────┐         ┌───────────────────────────────────────────┐
│   腾讯 QQ 服务器  │         │   阿里云主机（重置后 Ubuntu 24.04，仅装 Docker）│
│                  │         │                                           │
│  群 1130297603   │ QQ 协议 │  ┌─────────────────────────────────────┐   │
│  机器人小号       │◄───────►│  │ docker compose                       │   │
│  3754609823     │         │  │                                     │   │
│                  │         │  │  ┌───────────────┐   ┌────────────┐ │   │
└──────────────────┘         │  │  │ napcat 容器    │   │ server 容器 │ │   │
                             │  │  │ WebUI :6099    │──►│ Fastify    │ │   │
      ┌──────────────────────┼──┼──┤ (扫码登录入口)  │WS │ :8080      │ │   │
      │  HTTPS :8080         │  │  └───────────────┘   └─────┬──────┘ │   │
      ▼                      │  │        ▲  OneBot v11 反向WS  │        │   │
┌────────────────────────────┼──┼────────┼─────────────────────┼──────┐ │   │
│ 客户端三端                  │  │  SQLite 卷 (data/app.db) ◄────┘      │ │   │
│  Windows exe (Tauri 2)     │  │  .env 卷（密钥/配置）                 │ │   │
│  Android apk (Capacitor 6) │  └─────────────────────────────────────┘   │
│  浏览器 (server 内嵌静态页)  └───────────────────────────────────────────┘
└────────────────────────────┘              ▲
                                            │ git push main
                              ┌─────────────┴──────────────┐
                              │ GitHub Actions             │
                              │ lint/test/build → 镜像 →   │
                              │ ghcr.io → SSH 触发服务器 pull│
                              └────────────────────────────┘
```

### 4.3 Monorepo 目录结构（目标形态，按此搭建）

```
autonotice/                          # 仓库根（v2 分支）
├── AI-WORKFLOW.md                   # 本文档
├── HANDOFF.md                       # v2 完成后的运维交接（Phase 8 从旧版改写）
├── package.json                     # 版本号 v2.x.x 唯一事实源 + workspace 脚本
├── pnpm-workspace.yaml
├── .github/workflows/
│   ├── ci.yml                       # PR/push: typecheck+lint+test+build
│   └── deploy.yml                   # main: 构建镜像→ghcr→SSH 服务器部署
├── apps/
│   ├── server/                      # 服务端
│   │   ├── Dockerfile               # 多阶段：pnpm build → node:20-slim 运行
│   │   ├── package.json
│   │   ├── drizzle.config.ts
│   │   └── src/
│   │       ├── index.ts             # 入口：装配 config→db→fastify→onebot→scheduler
│   │       ├── config.ts            # zod 解析 env，导出类型安全的 Config
│   │       ├── plugins/             # fastify 插件注册（db/cors/jwt/ws/static）
│   │       ├── db/
│   │       │   ├── schema.ts        # drizzle 全部表定义（§5）
│   │       │   ├── client.ts        # better-sqlite3 连接（WAL）
│   │       │   └── migrate.ts       # 启动时跑 drizzle-kit 迁移
│   │       ├── llm/
│   │       │   ├── client.ts        # openai SDK 封装（dashscope base_url）
│   │       │   └── chat-json.ts     # JSON 输出模式（prompt 必含 "json" 关键词！）
│   │       ├── onebot/
│   │       │   ├── server.ts        # 反向 WS 服务端（token 鉴权，挂 /onebot/v11/ws）
│   │       │   ├── normalize.ts     # 事件归一化（message 双形态兜底，§9-坑2）
│   │       │   └── api.ts           # callAction(action, params) 通用出口
│   │       ├── pipeline/            # 日程提取管线
│   │       │   ├── ingest.ts        # 消息入库 + 分发（bot / 抓取）
│   │       │   ├── fetcher.ts       # 链接抓取（SSRF 防护、2MB 上限、Jina 可选）
│   │       │   ├── extract.ts       # LLM 抽取日程（JSON 模式，关思考链）
│   │       │   └── merge.ts         # 与既有日程比对去重合并
│   │       ├── scheduler/           # node-cron 定时任务（汇总/清理/提醒分发）
│   │       ├── notify/
│   │       │   ├── hub.ts           # WS 推送（客户端实时提醒）
│   │       │   └── qq.ts            # QQ 私聊推送（限速）
│   │       ├── bot/                 # 鲸鱼娘机器人
│   │       │   ├── persona.ts       # 人格 prompt（从旧版 prompt.go 全文迁移）
│   │       │   ├── handle.ts        # 入口：@检测/权限/限流/前缀命令
│   │       │   ├── chat.ts          # LLM 对话循环（reply/command/api/autonotice/memory）
│   │       │   ├── memory.ts        # 记忆召回与写入（§4.5）
│   │       │   ├── history.ts       # 会话历史（DB 持久化 + 摘要）
│   │       │   └── shell.ts         # 主人 shell 会话（node-pty 或 child_process）
│   │       ├── routes/
│   │       │   ├── v1/              # /api/v1/*（auth/bind/schedules/alerts/replan/agent）
│   │       │   └── admin/           # /api/v1/admin/*（login/settings/users/capabilities）
│   │       └── docs-gen/            # xlsx/docx/pdf 生成（配额 2/人/日）
│   ├── client/                      # React SPA
│   │   ├── package.json
│   │   ├── vite.config.ts           # PWA 插件；API 用同源相对路径 /api/v1（§9-坑14）
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx / App.tsx   # 路由（react-router）+ 分辨率自适应布局
│   │       ├── pages/               # login/bind/schedule/detail/calendar/alerts/settings/admin/feedback
│   │       ├── components/          # TabBar/ItemCard/GroupChip/SourceCard/ReasoningPanel/
│   │       │                        # DesktopLayout/InAppReminder/Empty/PageHeader/Icon/ConflictSheet
│   │       ├── stores/              # zustand: auth/schedule/alerts/notify/replan/admin
│   │       ├── services/
│   │       │   ├── api.ts           # fetch 封装（用 @autonotice/shared 的类型）
│   │       │   └── notify/          # 平台分流：web/tauri/capacitor + 本地提醒调度
│   │       ├── styles/              # variables.scss + 全局样式
│   │       └── utils/               # date/platform/storage/text/useAuthGuard/desktop
│   └── shells/
│       ├── android/                 # Capacitor 6 工程壳（cleartext + http scheme，§9-坑7）
│       └── desktop/                 # Tauri 2 工程壳（无 notification 空配置，§9-坑10）
├── packages/
│   └── shared/                      # @autonotice/shared
│       ├── package.json
│       └── src/
│           ├── api/                 # 全部 REST DTO 的 zod schema + 推导类型
│           ├── onebot.ts            # OneBot v11 事件/消息段/CQ 类型
│           ├── bot-contract.ts      # 机器人 LLM JSON 输出契约类型
│           └── constants.ts         # 群号/QQ号/默认模型等非敏感常量
├── deploy/
│   ├── docker-compose.yml           # server + napcat（§8）
│   ├── .env.example                 # 所有密钥占位（真 .env 在服务器，600 权限，LF！）
│   └── deploy.sh                    # 服务器端唯一运维脚本（pull+up+healthz 自检）
├── migration/
│   ├── old-app.db                   # Phase 0 抢救的旧库（.gitignore 忽略）
│   └── import-old.ts                # 旧库 → 新库导入脚本（Phase 8）
└── docs/                            # 旧版 CONFIGURATION.md 等历史资料归档
```

**结构硬规则**：`apps/server` 不 import `apps/client` 的任何东西；所有跨端共享只经 `packages/shared`；每个包 `package.json` 有 `typecheck`/`lint`/`test` 脚本，CI 全量跑。

### 4.4 服务端分层规则

```
路由层 routes/      → 只做：鉴权 → zod 校验 → 调服务 → 返回。禁止业务逻辑。
服务层 pipeline/ bot/ notify/ scheduler/ docs-gen/ → 业务逻辑。可互相调用（bot 可调 notify），禁止 import 路由层。
数据层 db/          → drizzle schema + 查询封装。禁止业务 if/else。
协议层 onebot/ llm/ → 外部世界适配。业务层只依赖这里导出的接口。
```

### 4.5 记忆系统设计（重点！上一代的核心败因）

上代两版失败复盘：

- v1（关键词 LIKE 召回）：召回质量差，「聊过的想不起来」，主人觉得沟通费劲。
- v2（三层记忆 + 角色体系）：过度工程（turn 持久化+滚动摘要指针+DB 角色），概念多、疑似干扰服务，被整体回退。

**v3 方案 = 会话历史 + 单层摘要 + embedding 语义召回，仅此三个概念：**

1. **会话历史** **`bot_history`** **表**：机器人每次对话（user/assistant/tool）落库。构建 prompt 时注入最近 N=12-24 轮（服务重启不丢——这是上代纯内存 history 的缺陷，可以在后台调整）。
2. **单层摘要** **`bot_summary`** **表**：每会话 key（`group:<群号>` / `private:<QQ>`）一行。当未摘要的历史超过 40 条时，后台任务把旧部分压缩成 ≤500 字摘要覆写该行，注入 prompt 头部。**不做时间指针、不做多层游标**。
3. **语义记忆** **`memories`** **表 + embedding**：模型在对话 JSON 的 `memory` 字段输出值得长期记住的内容（复用同一次调用，零额外成本）。写入时调 dashscope `text-embedding-v4` 生成向量存 `embedding` 列（JSON float 数组）。召回时：取该会话相关候选（同 session\_key 或同 sender\_qq，上限 200 条）在 Node 里**暴力余弦相似度**排序，取 top 5 注入。数据量级（百条）完全不需要向量库。命中阈值 0.35，低于则不注入。

验收口径（Phase 6）：重启服务后机器人仍记得重启前的对话内容；隔一个会话再提「上次说过的事」能接上。

### 4.6 权限模型（服务端强制，绝不信任模型自觉）

沿用上代硬规则，代码里逐条落实：

| 规则                                                       | 实现                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| 仅主人 `3874095145` 可称呼「主人」、可触发 shell                       | `bot/handle.ts` 入口处校验；prompt 注入【当前对话对象】身份行                     |
| 普通用户仅可操作**自身绑定账号**的 Autonotice 动作                        | `agent` 动作执行器剥离子 params 中任何 `target_qq/target_user_id`，出现即 403 |
| 后台 `/admin/*` 与普通用户路由 JWT 双 scope 隔离                     | 两个 token audience，fastify 两个 guard 插件                          |
| 普通用户私聊限流 3 次/5 分钟，主人不限                                   | 滑动窗口表 `bot_history` 之外内存 Map 即可                                |
| 能力开关七类（图片/表情/语音/视频/文件/撤回/@全体）关闭后，模型输出中相关 CQ 码**服务端强制清洗** | `bot/chat.ts` 发送前过滤                                            |

***

## 5. 数据库 Schema（drizzle，全部新表）

```
users(id, username UNIQUE, password_hash, created_at)
bindings(id, user_id→users, qq UNIQUE, verified_at)          # 一个账号绑一个大号QQ
bind_codes(code, qq, expires_at)                              # 绑定码 10 分钟有效
groups(group_id PK, name, avatar, updated_at)                 # 群元数据缓存
messages(id, group_id, sender_qq, text, raw_json, msg_time)   # 群消息存档（排程语料）
content_assets(id, content_hash UNIQUE, source_url, kind, text, fetched_at)  # 抓取缓存 7 天
schedule_items(id, user_id, group_id, title, type, priority, status,
               due_at, remind_at, notes, source_msg_id, created_at, updated_at)
alerts(id, user_id, schedule_id, level, title, body, route, at, sent_at NULL)
bot_history(id, session_key, role, sender_qq, text, created_at)     # 机器人对话历史
bot_summary(session_key PK, summary, covered_id, updated_at)        # 每会话一条摘要
memories(id, session_key, sender_qq, content, tags, embedding,  -- JSON float[]
         kind,        -- 'chat' | 'preference'（主人强调的系统级偏好）
         scope,       -- 'peer' | 'system'
         created_at)
settings(key PK, value JSON, updated_at)                       # 运行时配置（热更新，覆盖 .env）
admins(id, username UNIQUE, password_hash)
admin_audit(id, admin_id, action, detail, created_at)
agent_actions(id, session_key, action, params, result, created_at)  # 机器人 Autonotice 动作审计
doc_files(id, user_id, kind, title, path, quota_date, created_at)   # 文档生成配额按 (user,日期) 计数
```

## 6. API 契约（zod 定义于 packages/shared/src/api/）

```
POST /api/v1/auth/register|login            → { token }             (JWT TTL 720h)
POST /api/v1/bind/start|confirm             → 绑定码流程（码须由大号在群 1130297603 发送）
GET/POST/PATCH/DELETE /api/v1/schedules     → 日程 CRUD + 同步
GET  /api/v1/alerts                         → 提醒列表
POST /api/v1/replan                         → 一键实时排程（思考链中文返回）
GET  /api/v1/healthz                        → 无鉴权健康检查
WS   /api/v1/ws                             → 客户端实时提醒推送
POST /api/v1/agent/:action                  → 外部 LLM 可调用的 Autonotice 标准动作
     (notify.send / client.alarm / schedule.list|create|update|delete / account.whoami)
POST /api/v1/admin/login                    → 管理员 JWT（独立 scope）
GET/PUT /api/v1/admin/settings              → 模型/密钥(掩码)/能力开关/限流 热更新
GET/POST/DELETE /api/v1/admin/users         → QQ 用户与角色管理（owner/普通）
GET  /api/v1/admin/overview                 → 连接状态/配额/审计
```

全局中间件：CORS 放行 `Authorization/Content-Type`、OPTIONS 直接 204（否则 exe/apk 报「网络不可用」，§9-坑5）。错误统一 `{ code, message }`。

***

## 7. 分阶段 Workflow

> 每个 Phase 的任务清单按序执行；「验收」全部通过才算完成。

### Phase 0 — 数据整理

**任务**

- [ ] 确认阿里云「重置系统盘」选项：Ubuntu 24.04、保留公网 IP；记下重置后的 root 密码

**验收**：密钥文件在本地且 key 实测可用。

### Phase 1 — 服务器基础设施

**任务**

- [ ] SSH 上去：`apt-get update && apt-get install -y docker.io docker-compose-v2`（或官方脚本装 docker-ce）
- [ ] 安全基线：ufw 只放行 22/8080；新建目录 `/opt/autonotice`
- [ ] 写入 `deploy/docker-compose.yml`（server + napcat 两服务，§8）；先只起 napcat：端口 `6099:6099`，挂载配置卷
- [ ] 浏览器访问 `http://<IP>:6099` 用小号 `3754609823` 扫码登录（风控号，每次容器重建都要重扫）
- [ ] NapCat WebUI 配置反向 WS 指向 `ws://server:8080/onebot/v11/ws`（compose 内网名）+ access\_token

**验收**：`docker ps` napcat 容器 running；WebUI 显示登录成功；QQ 上机器人小号在线。

**禁止**：在服务器上安装 Node/Go/pnpm 等任何语言环境——服务器永远只有 Docker。

### Phase 2 — 仓库骨架与 CI/CD 全链路（先打通「push 即部署」）

**任务**

- [ ] 新建 `v2` 分支，按 §4.3 搭 monorepo 骨架（空壳：server 返回 `/healthz` OK；client 是 Vite 默认页）
- [ ] `packages/shared` 放第一个 zod schema（healthz 响应）
- [ ] GitHub Actions：`ci.yml`（typecheck+lint+test+client build）；`deploy.yml`（main push → docker build → `ghcr.io/simchming/autonotice-server` → SSH 到服务器执行 `deploy/deploy.sh`）
- [ ] repo 配置 Secrets：`SSH_PRIVATE_KEY`、`SERVER_HOST`、`GHCR_TOKEN`
- [ ] 服务器 `/opt/autonotice/` 放 `docker-compose.yml` + `.env`（LF 换行、600 权限！§9-坑3）
- [ ] server Dockerfile：多阶段构建（builder 装 pnpm+deps+build → 运行层 `node:20-slim` + pruned 产物）；compose 里 napcat 与 server 同网络

**验收**：push 一个空提交到 main → Actions 全绿 → 服务器容器自动更新（`docker inspect` 的 image digest 变化）→ `curl http://<IP>:8080/healthz` 返回 200 → NapCat 反向 WS 重连成功（server 日志）。

**禁止**：CI 里跳过测试；把任何密钥写进 compose/代码。

### Phase 3 — 服务端核心（auth + bind + OneBot 接入）

**任务**

- [ ] drizzle schema §5 全表 + 首版迁移跑通
- [ ] auth 路由（register/login，JWT）；bind 路由（start/confirm，绑定码 10 分钟有效）
- [ ] `onebot/normalize.ts`：message 双形态兼容（段数组 / CQ 字符串，正则兜底提取 @）
- [ ] `pipeline/ingest.ts`：NapCat 事件 → 归一化 → `messages` 表入库 + 分发钩子（本阶段只打日志）
- [ ] `bot/handle.ts` 最小版：群里 @ 机器人时回复固定文案（验证触发链路）

**验收**：curl 完成 注册→登录→start 绑定→QQ 大号在群里发码→confirm 成功；群内 @ 机器人收到固定回复；重启容器后 JWT 与绑定关系仍在。

**禁止**：本阶段不接 LLM。

### Phase 4 — 日程提取管线 + 提醒

**任务**

- [ ] `pipeline/fetcher.ts`：链接抓取（SSRF 私网拦截、2MB 上限、UA 伪装、Jina Reader 可选开关）
- [ ] `pipeline/extract.ts`：LLM JSON 模式抽取日程（prompt 含 "json" 关键词；思考链关闭；单次合并「思考+结构化」，非法 JSON 才重调一次）
- [ ] `pipeline/merge.ts`：与既有日程 LLM 比对去重（多群重复信息不重复建日程）
- [ ] `scheduler/`：node-cron 到点扫描 `alerts` → WS 推送 + QQ 私聊兜底
- [ ] `notify/hub.ts`：WS 连接管理（鉴权、断线重连、按 user\_id 定向）

**验收**：测试群发一条含明确截止时间的作业消息 → 60 秒内 `schedule_items` 出现新行且带群来源 → 模拟到点后 WS 客户端收到提醒 payload；重复发同一条消息不产生重复日程。

**禁止**：抓取无上限、不做 SSRF 防护。

### Phase 5 — 客户端三端

**任务**

- [ ] Vite + React 骨架，路由/守卫/store 从旧 Taro 代码逐页迁移（页面清单见 §4.3；样式 scss 与组件逻辑直接搬，去掉 Taro API 换 web 标准）
- [ ] 不要暴露服务器的后台地址给普通用户，只有主人可以看到后台
- [ ] `services/api.ts` 用 shared 类型；API 地址一律**同源相对路径** `/api/v1`
- [ ] `services/notify/` 平台分流（web Notification / capacitor local-notifications / tauri plugin）
- [ ] 分辨率自适应：根据OS和像素比例用侧边栏布局，否则手机布局，监听 resize/orientation 即时切换
- [ ] 一键排程页：中文思考链折叠展示、每条日程显示群聊来源（群号+头像+群名）
- [ ] Capacitor 壳（`usesCleartextTraffic=true`、androidScheme=http）出 debug APK；Tauri 壳出 exe/msi（**不得有 notification 空配置**）
- [ ] server 用 `@fastify/static` 内嵌 client 构建产物（容器内 copy）

**验收**：浏览器 + Android 真机 + Windows exe 三端登录同一账号看到同一日程；Android/Windows 明文 HTTP 访问服务器不报「网络不可用」；到点手机弹本地通知并可震动。

**禁止**：把 API 地址硬编码成 IP/域名；在 Tauri 配置里留空插件对象。

### Phase 6 — 鲸鱼娘机器人 + 记忆（v3 方案）

**任务**

- [ ] `bot/persona.ts`：从旧版 `server/internal/bot/prompt.go`（v1.0.3，GitHub main 分支）**全文迁移**人格与 JSON 契约（reply/command/api/autonotice/memory/segments/doc）
- [ ] `bot/chat.ts`：工具循环（≤6 轮：api → 结果回填继续；command 仅主人；都空则结束）；发送前 CQ 码按能力开关清洗；>1500 字分段时**以 CQ 码为原子边界切分**（图片/文件码绝不从中间切断）
- [ ] `bot/memory.ts` + `bot/history.ts` + 摘要任务：按 §4.5 实现（embedding 用 dashscope text-embedding-v4，暴力余弦 top5）
- [ ] `bot/shell.ts`：主人专属 bash 持久会话（cwd 保持、60s 超时、256KB 截断、`reset/重置` 重建、输出哨兵协议）
- [ ] 私聊限流（普通用户 3 次/5 分钟，超限返回人机话术不调 LLM）；主人无限
- [ ] 权限门控全部按 §4.6 落实（身份行注入 prompt；agent 动作剥 target 参数）

**验收**：@ 机器人闲聊有人格、不认错主人；主人 `/sh ls` 免模型直通 shell，普通用户要 shell 被调皮拒绝；**重启容器后机器人记得重启前的对话**；跨会话语义召回生效（验收见 §4.5）；长消息带 `[CQ:image,...]` 时图片正常发出（上一代经典 bug）。

**禁止**：引入向量数据库/Redis/多层指针——记忆就 §4.5 三个概念；让模型自己判断权限。

### Phase 7 — 后台管理 + Agent API

**任务**

- [ ] admin 路由组（JWT 双 scope）：settings 热更新（模型预设选择按钮：通义闪速/Plus/Max、DeepSeek Chat/思考 + 自由输入；密钥提交含 `*` 则保留旧值）、能力七开关、用户与角色管理、审计
- [ ] settings 优先级：DB `settings` 表 > `.env`（与上代一致，改 .env 不重启不生效的坑不再犯）
- [ ] 主人 QQ `3874095145` 免密 SSO 进后台（onebot 在线时验证发起者）
- [ ] `/api/v1/agent/*` 标准动作接口（供任意外部 LLM 调用：notify.send / client.alarm / schedule.\*）+ `agent_actions` 审计
- [ ] 文档生成（xlsx/docx/pdf，配额默认 2/人/日，容器内装中文字体防 PDF 乱码）
- [ ] admin 前端页（复用 client 路由 `/admin`，自适应三档）

**验收**：后台改模型 → 下一条机器人消息即用新模型（无需重启）；普通用户 token 访问 `/admin/*` 返回 403；主人从 QQ 侧发起可免密进后台；文档生成下载成功且配额生效。

**禁止**：admin 接口与普通接口共用同一 guard。

### Phase 8 — 上线切换、退役

**任务**

- [ ] 全链路回归：Phase 3\~7 的验收口径全部重跑一遍
- [ ] 观察期：连续 48h `docker logs` 无 ERROR、NapCat 无掉线、提醒准点
- [ ] `v2` 分支合回 `main`；改写 `HANDOFF.md` 为 v2 运维手册（内容以本文档 §8 为基础）；`docs/` 归档旧文档
- [ ] 清理：CI 旧 secret、ghcr 旧镜像 tag、本地 `release/` 旧产物归档

**验收**：旧日程在新客户端全部可见；机器人对新旧消息都能正常排程；48h 稳定运行。

**禁止**：观察期内做任何结构性改动。

***

## 8. 部署与运维（新方式）

### 8.1 docker-compose.yml（deploy/，服务器 /opt/autonotice/ 同名文件）

```yaml
services:
  server:
    image: ghcr.io/simchming/autonotice-server:latest
    restart: unless-stopped
    ports: ["8080:8080"]
    env_file: .env
    volumes: ["./data:/app/data"]        # SQLite
    depends_on: [napcat]
    mem_limit: 512m
  napcat:
    image: mlikiowa/napcat-docker:latest
    restart: unless-stopped
    environment: [ACCOUNT=3754609823]
    ports: ["6099:6099"]                  # WebUI 扫码入口
    volumes: ["./napcat:/app/napcat"]     # 登录态持久化（风控号仍可能要求重扫）
    mem_limit: 768m
```

### 8.2 发布流程（唯一方式）

```
git push origin main
  → GitHub Actions: test → docker build → push ghcr.io/simchming/autonotice-server:latest
  → Actions SSH: ssh root@<SERVER_HOST> "cd /opt/autonotice && ./deploy.sh"
deploy.sh = docker compose pull && docker compose up -d && curl -f healthz && docker image prune -f
```

回滚：`docker tag` 保留最近 3 个版本镜像（deploy.yml 里给每次部署打 `v<run_number>` tag），回滚 = 改 compose image tag 再 up。

### 8.3 日常运维速查

```bash
docker compose ps / logs -f server        # 状态/日志
docker compose restart server             # 重启（NapCat 不动，WS 自动回连）
# NapCat 掉线（小号风控）: 浏览器 http://<IP>:6099 扫码
curl http://127.0.0.1:8080/healthz        # 健康检查
```

注意：**重启 server 容器不影响 NapCat 登录态**；只有重建 napcat 容器/重置服务器才要重新扫码。

***

## 9. 坑清单（上代真实事故，全部继承为硬约束）

1. **小号风控**：`3754609823` 每次 NapCat 容器重建都要扫码，无解，写进运维预期。
2. **OneBot message 双形态**：可能是段数组或 CQ 码字符串，@ 检测两路都要兜底。
3. **CRLF/LF**：Windows 生成的 `.env`/配置上传 Linux 会带回车符引发 400/解析错。所有上服务器文件 LF + 600 权限；CI 构建在 Linux runner 上做，天然规避。
4. **服务器小内存（2G）**：**永远不在服务器上编译，要节约使用内存！**（上代 go build 曾 OOM 僵死 sshd 需控制台重启）。v2 一切构建在 GitHub Actions（免费 runner 7G 内存）。
5. **CORS**：必须放行 `Authorization/Content-Type`、OPTIONS 预检 204，否则 exe/apk 报「网络不可用」。
6. **PowerShell + ssh 传参**：双引号被吞、`$()` 被本地展开。远程命令一律写成 `.sh` 文件 scp 后执行（deploy.yml 里用 action 封装，规避此坑）。
7. **Android 明文流量**：`usesCleartextTraffic=true` + capacitor `androidScheme=http`，否则 Android 9+ 拦截。
8. **Tauri notification 空对象配置**导致 exe 静默崩溃——插件配置要么完整要么不写。
9. **qwen JSON 模式**：prompt 必须包含字面 `json` 关键词，否则 400。思考链：排程默认开、聊天/结构化抽取显式关（省时）。
10. **API 密钥失效症状**：机器人@时固定回兜底话术——先查 key 有效性（401 日志），别怀疑别的。
11. **绑定流程**：客户端填**大号 QQ**（不是机器人号）；绑定码必须由大号本人在群 `1130297603` 发；机器人自身发的码无效。
12. **API 地址用同源相对路径**，硬编码 IP/域名会在跨端访问时全体翻车。
13. **消息分段以 CQ 码为原子边界**，否则 `[CQ:image,...]` 被切断导致图片丢失（上代 v1.0.3 遗留 bug，v2 必修）。
14. **模型说发图却没发**：分段动作（segments 内 api/autonotice）必须无条件执行，不能因「自动分段关闭」被丢弃。
15. **单实例纪律**：只允许 compose 管理的一份实例；排障先 `docker ps` 确认无重复容器。
16. **历史注入上限**（沿用上代调优值）：历史日程≤20 条仅未完成、单条群消息截断 300 字、定时排程窗口 240 条、手动 400 条、LLM 超时 180s。
17. **构建顺序**：H5 build → cap sync → gradle；Tauri 的 beforeBuildCommand 会重建 dist，别在中间插 cap sync。
18. **exe 被占用**：Windows 上正在运行的 exe 无法覆盖，产物文件名带版本号避免冲突。

***

## 10. 状态追踪表（执行 AI 每完成一项更新此处）

| Phase          | 状态    | 完成时间   | 备注     |
| -------------- | ----- | ------ | ------ |
| 0 数据抢救         | ☐ 未开始 | <br /> | <br /> |
| 1 服务器重置+基础设施   | ☐ 未开始 | <br /> | <br /> |
| 2 骨架+CI/CD     | ☐ 未开始 | <br /> | <br /> |
| 3 服务端核心        | ☐ 未开始 | <br /> | <br /> |
| 4 日程管线         | ☐ 未开始 | <br /> | <br /> |
| 5 客户端三端        | ☐ 未开始 | <br /> | <br /> |
| 6 机器人+记忆       | ☐ 未开始 | <br /> | <br /> |
| 7 后台+Agent API | ☐ 未开始 | <br /> | <br /> |
| 8 迁移+上线        | ☐ 未开始 | <br /> | <br /> |

### 决策日志（文档未覆盖的现场决策，追加于此）

- 2026-10-21 Phase 0：已用 `deepseek-v4.1-flash` 实测 §3.1 的 dashscope Key，HTTP 200 可用（默认返回 reasoning_content，聊天/抽取需显式关闭思考链）。
- 2026-10-21 Phase 2：镜像推送改用 Actions 内置 `GITHUB_TOKEN`（`packages: write`），不再需要 `GHCR_TOKEN` secret；仍需配置 `SSH_PRIVATE_KEY`、`SERVER_HOST`。
- 2026-10-21 Phase 2：`deploy.yml` 在 SSH 部署前用 scp 同步 `docker-compose.yml` 与 `deploy.sh` 到 `/opt/autonotice`（不含 `.env`），避免服务器手工文件漂移。
- 2026-10-21 Phase 2：服务端构建采用 `tsc` 输出 + 镜像内保留 `/repo` 目录布局复制 `node_modules`（不做 esbuild 打包），为 Phase 3 引入原生模块 `better-sqlite3` 留出余地。
- 2026-10-21 Phase 2：客户端 Vite 用别名直接解析 `packages/shared/src/index.ts`，避免 shared `dist` 过期导致契约不一致。
- 2026-10-21 Phase 2：本地 pnpm 通过 `corepack enable --install-directory %LOCALAPPDATA%\node-shims` 安装（无管理员权限），未写入全局 nodejs 目录。
- 2026-10-21 Phase 1：服务器重置镜像实际为 Ubuntu 22.04.5（非 24.04），Docker 29.1.3 + Compose 2.40.3（apt 源 docker.io / docker-compose-v2），按 22.04 继续推进。
- 2026-10-21 Phase 1：服务器直连 Docker Hub 超时，已在 `/etc/docker/daemon.json` 配置镜像加速 `docker.1ms.run` + `docker.m.daocloud.io`；ghcr.io 从该服务器可达（401 属正常鉴权响应），部署链路不受影响。
- 2026-10-21 Phase 1：NapCat WebUI 的 6099 端口按 §8.3 运维方式对公网放行（扫描二维码需要），服务器 ufw 同时放行 22/8080/6099。
- 2026-10-21 Phase 1：CI 部署使用专用 ed25519 密钥 `~/.ssh/autonotice_deploy`（已加入服务器 authorized_keys），私钥写入仓库 Actions Secret `SSH_PRIVATE_KEY`，不提交入库。
- 2026-10-21 Phase 2：现有 classic PAT 仅 `repo` scope，无法推送 `.github/workflows/`；推送与 CI 验证需 token 补 `workflow` scope 后继续。
- 2026-10-21 Phase 1：Docker Hub 直连及各公共镜像均不稳定，最终用 `hub.rat.dev/mlikiowa/napcat-docker:latest` 拉取后重打 tag 为 `mlikiowa/napcat-docker:latest`；NapCat WebUI 端口 6099 正常。
- 2026-10-21 Phase 1：NapCat 容器新增 `./napcat/qq:/app/.config/QQ` 挂载以持久化 QQ 登录态，避免重建容器后重复扫码。
- 2026-10-21 Phase 2：服务器从 ghcr.io 拉取镜像速度约 100 KB/s，部署脚本超时放宽到 1800s、ssh-action `command_timeout: 30m`；首次拉取耗时较长，后续命中本地层会明显加快。
- 2026-10-21 Phase 2：为在 v2 分支完成验收，deploy.yml 的 push 触发分支暂含 `v2`，Phase 8 合并回 main 后可恢复仅 main。

