# QQ 群 AI 日程助手 — 工程交接文档

> 本文档面向零上下文的开发者/AI，覆盖架构、模块、数据流、构建、部署、运维与全部已知坑。
> 阅读顺序：概述 → 架构 → 模块详解 → 数据库 → 配置 → 构建 → 部署运维 → 已知问题。

---

## 1. 项目概述

一个 QQ 群 AI 日程助手：机器人小号挂在一个 QQ 群里，群友发消息（含链接/文件/图片）后，服务端抓取内容并用 DeepSeek 提取日程，用户在多端客户端（Windows exe / Android APK / 浏览器 H5）查看和管理日程。附带一个「鲸鱼娘顽皮女仆」人格的聊天机器人，支持 @ 对话、root shell 控制（仅授权 QQ）、OneBot 全接口调用、长期记忆碎片、私聊限流。

| 项 | 值 |
|---|---|
| 服务端 | Go 1.23，单二进制 `qqsched`，内嵌前端产物，监听 `:8080` |
| 客户端 | Taro 4 (React 18) H5 核心 + Tauri 2（Windows）+ Capacitor 6（Android） |
| 数据库 | SQLite（modernc.org/sqlite 纯 Go 驱动，无 CGO），`data/app.db` |
| LLM | DeepSeek `deepseek-chat`，JSON 输出模式模拟 tool calling |
| QQ 接入 | NapCat + OneBot v11 反向 WebSocket |
| 生产服务器 | `120.26.224.86`（阿里云，Ubuntu 22.04），root SSH（凭据由项目持有者私下提供，未落盘） |
| 部署目录 | `/opt/qqsched` |
| 机器人小号 | `3754609823`（有腾讯风控，NapCat 重启后必须重新扫码） |
| 授权控制大号 | `3874095145`（唯一可操作 root shell 的 QQ） |
| 主群 | `1130297603`（绑定码须在此群发送） |

---

## 2. 总体架构（文字图）

```
┌──────────────────┐                ┌─────────────────────────────────┐
│   腾讯 QQ 服务器   │                │   阿里云主机 120.26.224.86        │
│                  │                │                                 │
│  群 1130297603    │   QQ 协议      │  ┌───────────────────────────┐  │
│  机器人小号       │◄──────────────►│  │ NapCat (QQ 客户端壳)        │  │
│  3754609823      │                │  │ · screen 会话: napcat      │  │
│                  │                │  │ · WebUI: http://127.0.0.1  │  │
│                  │                │  │   :6099（扫码登录入口）      │  │
│                  │                │  │ · 开机自启:                 │  │
│                  │                │  │   /root/napcat-autostart.sh│  │
│                  │                │  └────────────┬──────────────┘  │
│                  │                │               │ OneBot v11      │
│                  │                │               │ 反向 WebSocket  │
│                  │                │               │ (token 鉴权)    │
│                  │                │               ▼                 │
│                  │                │  ┌───────────────────────────┐  │
│                  │                │  │ qqsched (Go, :8080)       │  │
│                  │                │  │ systemd: qqsched.service  │  │
│                  │                │  │ user=qqsched + sudo 免密   │  │
│                  │                │  └────────────┬──────────────┘  │
└──────────────────┘                └───────────────┼─────────────────┘
                                                    │
                       ┌────────────────────────────┼──────────────────────┐
                       │ HTTPS /api/v1              │ HTTPS                │
                       ▼                            ▼                      ▼
             ┌──────────────────┐        ┌────────────────┐    ┌────────────────┐
             │ 浏览器 H5        │        │ DeepSeek API   │    │ Jina Reader    │
             │ (go:embed 静态页) │        │ api.deepseek   │    │ r.jina.ai      │
             ├──────────────────┤        │ .com           │    │ (网页正文抓取)  │
             │ Windows exe      │        └────────────────┘    └────────────────┘
             │ (Tauri 2 壳)     │
             ├──────────────────┤
             │ Android APK      │
             │ (Capacitor 6 壳) │
             └──────────────────┘
```

### server-client 架构（文字图）

