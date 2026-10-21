# QQ 群 AI 日程助手 — 实现计划

## Context（为什么做这件事）

大学 QQ 群里每天有大量零散但重要的信息（考试时间、作业 DDL、班费缴纳、活动通知…），
这些信息淹没在闲聊里，持续分散注意力，且容易漏掉。

本项目要做一个**端到端闭环系统**：把 QQ 群里与「我」相关的消息自动抓取出来，
结合我已有的日程由 AI 生成结构化日程，存成云端 JSON，再由手机/电脑客户端**本地定时弹屏提醒**，
我在客户端打勾/修改后回写云端，形成「消息 → AI 总结 → 提醒 → 闭环」的完整链路。

**预期结果**：群消息里真正与个人相关的待办/日程不再靠人肉翻聊天记录，
而是自动变成带提醒的可勾选日程，跨 Windows / iOS / Android 三端一致。

## 已确认的决策（来自与用户的澄清）

| 项     | 决策                                                                        |
| ----- | ------------------------------------------------------------------------- |
| QQ 接入 | OneBot 协议（NapCat 为主，Lagrange 为可切换备胎），个人 QQ 号登录                            |
| 服务端   | Go 单一静态二进制                                                                |
| 部署    | **放弃玩客云**；阿里云 Ubuntu 服务器（x86\_64，有公网 IP）。bot 与服务端**同机部署**，公网直连，**无需内网穿透** |
| 客户端   | Taro (React) 一套代码 → 产出 H5，再用壳打包三端                                         |
| 身份绑定  | APP 内手动绑定 QQ 号，服务端做「群内验证码」二次验证                                            |

## 核心技术结论（已查证）

1. **Taro 4 官方端只有 H5 / React Native / 小程序 / ASCF，不产 Windows 桌面**。
   因此采用：**Taro 只产 H5 作为唯一核心**，再用壳打包：

   * iOS / Android → **Capacitor** + `@capacitor/local-notifications`（纯本地定时，无需推送证书）

   * Windows → **Tauri 2**（体积 2–25MB / 内存 28–60MB，远优于 Electron）+ `plugin-notification.schedule` + 系统托盘 + 开机自启

   * 风险：Taro H5 被壳加载需用 **hash 路由** 或配 `base`，否则 `file://` 下 404
2. **NapCat.Shell** 可用官方一键脚本装到 Ubuntu（需 Xvfb；40+;amd64/arm64），配置**反向 WebSocket**（`websocketClients.url → ws://127.0.0.1:8080/onebot/v11/ws`，带 token）。
   非官方框架，**有封号风险** → 建议用**独立小号**、不同 IP/设备、勿随意更新 QQ 客户端。
3. **DeepSeek** 走 OpenAI 兼容接口（`https://api.deepseek.com`），支持 **JSON 输出**与 Function Calling；JSON 模式偶发空 content/截断 → 必须 **重试 + schema 校验**，失败**不覆盖**旧日程。
   **模型名以部署时官方文档为准，做成配置项**（默认用当前主力 chat 模型，质量不足时再升级）。
4. **iOS 本地通知硬上限：每 App 最多 64 条 pending**（系统限制，无法绕过）→ 必须**滚动排程**。
   **Android 12+** 精确定时需 `SCHEDULE_EXACT_ALARM`，Doze 下用 `allowWhileIdle`（每 9 分钟最多一次）。
   **WorkManager 类后台任务非精确定时（最小 15 分钟）**，只能用于后台刷新，不能当闹钟。