```
┌────────────────────────── 客户端（同一份 Taro H5 核心）──────────────────────────┐
│                                                                                 │
│  pages: login → bind → schedule(主页) / detail / calendar / alerts / settings    │
│  状态: zustand (auth/schedule/alerts/notify/replan)                              │
│  通知: services/notify 按 platform 分流 (tauri / capacitor / web)                 │
│  特性: 自动登录、分辨率自适应、群聊来源展示(群号+头像+群名)、DeepSeek 思考链折叠展示  │
│                                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                                      │
│  │ Tauri 2  │  │Capacitor6│  │ 浏览器    │   全部通过 HTTP 访问同一个服务端       │
│  │ Windows  │  │ Android  │  │ (嵌入)   │   Authorization: Bearer <JWT>        │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                                      │
└───────┼─────────────┼─────────────┼────────────────────────────────────────────┘
        │  明文 HTTP    │  明文 HTTP   │ 同源                                        │
        ▼             ▼             ▼                                             │
┌────────────────────────────────────────────────────────────────────────────────┐
│ 服务端 REST API（base_path=/api/v1，全部带 CORS：放行 Authorization/Content-Type，  │
│ OPTIONS 预检直接 204 —— 否则桌面 exe 与 apk 会报"网络不可用"）                      │
│                                                                                 │
│  POST /auth/register  POST /auth/login        → JWT (TTL 720h)                  │
│  POST /bind/start     POST /bind/confirm      → 绑定码流程                       │
│  GET  /schedules …    日程 CRUD + 同步                                         │
│  GET  /alerts …       提醒列表                                                 │
│  POST /replan …       一键实时排程（DeepSeek 思考链中文展示）                       │
│  GET  /healthz        健康检查（无鉴权）                                         │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 消息处理主链路（文字图）

```
QQ 群消息
  │
  ▼
NapCat ──反向WS──► onebot/v11/reverse_ws ──► event.NormalizeV11() 归一化
  │                                              (消息段数组 或 CQ字符串 双兼容,
  │                                               CQ字符串时用正则提取 @ 目标)
  ▼
ingest.dispatchResponder()
  ├──► bot.HandleMessage()  (detached goroutine, 见 §4.2)
  └──► allowed() 群白名单过滤 ──► ensureGroupName() (groupmeta 缓存)
              │
              ▼
      store.UpsertMessage / content_assets
              │
              ▼
      contentfetch pipeline (并发4, 每群每小时60条)
        ├── 链接 → SSRF 防护 → HTTP 抓取(2MB上限) / Jina Reader(可选)
        └── 文件 → pdf/docx/xlsx/xls/csv/txt 解析(20MB上限, zip bomb 防护)
              │
              ▼
      summarize/analyze (DeepSeek, JSON 模式)
        ├── 提取日程 items
        └── compare: 与既有日程比对去重(多群重复信息不重复建日程)
              │
              ▼
      schedule.merge() ──► scheduler (robfig/cron)
                            · daily_cron   0 7 * * *   每日汇总
                            · light_cron   0 */2 * * *  轻量同步
                            · cleanup_cron 30 23 * * *  清理
                                 │
                                 ▼
                          notify (WS 推送 / QQ 私聊推送, 可选)
```

---

## 3. 仓库结构

```
default/                                # 仓库根 = C:\Users\Surface\Documents\Trae-CN\default
├── HANDOFF.md                          # 本文档
├── requirements.txt                    # 环境依赖清单（人读版，真实锁定见 go.mod/package.json）
│
├── server/                             # Go 服务端
│   ├── go.mod                          # module github.com/qqsched/server, go 1.23
│   ├── cmd/app/main.go                 # 入口：装配 config/store/provider/bot/scheduler 并启动
│   ├── configs/
│   │   ├── config.yaml                 # 本地开发配置
│   │   └── config.example.yaml         # 配置模板（全量注释）
│   ├── migrations/                     # SQL 迁移（按文件名字典序执行，逐文件事务）
│   │   ├── 0001_init.sql
│   │   ├── 0002_content_assets.sql
│   │   ├── 0003_user_state.sql
│   │   ├── 0004_replan_reasoning.sql
│   │   └── 0005_memories.sql           # 记忆碎片表
│   ├── dist/deploy/config.yaml         # 发布目录配置副本
│   └── internal/
│       ├── httpapi/        # REST 路由与 handlers (auth/schedules/alerts/replan)
│       ├── web/            # go:embed 内嵌 client/dist 静态资源
│       ├── onebot/         # 协议无关事件模型 + APICaller 接口
│       │   └── v11/        # NapCat 适配: reverse_ws(生产) / http_post(备选) / apicaller
│       ├── ingest/         # 消息入库分发 + 响应器挂载
│       ├── contentfetch/   # 内容抓取管线: pipeline/resolver/ssrf/jina/blocked
│       │   └── docparse/   # pdf/docx/xlsx/xls/csv/txt 解析 + zipguard
│       ├── summarize/      # DeepSeek 客户端 (ChatJSON, 无原生 function calling)
│       ├── analyze/        # 日程提取/比对/通知生成 prompt
│       ├── schedule/       # 日程模型/合并/导出
│       ├── scheduler/      # cron 定时任务
│       ├── notify/         # 提醒通道 (WS / QQ 私聊)
│       ├── bot/            # ★ 鲸鱼娘人格机器人 (见 §4.2)
│       │   ├── bot.go      #   主逻辑: 权限/限流/记忆/工具循环
│       │   ├── prompt.go   #   DefaultPersona + OneBot 技能卡
│       │   ├── history.go  #   会话内历史 (TTL 2h, 12轮, user带sender)
│       │   └── rate.go     #   私聊限流 (3次/5分钟 滑动窗口)
│       ├── memory/         # 记忆碎片服务: 关键词提取 + 相关性打分
│       ├── shellctl/       # 持久 bash 会话池 (哨兵协议, 见 §4.3)
│       ├── groupmeta/      # 群信息缓存 (群名/头像)
│       ├── store/          # SQLite 持久层 + 自研迁移 runner
│       ├── auth/           # JWT / 密码 / 绑定码
│       └── config/         # 配置结构与校验 (yaml, 环境变量可覆盖)
│
├── client/                             # Taro 4 客户端
│   ├── package.json                     # 构建脚本见 §5
│   ├── src/
│   │   ├── app.tsx / app.config.ts      # 入口与路由 (designWidth 750)
│   │   ├── pages/                       # login/bind/schedule/detail/calendar/alerts/settings
│   │   ├── components/                  # TabBar/ItemCard/GroupChip/SourceCard/ReasoningPanel/...
│   │   ├── store/                       # zustand: auth/schedule/alerts/notify/replan
│   │   ├── services/                    # api(axios风格fetch)/sync/replan/notify(平台分流)
│   │   └── utils/                        # platform/date/text/storage/useAuthGuard
│   ├── capacitor/                       # Android 壳 (cap sync 来源)
│   └── desktop/                         # Tauri 2 Windows 壳 (tauri.conf.json)
│
└── .trae/specs/                        # 历史开发规格文档 (qq-bot-shell-ui 等)
```

---

## 4. 核心模块详解

### 4.1 OneBot 层（internal/onebot + v11）

- **传输**：生产用 `reverse_ws`——NapCat 主动连服务端 `ws://127.0.0.1:8080/onebot/v11/ws`，token 鉴权（NapCat 侧配置的 access_token 必须与 config.yaml 一致）。备选 `http_post`。
- **事件归一化** `NormalizeV11()`：OneBot v11 的 `message` 字段**可能是消息段数组，也可能是 CQ 码字符串**（NapCat 两种都会报）。字符串分支用正则 `\[CQ:at,qq=([^,\]]+)\]` 提取 @ 目标，否则群内 @ 检测会失效——这是真实踩过的坑。
- **APICaller 接口**：`SendPrivateMsg / SendGroupMsg / GetGroupFileURL / GetGroupMsgHistory / GetGroupInfo / CallAction`。`CallAction(action, params)` 是通用出口，可调 NapCat 全部 v11 接口（发图、群公告、禁言等），返回解包后的 `data`。

### 4.2 Bot 子系统（internal/bot）★

触发条件：群内被 @（`Mentions` 列表 + `[CQ:at,qq=<self>]` 原文双重兜底，self_id 取 `ev.SelfID` 与 `cfg.SelfQQ` 并集）；私聊任意消息。自身消息一律忽略（防循环）。