5. **群文件/链接/小程序内容理解（用户新增需求）**：
   - NapCat 支持 `get_group_file_url` / `get_group_root_files` / `get_file` / `check_url_safely` 等；消息里的 `file` 段自带 `url/file_id/file_size`，但**普通文件直链下载次数受限、鉴权 URL 会过期** → **不缓存 URL，抓取前重新调 `get_group_file_url`**。
   - 小程序/微信链接（`#小程序://`、`weixin://`、`wxaurl.cn`、`mp.weixin.qq.com` 文章）**服务端基本抓不到**（需微信客户端 / 数据中心 IP 被判"环境异常"）→ 一律**优雅降级为「需人工查看」**，但仍把卡片 title/desc + 上文写进通知。
   - 网页抓取采用**两级**：一级纯 Go 直抓（`net/http` + go-readability + goquery，零依赖、护隐私）；二级回退 **Jina Reader**（`https://r.jina.ai/<url>`，自带无头渲染、能解析 PDF、有免费额度）。**默认不自建 Chromium**（省 ~1.3GB 内存），**不做 OCR**（扫描件判为需人工）。
   - 文件解析：`.pdf`→`ledongthuc/pdf`（或可选 `pdftotext`）；`.xlsx/.xlsm`→`excelize/v2`；`.xls`→`extrame/xls`；`.docx`→zip+xml 自研；`.doc`→无可靠纯 Go 方案，判需人工（可选 `antiword`/`catdoc`）。

## 目标架构

```
        阿里云 Ubuntu (公网 IP) —— bot 与 server 同机
 QQ 群 ─► NapCat.Shell (个人小号登录, systemd + Xvfb)
            │  OneBot V11 反向 WS (ws://127.0.0.1:8080/onebot/v11/ws, Bearer token)
            ▼
         ┌──────────── Go 单静态二进制服务端 ────────────┐
         │ OneBot 适配层(Provider 接口) → 归一化/去重 → SQLite 消息库 │
         │   ├ ingest: 抽取 file / link / 小程序段 → content_assets 队列  │
         │   ├ contentfetch(异步): SSRF安全直抓 + Jina回退 + 文件解析 +
         │   │   屏蔽判定 → 正文/状态落库                                 │
         │   ├ analyze: title vs 正文比对 + 生成"需人工查看"通知文案(DeepSeek) │
         │   ├ 定时调度器(cron, TZ=Asia/Shanghai)                        │
         │   │   └ 按绑定用户聚合 文本消息+内容资产+历史日程 → DeepSeek(JSON) → 日程 │
         │   ├ REST API(JWT) ◄── 日程仓库(items, revision 乐观锁) + alerts  │
         └───────────────────────────────────────────────┘
                    ▲ HTTPS 公网直连        ▲ 可选 WS 推送"日程已更新"
                    │                       │
         Taro(React) 单一 H5 代码库：页面 / API / 同步 / 跨端通知抽象
                    │
     Capacitor(iOS)   Capacitor(Android)   Tauri 2(Windows)
     LocalNotifications(≤64 滚动)  +精确告警  schedule+托盘+自启
```

## 项目目录结构（新建）