```
HandleMessage(ev)
  │ 文本清洗(剥CQ码) → @检测 → authorized := (ev.UserID == control_qq "3874095145")
  │
  ├─ 有前缀(/sh, shell) 且 authorized → runCommand(): shellctl 执行, 免模型
  ├─ 有前缀 但未授权            → 调皮拒绝 (refusal, 免模型)
  ├─ 未授权 且 looksLikeShellIntent → 调皮拒绝 (免模型)
  ├─ 私聊 且 限流超限(3次/5分钟)  → quotaReply 人机回复 (免模型, 省 token)
  └─ chat(): 人格对话
       │ ① memory.Recall(key, qq, text, top_n=5)  LIKE预筛+打分(命中词+2/本人+3)
       │ ② hist.appendUser(key, qq, text)          会话历史(user带sender QQ)
       │ ③ buildPrompt: 身份行(主人/同学) + 记忆块 + 历史标签(主人:/同学(QQxxx):)
       │ ④ 循环 ≤ max_iterations(6):
       │     DeepSeek ChatJSON → {"reply","command","api","memory"}
       │     ├─ api 非空   → api.CallAction 执行 NapCat 接口 → 结果回填 → continue
       │     ├─ command非空 → 仅 authorized 执行 shell; 未授权 → refusal 并 break
       │     └─ 都为空     → break
       │ ⑤ memory.Remember(): 模型判定值得记的碎片落库(≤60字+1-3标签)
       │ ⑥ send(): 群消息自动带 [CQ:at,qq=对方] 前缀, >1500字自动分段
```

权限要点：**人格聊天对所有人开放**，但只有 `3874095145` 被称「主人」、能触发 shell。主人判定 = `control_qq`，与 shell 权限、身份注入同源。

### 4.3 ShellCtl（internal/shellctl）

持久 bash 会话池：每个会话 key（`group:<群号>` 或 `private:<QQ>`）一个 bash 进程，保持 cwd/env 状态。
- 协议：命令后追加分隔符，输出以哨兵行 `__QQSA_DONE__<exit>__` 结束
- 60s 超时（超时会话重置）、单次输出 256KB 截断、30 分钟空闲回收
- 特殊命令：`reset/exit/restart/重来/重置` → 销毁重建会话
- 服务进程经 sudoers `qqsched ALL=(ALL) NOPASSWD: ALL` 免密提权；模型知道命令前加 `sudo` 即为 root

### 4.4 记忆碎片（internal/memory + store/memories）

- 表 `memories(id, session_key, sender_qq, tags, content, created_at)`，索引 `idx_memories_session(session_key, created_at)`、`idx_memories_sender(sender_qq)`
- 召回：关键词提取（ASCII≥2字符 + 中文CJK run，≤4字整段/长段切bigram，停用词过滤，上限8个）→ `content/tags LIKE` 预筛（窗口 limit*8，上限200）→ Go 侧打分排序
- 写入：复用对话同一次 DeepSeek JSON 回答的 `memory` 字段，**不额外增加调用次数**
- 每会话上限 200 条，超出自动裁旧

### 4.5 内容抓取（internal/contentfetch）

- 并发 4，每群每小时 60 条；链接 2MB / 文件 20MB 上限
- SSRF 防护（ssrf.go）：私网地址拦截
- Jina Reader 可选（jina.go，私聊默认不走，隐私开关 `privacy.jina_private_chats`）
- 文档解析 docparse：pdf / docx / xlsx / xls / csv / txt + zip 炸弹防护（zipguard）
- content_hash 缓存 7 天，命中直接复用

---

## 5. 构建与产物

### 5.1 环境要求

见 [requirements.txt](requirements.txt)。要点：
- Go ≥ 1.23；Node ≥ 18；本机构建 Android 需 JDK 17（本机在 `D:\jdk-17\jdk-17.0.20.1+1`，注意嵌套目录）+ Android SDK（`D:\android-sdk`）
- Tauri 需要 Rust（cargo 在 `%USERPROFILE%\.cargo\bin`，**不在默认 PATH**，先 `$env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path`）

### 5.2 服务端

```powershell
cd server
go build ./...                          # 本地校验
go vet ./...                            # 静态检查
# 交叉编译 linux amd64（生产部署用，CGO 关闭）
$env:GOOS="linux"; $env:GOARCH="amd64"; $env:CGO_ENABLED="0"
go build -trimpath -ldflags "-s -w" -o ..\发布目录\qqsched .\cmd\app
$env:GOOS=""; $env:GOARCH=""; $env:CGO_ENABLED=""
```

### 5.3 客户端（三形态）

```powershell
cd client
npm run build:h5            # H5 产物 → client/dist（服务端 go:embed 的来源）
npm run desktop:build       # Windows exe（Tauri，beforeBuildCommand 会重建 dist）
# Android:
npm run cap:sync            # 同步 dist 到 capacitor/（必须在 desktop:build 之后，见坑#7）
cd capacitor\android && .\gradlew assembleRelease   # 需要 JAVA_HOME 指向 JDK17
```

产物统一输出到桌面「日程助手-发布」文件夹（exe / apk / 服务端二进制）。