```
default/
├── server/                              # Go 服务端
│   ├── cmd/app/main.go
│   ├── internal/
│   │   ├── config/                      # YAML + env 覆盖
│   │   ├── onebot/
│   │   │   ├── provider.go              # ★ 协议无关接口（切 NapCat/Lagrange 的关键）
│   │   │   ├── event.go                 # 归一化事件模型
│   │   │   ├── v11/reverse_ws.go        # 反向 WS 服务端 + 双工 action 调用
│   │   │   ├── v11/http_post.go         # 备选上报模式
│   │   │   └── v11/apicaller.go
│   │   ├── ingest/                      # 事件 → 去重(指纹) → 落库 + extract.go(抽取文件/链接段)
│   │   ├── contentfetch/                # ★ 新增：内容抓取与解析
│   │   │   ├── resolver.go              # 消息段 → 引用；调 get_group_file_url 取直链
│   │   │   ├── ssrf.go                  # 安全 Dialer / URL 校验（防内网抓取）
│   │   │   ├── httpfetch.go             # 纯 Go 直抓 + goquery + go-readability
│   │   │   ├── jina.go                  # Jina Reader 二级回退
│   │   │   ├── blocked.go               # 屏蔽启发式判定
│   │   │   ├── pipeline.go              # 编排：并发信号量 + 指纹缓存
│   │   │   └── docparse/                # detect/pdf/xlsx/xls/docx/csv/text/zipguard
│   │   ├── analyze/                     # ★ 新增：title↔正文比对 + 通知文案生成
│   │   │   ├── compare.go / prompt.go   # 复用 summarize 的 DeepSeek client + 重试
│   │   │   └── notifygen.go             # 降级模板文案
│   │   ├── store/                       # SQLite 仓储 + migrations
│   │   ├── schedule/                    # 日程模型 / 合并 / 冲突 / 导出 JSON
│   │   ├── summarize/                   # 聚合 + prompt + deepseek.go + 校验重试
│   │   ├── scheduler/                   # cron 触发
│   │   ├── auth/                        # JWT + 绑定验证码
│   │   ├── httpapi/                     # 路由/handler/中间件（含 alerts.go）
│   │   └── notify/                      # WS 推送 + alert 推送（可选 QQ 私聊）
│   ├── migrations/
│   ├── configs/config.example.yaml
│   └── deploy/app.service, napcat.service, docker-compose.yaml
└── client/                              # Taro H5 核心 + 壳
    ├── src/
    │   ├── pages/{login,bind,schedule,calendar,detail,settings}
    │   ├── services/{api.ts,sync.ts,notify/{types,capacitor,tauri,web,platform,scheduler}.ts}
    │   ├── store/                       # zustand
    │   └── utils/
    ├── capacitor/                       # npx cap add ios/android
    └── desktop/ (Tauri 2: src-tauri/)
```

## 服务端要点

### 核心数据模型（SQLite）

* `groups` / `messages`（含 `fingerprint` sha1 幂等去重、`mentions`/`reply_to_msg_id` 便于聚合）

* `users` / `bindings`（`verified` 标记）/ `bind_codes` / `summary_runs`

* `schedule_items`：`id`(UUID 跨设备稳定)、`title/type/due_at/remind_at/status/priority/notes`、
  `locked_by_user`（用户改过 → AI 不再覆盖）、`source_json`、`revision`（乐观锁）

* **对外日程 JSON 文档**：`GET /schedules/me` 返回 `{user_id, qq_uid, generated_at, revision, digest, items[]}`，
  每条 item 带 `source{kind,group_id,message_ids,excerpt,confidence}`。

### 关键 API（REST + 可选 WS）

* `auth/register|login`（JWT）

* `bindings/qq/initiate`（发验证码）→ `bindings/qq/confirm`（校验）→ `bindings`（增删查）

* `GET /schedules/me`、`GET /schedules/me/delta?since=rev`、`POST /schedules/me/sync`

* `POST|PATCH|DELETE /schedules/me/items/{id}`（PATCH 带 `base_revision`，冲突返 **409 + 服务端最新项**）

* `GET /healthz`、`/metrics`

### QQ 绑定验证（防冒用）

用户在群内发 `#bind 123456`（或私聊 bot）→ NapCat 上报该事件 → 服务端比对 `sender_qq` 证明其控制该 QQ → 置 `verified=1`。**未验证绑定不进入 AI 总结**。

### DeepSeek 调用与 Prompt

* OpenAI 兼容，`response_format={"type":"json_object"}`，`max_tokens` 充足，温度中低。

* **稳定前缀（系统提示 + 输出 schema 样例）放最前**，易变消息放最后，最大化缓存命中降本。

* 聚合窗口：上次成功总结以来的增量；只挑 `sender=该用户` 或 `该用户∈mentions` 或 `回复其消息` 的消息；**只为已验证绑定用户生成**。

* 校验失败/空 content → 指数退避重试 ≤2 → 仍失败则记录 `failed` 且**不覆盖**旧日程。

### 定时

`robfig/cron`（`TZ=Asia/Shanghai`）：每日 07:00 全量增量总结；每 2 小时轻量增量（可选）；每日 23:30 清理过期码/裁剪旧消息。单用户任务独立 goroutine + recover，互不影响。

## 内容理解模块（文件 / 链接 / 小程序）★ 用户新增需求