---

## 6. 生产部署与运维

### 6.1 服务器布局（120.26.224.86）

```
/opt/qqsched/
├── qqsched              # 二进制 (root:root, 755)
├── config.yaml          # 运行配置
├── app.env              # EnvironmentFile: DEEPSEEK_API_KEY / JINA_API_KEY / TZ
├── data/app.db          # SQLite (WAL 模式)
├── qqsched.log          # 手动调试时的输出（systemd 运行时日志看 journalctl）
└── qqsched.bak.1411     # 历史二进制备份

/etc/systemd/system/qqsched.service        # systemd 单元（enabled）
/etc/systemd/system/qqsched.service.bak.sandbox  # 加固版备份（已弃用）
/etc/sudoers.d/qqsched                     # qqsched ALL=(ALL) NOPASSWD: ALL
/root/napcat-autostart.sh                  # @reboot 起 NapCat screen 会话
/root/Napcat/                              # NapCat 本体（WebUI :6099）
```

**systemd 单元要点**：`User=qqsched`，`EnvironmentFile=app.env`，`Restart=always`，`MemoryMax=768M`。沙箱项（NoNewPrivileges/ProtectSystem/ProtectHome/PrivateTmp/ReadWritePaths）**已全部移除**——否则 bot 的 sudo 提权和文件访问会被挡。旧加固版备份在 `.bak.sandbox`。

### 6.2 常用运维命令

```bash
systemctl status|restart|stop qqsched
journalctl -u qqsched -f                       # 实时日志
journalctl -u qqsched --since "-15min" | grep -iE 'error|onebot'
curl -s http://127.0.0.1:8080/healthz          # 健康检查
screen -r napcat                               # 进 NapCat 会话
ss -lntp | grep -E '8080|6099'                 # 端口占用
```

已预装运维工具：htop iftop iotop ncdu jq tree lsof strace unzip zip net-tools psmisc file bc。

### 6.3 发布流程（Windows → 服务器）

> ⚠️ 部署命令**必须逐条单独执行**。一次性粘贴多条命令到 cmd 会因换行丢失被拼接成一条，曾引发 `Could not resolve hostname http` / `scp: Connection closed`。

```powershell
# 1) 上传
scp "…\发布目录\qqsched" root@120.26.224.86:/opt/qqsched/qqsched.new
# 2) 替换并重启（远端执行）
ssh root@120.26.224.86 "cd /opt/qqsched && mv -f qqsched.new qqsched && chmod 755 qqsched && systemctl restart qqsched && sleep 5 && systemctl is-active qqsched && curl -s http://127.0.0.1:8080/healthz"
```

重启后 NapCat 反向 WS 会自动回连（journalctl 出现 `onebot connection established`）。**但若 NapCat 也重启过，小号 3754609823 需人工到 WebUI `http://127.0.0.1:6099` 扫码重新登录**（腾讯风控，无法免扫码）。

### 6.4 免交互 SSH（Windows OpenSSH）

Windows 的 OpenSSH 支持 askpass 免交互：写一个 `.cmd` 输出密码，然后
`$env:SSH_ASKPASS="<路径>"; $env:SSH_ASKPASS_REQUIRE="force"; $env:DISPLAY="localhost:0"` 后 ssh/scp 即可非交互执行。服务器重启服务后反向 WS 端口转发会断（`client_loop: send disconnect`），属正常现象。

---

## 7. 数据库 Schema（migrations）

| 迁移 | 内容 |
|---|---|
| 0001_init | users / messages / schedules 等基础表 |
| 0002_content_assets | 内容资产表（链接/文件抓取结果，content_hash 去重） |
| 0003_user_state | 用户侧状态 |
| 0004_replan_reasoning | 一键排程的 DeepSeek 思考链存储 |
| 0005_memories | 记忆碎片表（见 §4.4） |

迁移 runner 在启动时自动执行（`store.Migrate`）：按文件名字典序、逐文件事务、记录进 `schema_migrations`。新增表 = 新增 `NNNN_name.sql`，无需手工建表。

---

## 8. 配置速查（server/configs/config.example.yaml）

关键项（完整注释见模板）：