目标：bot 不只理解纯文本，还要**下载群文件（PDF/Excel/Word/CSV）、抓取网页链接、尝试理解小程序卡片**，
用「声明的 title」与「实际抓到的内容」比对；**抓取被屏蔽时发高优先级「需人工查看」通知**，
通知正文结合 **title + 前文聊天记录** 做总结与推断，给用户充足信息而不是只丢一个链接。

### 设计决策：内容资产 + 双轨挂载
- 新建 **`content_assets`** 表：每条被识别的文件/链接/小程序卡片一行，存元数据 + 抓取结果 + 屏蔽判定，与 `messages` 通过 `message_id` 关联。
- **能解析且相关**时，AI 从中抽出的日程 item 的 `source_json` 增加 `content_asset_id / link_title / fetch_status`（**不把全文塞进日程文档**，避免膨胀）。
- **抓不到/被屏蔽/title 严重不符**时，**不生成日程 item，而生成一条 `alerts`（需人工查看）** 高优推送。单列实体便于去重、已读、推送与审计。

### 数据模型扩展（新增 migration）
```sql
CREATE TABLE content_assets (
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, message_id TEXT NOT NULL, sender_qq TEXT,
  kind TEXT NOT NULL,              -- file | link | miniapp | wechat_article
  title TEXT, declared_url TEXT,   -- 链接/卡片声明标题与 URL
  file_id TEXT, busid TEXT, file_name TEXT, file_ext TEXT, size_bytes INTEGER, mime TEXT,
  fetch_status TEXT NOT NULL DEFAULT 'pending', -- pending|ok|blocked|unfetchable|failed|too_large
  final_url TEXT, http_status INTEGER, body_text TEXT, body_chars INTEGER,
  blocked_reason TEXT,             -- login_wall|captcha|js_required|paywall|http_4xx|empty|scheme|mismatch|timeout
  content_hash TEXT, fetched_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE alerts (
  id TEXT PRIMARY KEY, user_qq TEXT NOT NULL, group_id TEXT NOT NULL, content_asset_id TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'high',
  title TEXT NOT NULL, summary TEXT NOT NULL, context_excerpt TEXT, review_reason TEXT,
  delivered INTEGER NOT NULL DEFAULT 0, read_at INTEGER, created_at INTEGER NOT NULL
);
-- messages 增加 segments_json（保留原始 OneBot 消息段，便于重放/调试）
```

### ingest 抽取（extract.go）
遍历 `message[]` 段：`file`→kind=file（记 `file_id/group_id/name/size/ext`，**不存临时内联 url**）；
`share`→kind=link；`json`/`lightapp`→解析 ark JSON 取 `title/desc/url`（scheme 则标 unfetchable）；`text`→正则抽 http(s) 链接。
**指纹去重** `sha1(group_id+kind+declared_url/file_id)`；SSRF 预校验；**全异步入队，绝不阻塞消息落库**。

### 抓取与解析流水线（pipeline.go）
```
pending → resolver(file: 调 get_group_file_url 取直链 / link: 跟随重定向≤5逐跳SSRF校验 / miniapp: 非http→unfetchable)
        → fetcher(一级 纯Go直抓 → 二级 Jina Reader 回退)
        → parser(按扩展名/MIME: pdf/xlsx/xls/docx/csv/text)
        → 落库(body_text 截断 ≤32KB + content_hash)
        → blocked(启发式判定)
        → analyze(DeepSeek 比对 + 通知文案 + 可选抽日程)
```
解析安全：`recover + 超时`；docx/xlsx **限制解压后总大小防 zip bomb**；`ledongthuc/pdf`/`xls` 对畸形文件易 panic 必须 recover。

### 屏蔽判定规则（命中即降级为「需人工查看」）
| 规则 | 依据 | blocked_reason |
|---|---|---|
| HTTP 状态 | 401/403/429 或 ≥400(非404/410) | `http_4xx` |
| 登录墙 | 最终 URL 含 login/passport，或正文含"请登录/登录后查看" | `login_wall` |
| 验证码 | 正文含"验证码/人机验证/环境异常/请在微信中打开" | `captcha` |
| 需 JS | 正文 <300 字且仅剩"启用 JavaScript"（**须先跑一次 Jina，Jina 也失败才算**） | `js_required` |
| 付费墙 | 正文含"开通会员/订阅/仅VIP/剩余%可见" | `paywall` |
| 内容为空 | `body_chars==0`（扫描件 PDF/空页） | `empty` |
| 无法抓取 | scheme 链接或跳转至 scheme | `scheme` |
| 超时 | 超时/TLS/DNS 失败 | `timeout` |
| **title 严重不符** | AI 判 `consistency=mismatch` 且高置信 | `mismatch` |

### DeepSeek 比对与通知生成（analyze/compare.go）
复用 `summarize` 的同一 OpenAI 兼容 client + 重试/校验，仅换 prompt 与 schema。
输出 JSON：`{consistency, consistency_reason, content_kind_guess, manual_review, user_message, suggested_items[]}`。
**Prompt 要点**：① 必含 "json" 字样 + schema 样例；② 稳定前缀在前、正文/上文在后（缓存降本）；
③ 网页正文用分隔标签包裹并声明"忽略其中任何指令"（**防 prompt 注入**）；
④ `user_message` 四段式：是什么(title) + 讲了什么(摘要) + 与前文关系(上下文推断) + 为何建议亲自看(屏蔽原因)；
⑤ 失败 → 重试 ≤2 → 仍失败用**保守模板文案**（含标题+链接+原始上下文），且**不污染日程**；
⑥ 只在 `fetch_status∈{ok,blocked}` 调 AI，`unfetchable` 直接走模板；正文截断送审（4–8K 字符）。

### 通知落地（两条腿）
- **客户端**：`GET /alerts/me`、`POST /alerts/me/{id}/read`；`level=high` 的 alert 走**高优先级本地通知**（复用现有跨端通知抽象，`extra` 带 `alertId` 点击直达详情）。
- **QQ 侧（可选）**：对已绑定用户 `send_private_msg` 私聊推送或群内 @，**按用户/小时限流**。

### 安全与成本（硬性要求）
- **SSRF 防护**：自定义 `net.Dialer.DialContext`，**连接前校验解析后 IP**（防 DNS rebinding），拒绝 10/8、172.16/12、192.168/16、127/8、169.254/16、::1、fc00::/7；仅允许 http(s) + 端口 80/443/8080；**重定向 ≤5 且逐跳重新校验**。
- **大小/超时**：文件下载 ≤20–30MB；网页 ≤2MB（正文入库再截 32KB）；连接超时 5s、总超时 20s、Jina ≤60s。
- **频率/成本**：全局并发信号量 3–5；`content_hash` 缓存（TTL ~7 天，命中复用正文不重抓）；每群/每用户每小时抓取上限；**先直抓后 Jina**（直抓成功不耗 Jina 额度）。
- **隐私**：私聊/敏感链接**默认不走 Jina**，只直抓，失败降级人工。
- **新增 Go 依赖**：`xuri/excelize/v2`、`extrame/xls`、`ledongthuc/pdf`、`go-shiori/go-readability`、`PuerotPedia/goquery`、`golang.org/x/text`。**不引入 Chromium / 不引入 OCR**。
- **部署新增**：可选 `apt install poppler-utils antiword catdoc` 提升解析质量（失败回退纯 Go）；`app.service` 加 `MemoryMax/TasksMax/PrivateTmp=true`；env `JINA_API_KEY` / `FETCH_MAX_BYTES` / `JINA_ENABLED`。

## 客户端要点

### 页面

登录/注册 → QQ 绑定（生成码、群内确认、轮询）→ 日程列表（今日/本周/全部）→ 日历视图 → 详情/编辑 → **待查看告警（alerts）** → 设置（提醒策略、通知权限、账号）。