| 键 | 默认 | 说明 |
|---|---|---|
| `server.addr` | `:8080` | API + 网页 + 反向WS 同端口 |
| `onebot.mode` | `reverse_ws` | NapCat 接入方式 |
| `onebot.token` | — | 必须与 NapCat 侧 access_token 一致 |
| `onebot.groups` | `[]` | 群白名单，空=不限 |
| `deepseek.*` | — | api_key 建议用环境变量 `DEEPSEEK_API_KEY` |
| `bot.control_qq` | `3874095145` | 唯一 shell 授权 + 「主人」身份 |
| `bot.self_qq` | `3754609823` | @ 检测兜底 |
| `bot.prefixes` | `/sh, shell` | 直接执行命令前缀 |
| `bot.memory_top_n` | `5` | 每轮注入记忆条数 |
| `bot.persona_override` | `""` | 留空用内置人格；覆盖会连 OneBot 技能卡一起覆盖，慎用 |

私聊限流（3次/5分钟）当前为代码常量（`internal/bot/rate.go` 的 `privateChatLimit` / `privateChatWindow`），未做成配置。

---

## 9. 已知问题与坑（务必阅读）

1. **小号风控**：3754609823 每次重启 NapCat 都要重新扫码，无法自动重登。服务端重启不影响（NapCat 不重启则 WS 自动回连）。
2. **message 字段双形态**：OneBot v11 的 `message` 可能是段数组或 CQ 字符串，@ 解析两边都要兜底（已修）。
3. **人格权限曾过紧**：早期版本人格聊天仅授权 QQ 可用，导致"同学 @ 不回复"；现在聊天对所有人开放，仅 shell/主人身份限授权 QQ（已修）。
4. **群会话身份混淆**：群 history 里主人和同学消息混存，必须给每条 user turn 记 sender QQ 并在 prompt 注入「当前对话对象」身份行，否则模型不认主人（已修）。
5. **双实例端口冲突**：曾同时存在 root 手工 nohup 实例和 systemd 实例，后者持续 `bind: address already in use` 崩溃重启 1400+ 次且跑的是旧二进制。**只允许 systemd 一份实例**，排障先 `ps -o pid,user,cmd -C qqsched` 确认唯一。
6. **CORS**：服务端必须放行 `Authorization`/`Content-Type` 头、OPTIONS 返 204，否则 exe/apk 提示网络不可用（已内置）。
7. **构建顺序**：Tauri 的 `beforeBuildCommand` 会重建 `client/dist`；`cap:sync` 必须等 desktop 构建结束再跑，否则报 `Web directory ../dist does not exist`。
8. **Android 明文流量**：AndroidManifest 需 `usesCleartextTraffic="true"`，capacitor.config 的 `androidScheme` 需为 `http`，否则 Android 9+ 拦截明文 → apk 报网络不可用（已配）。
9. **Taro px 转换**：designWidth=750，小写 `px` 被 postcss-pxtransform 转 rem；响应式断点等需写**大写 `PX`** 绕过转换。
10. **绑定流程**：客户端填**待绑定的大号 QQ**（不是机器人 QQ）；绑定码由大号本人在群 1130297603 发送；机器人自身发的码无效（且机器人配置不回报自身消息）。
11. **Tauri notification 插件**：`tauri.conf.json` 中空的 `notification: {}` 配置会导致 exe 静默崩溃无窗口，必须整项移除。
12. **DeepSeek 无 function calling**：本项目用 JSON 输出模式模拟 tool calling（契约见 bot/prompt.go），超时 90s、重试 2 次；偶发 `context deadline exceeded` 属上游慢，非代码 bug。
13. **部署命令逐条执行**：见 §6.3 警告。
14. **构建占用**：Windows 上 exe 被运行中程序占用时无法覆盖，另存 `-new` 文件名再换。

---

## 10. 快速上手清单（给接手 AI）

1. 读 `requirements.txt` 备齐环境 → `go build ./...` + `npm install` 验证可编译
2. 本地起服务：`cd server && go run ./cmd/app -config configs/config.yaml`（需 sqlite 目录可写）
3. 打开 `http://127.0.0.1:8080` 验证 H5；注册 → 绑定码流程联调需真实 NapCat
4. 改 bot 行为：`internal/bot/prompt.go`（人设/技能卡/JSON 契约）+ `bot.go`（权限/限流/工具循环）
5. 加接口：`onebot.APICaller.CallAction` 已可调任意 NapCat 接口，无需改协议层
6. 加表：`server/migrations/000N_xxx.sql` + `internal/store/xxx.go`，启动自动迁移
7. 发布：§5 构建 → §6.3 部署 → 重启后确认 journalctl 无 ERROR、WS established、healthz ok