**待查看告警页**：展示 `level=high` 的「需人工查看」项，每条含 AI 生成的充实文案（title + 上文推断 + 屏蔽原因）+ 原始链接/文件名；支持标记已读、一键打开原文；未读数量在 Tab 上角标显示。

**详情页增强**：当 item 来源含 `content_asset_id` 时，展示来源卡片（文件名/链接标题/抓取状态），被屏蔽的原文件提供「复制链接/文件名」方便用户去 QQ 里自行查看。

### 跨端通知抽象（关键难点）

```
PlatformNotify { ensurePermission(); cancelAllForUser(); schedule(items,{maxCount}); onAppResume(cb) }
```

**滚动排程算法**（解决 iOS 64 条上限）：

1. 启动/回到前台/收到更新时 **先取消该用户全部已排通知**；
2. 由 `remind_at`（空则由 `due_at` 减默认偏移 \[-24h,-2h,-15m]）算出提醒，外加 1 条「每日 08:00 简报」；
3. 按 `remind_at` 升序取最近 N 条：iOS/Android **≤60**，Windows **≤80**；
4. 兜底：简报通知点开触发重排，形成滚动窗口；
5. 通知 `extra` 带 `{itemId,due_at}`，点击直达详情。

分端：Android 创建 channel + `POST_NOTIFICATIONS`(13+) + `SCHEDULE_EXACT_ALARM`(12+，关闭则降级并提示) + 高优项 `allowWhileIdle`；iOS 严格守 64；Windows 用 Tauri `schedule.at` + 托盘 + autostart，不稳则降级 Rust tokio 定时线程。

### 同步策略

* 拉：`GET /schedules/me`（`If-None-Match`）或 `delta?since=rev`，本地存 `last_revision`。

* 写：`PATCH items/{id}`（带 `base_revision`）；冲突 409 → 客户端提供「保留我的 / 用服务端 / 手动合并」。

* 字段归属：AI 掌 `title/due_at/source`，客户端掌 `status/notes`；用户改内容后 `locked_by_user=true`，AI 不再覆盖。

* 离线：改动入本地队列，联网 `POST /sync` 批量提交；UUID 幂等。

## 分阶段落地

| 阶段                  | 目标                                                           | 可验证里程碑                           |
| ------------------- | ------------------------------------------------------------ | -------------------------------- |
| **P0 环境打通**         | 阿里云装 NapCat（小号登录）+ Go 骨架 `reverse_ws` + 白名单群消息落 SQLite       | 群里发消息，服务端 DB 精确出现该条              |
| **P1 单用户 MVP**      | 手工绑定 1 个 QQ；命令触发 DeepSeek 总结；浏览器 H5 展示日程                     | 浏览器能看到 AI 生成的日程条目                |
| **P2 自动 + 移动端**     | 每日 07:00 自动总结；登录/绑定/回写全链路；Capacitor 打包 iOS/Android，本地通知离线可触发 | 关掉 APP 到点仍弹通知；打勾后服务端 revision 递增 |
| **P3 Windows + 日历** | Tauri 打包 Windows（通知/托盘/自启）；日历视图；冲突处理 UI                      | 安装版到点提醒；并发改同项触发 409 并正确合并        |
| **P4 打磨**           | 历史回填、增量总结、幂等与监控、成本报表、iOS 64 条压测、厂商保活指引                       | 连续运行 7 天无重复/漏总结                  |
| **C0 内容识别**        | ingest 识别 file/link/小程序段 → `content_assets`；`/alerts/me` 路由骨架 | 群里发一个 PDF/一条链接 → DB 出现 asset 记录  |
| **C1 抓取解析**        | SSRF 安全直抓 + `get_group_file_url` 下载 + pdf/xlsx/docx/csv 解析 | 上传 xlsx → 落库出现解析文本                 |
| **C2 屏蔽与告警**      | 屏蔽判定 + Jina 回退 + DeepSeek 比对 + 模板降级 + 客户端高优 alert | 发一个需登录的链接 → 客户端收到高优「需人工查看」      |
| **C3 小程序与融合**    | 小程序/微信链接优雅降级 + 与日程 item.source 融合 + 抓取缓存/成本报表 | 发 `#小程序://` 卡片 → 正确降级且通知含 title+上下文 |

## 待确认/需用户提供的输入

* **DeepSeek API Key**（放服务端环境变量 `DEEPSEEK_API_KEY`，不入库不入 git）。

* **（可选）Jina Reader API Key**（`JINA_API_KEY`，提升网页抓取二级回退额度；不填也能用免费 20 RPM）。

* **目标 QQ 群号** 与 **用于 bot 的独立小号**（强烈建议不要用主号，降低连坐风控风险）。

* 阿里云 Ubuntu 服务器访问方式（SSH）。

* Apple 开发者账号（iOS 打包需要；本地通知本身无需推送证书）。

## 验证方式（端到端）

1. **P0**：NapCat 连上后，群里发一条消息 → 查 SQLite `messages` 表内容一致；伪造 token 连接被拒。
2. **P1**：`curl` 手动触发总结 → 检查 `GET /schedules/me` 返回合法 JSON 且条目与消息语义吻合。
3. **P2**：iOS/Android 真机安装 → 关闭 App → 到点收到本地通知；在 App 打勾 → 服务端 `revision+1` 且客户端重启后状态保持。
4. **P3**：Windows 安装 Tauri 包 → 托盘常驻、开机自启、到点弹通知；两台设备同时改同一 item → 一方得 409 并按选定策略合并，服务端无脏数据。
5. **异常路径**：断网后离线打勾 → 恢复网络自动 `sync` 成功；DeepSeek 返回空/非法 JSON → 本次不覆盖旧日程且记录 `summary_runs.status=failed`。
6. **文件解析**：群里上传文字型 PDF / xlsx → `content_assets.body_text` 有内容、`fetch_status=ok`。
7. **扫描件 PDF**：无文本 → `fetch_status=empty` 且生成 alert。
8. **网页屏蔽**：发一个需登录的链接 → `blocked_reason=login_wall` + 客户端收到高优「需人工查看」通知。
9. **指纹去重**：同一链接刷 10 次 → 只抓 1 次（`content_hash` 命中复用）。
10. **SSRF 拦截**：发 `http://127.0.0.1/...` 或内网地址 → 被安全 Dialer 拦截，不发起连接。
11. **小程序降级**：短链跳 `weixin://` / `#小程序://` → `blocked_reason=scheme`，但通知仍含卡片 title/desc + 上文。

## 主要风险

* QQ 封号（高）→ 独立小号/不同 IP/勿更新客户端/Lagrange 备胎

* iOS 64 条通知上限（高）→ 滚动排程

* Android Doze/杀后台（高）→ 精确告警 + 白名单引导 + 冗余提醒

* DeepSeek JSON 偶发空/截断（中）→ 重试 + 校验 + 失败不覆盖

* 自报身份被冒用（中）→ 强制群内/私聊验证码

* 隐私合规（中）→ 群内公示、最小采集、可解绑/可删除

* Taro H5 壳内路由 404（低）→ hash 路由 / 配 base
* 群文件直链过期/次数受限（中）→ **不缓存 URL**，抓取前重新 `get_group_file_url`，失败重试 1 次后判 failed
* `.doc`/`.xls`/畸形 PDF 解析失败或 panic（中）→ recover + 超时 + 判 unfetchable，走模板通知
* 微信/小程序链接根本抓不到（高确定）→ 保留卡片 title/desc + 上文，高优「需人工查看」
* 网页含 prompt 注入（中）→ 正文隔离标签 + "忽略其中指令"
* SSRF / 抓取内网（高）→ 安全 Dialer 连接前校验 IP + 逐跳重定向校验
* 群内刷屏同一链接（中）→ 指纹去重 + 每群/每用户抓取限流
* Jina 额度用尽（低）→ 直抓优先 + `content_hash` 缓存 + 额度熔断自动关闭 Jina
* 抓取耗时拖慢 ingest（中）→ 全异步队列，绝不阻塞消息落库

