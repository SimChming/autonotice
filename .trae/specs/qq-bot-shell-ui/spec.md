# Spec：机器人人格/shell 控制 + 客户端体验增强

- 状态：待审批
- 目标工程：`C:\Users\Surface\Documents\Trae-CN\default`（Go 服务端 + Taro H5 客户端 + Capacitor/Tauri 壳）
- 需求来源：用户本轮 6 条需求
- 已确认决策（用户四选项全部选「推荐」）：
  1. shell **前缀触发 + 持久会话**
  2. 人格对话由 **DeepSeek 生成**
  3. 未授权 QQ 在群里 @ 机器人时 **只调皮回绝**（不调用大模型）
  4. 自动登录 = **记住账号密码自动登录**

---

## 1. 需求清单（验收口径）

| 编号 | 需求 | 验收标准 |
|---|---|---|
| R1 | Client 自动登录 | 勾选「记住账号密码」后，下次启动（或 token 失效）自动静默登录并进入日程页，无需手输 |
| R2 | 日程群聊来源显示头像+群名 | 日程卡片/详情页来源处显示群头像 + 群名称（不再只有群号） |
| R3 | 群内被 @ 时以【鲸鱼娘顽皮女仆】人格交流，可操控服务器 root shell，仅 QQ 3874095145 有效 | 授权 QQ 群内 @ 机器人 → 人格回复；带前缀消息 → 执行 shell 并回包 |
| R4 | 美化 UI，修复登录界面输入框文字偏移 | 登录页输入文字垂直居中不偏移；整体视觉更精致 |
| R5 | Client 自动识别分辨率/比例适配 UI | 手机/平板/Windows 桌面分别呈现合理字号与布局，不再出现「整屏超大手机」 |
| R6 | 私聊也仅接受 QQ 3874095145 的 shell 交互式控制 | 授权 QQ 私聊小号 → 持久会话命令执行；其他人私聊 → 无权限回绝 |
| R7 | 日程详情页「备注」栏文本排版与背景协调 | 备注不再呈现「直接粘贴原文」的异样格式（异体字/多余空行/缩进/标记符），与卡片风格统一 |

---

## 2. 现状勘察结论（复用，不再重复探索）

**服务端**
- OneBot v11 反向 WS：`server/internal/onebot/v11/reverse_ws.go`；事件模型 `onebot/event.go`（含 `SelfID`/`Mentions`/`Segments`/`IsGroup()`）。
- 唯一事件消费者：`ingest.Service.Run`（`internal/ingest/ingest.go`），`handleMessage` 存库 → `UpsertGroup(ctx, ev.GroupID, "")`（群名恒为空）。
- API 调用器接口 `onebot.APICaller`（`internal/onebot/provider.go`）：`SendPrivateMsg/SendGroupMsg/GetGroupFileURL/GetGroupMsgHistory`；实现 `v11/apicaller.go` — **无 `get_group_info`**。
- REST 路由 `internal/httpapi/router.go`；日程文档 `handlers_schedules.go` 已通过 `schedule.ApplyGroupNames` 回填群名（`merge.go`），数据源 `Store.ListGroups`。
- DeepSeek 客户端 `internal/summarize/client.go`：仅 `ChatJSON(system,user)`（JSON 模式）与 `ChatStream`，**无 function calling**；`Configured()` 判断 APIKey。
- 配置 `internal/config/config.go`（YAML + env）；部署配置为 `server/dist/deploy/config.yaml` 与 `configs/config.yaml`。
- 装配入口 `cmd/app/main.go`：store → client → provider → contentfetch → ingest → auth → notify → scheduler → router。

**客户端**
- Taro 4 H5、`designWidth: 750`，`app.scss` 注释声明「px 交由 pxtransform 转 rem」。
- 根字号由 `dist/index.html` 内联脚本设置：`x = 40*min(vw,vh)/750`，并 `clamp(20px, 40px)`。
  → 桌面 1440 宽时被钳到 40px = 设计稿 px 与 CSS px **1:1**，即「整屏超大手机」（R5 根因）。
- 登录页 `pages/login/index.tsx` + `index.scss`（`.login__input{height:88px;padding:0 24px;font-size:29px}`，无 `line-height`，R4 偏移根因）。
- 来源展示 `components/SourceCard/index.tsx`（`sourceGroupLabel` 返回字符串数组）、`components/ItemCard/index.tsx`。
- 状态 `store/auth.ts`（token/user/bindings 持久化到 `utils/storage.ts` 的 `KEYS`）、`app.tsx`（`bootstrap` 已 hydrate）。
- 类型 `types/index.ts` 已含 `SourceInfo.groups?: SourceGroupInfo[]`。

---

## 3. 方案设计

### 3.1 服务端

#### (S1) 新增 `internal/shellctl`：持久 shell 会话
`server/internal/shellctl/shellctl.go`

```go
type Manager struct{ ... }                       // 会话池 + 空闲回收
func New(idle time.Duration, log *slog.Logger) *Manager
func (m *Manager) Run(ctx context.Context, key, cmd string) (out string, exit int, err error)
func (m *Manager) Reset(key string)              // 杀掉并重建会话
func (m *Manager) CloseAll()
```
- 每个 `key` 一个长驻 `bash -i`？**不用 PTY，用管道**：`bash` + `StdinPipe`/`StdoutPipe`，`Stderr=nil`（丢弃），命令内联 `2>&1`。
- 同步协议（哨兵行）：写入
  `cmd` + `\nprintf '__QQSA_END__%s__\n' "$?"`，用 `bufio.Scanner` 读到哨兵行取退出码。
- 超时：`Run` 读取在独立 goroutine，`select` ctx.Done / 完成；超时返回 `err=ErrTimeout`（不杀会话，继续阻塞读到哨兵后丢弃）。
- 输出上限 256KB，超出截断。
- 空闲 > 30min 自动 Close 回收；`CloseAll` 在服务关闭时调用。
- 限制：无 TTY，`vim/top` 等全屏交互程序不可用（写入文档/交付说明）。

#### (S2) 新增 `internal/bot`：人格 + shell 控制器
`server/internal/bot/{bot.go,prompt.go,history.go}`

```go
type Config struct {
    Enabled         bool
    ControlQQ       string     // 唯一授权 QQ，默认 3874095145
    Prefixes        []string   // 默认 ["/sh","shell"]
    MaxIterations   int        // 默认 6
    OutputLimit     int        // 默认 3500 runes/条
    HistoryTurns    int        // 默认 12
    PersonaOverride string
}
func New(cfg, api onebot.APICaller, sh *shellctl.Manager, llm *summarize.Client, log) *Service
func (s *Service) HandleMessage(ctx context.Context, ev onebot.Event) error
```

`HandleMessage` 判定顺序：
1. `ev.UserID == ""` 或 `ev.UserID == ev.SelfID` → 忽略（防自我回环）。
2. 触发判定：
   - 群消息：`ev.Mentions` 含 `ev.SelfID` 才算被 @；否则忽略。
   - 私聊：任何消息都算。
3. `authorized := ev.UserID == cfg.ControlQQ`。
4. 提取正文 `text`：去掉 `@机器人` 段（`ev.Text` 已是纯文本拼接，直接 `strings.TrimSpace`）。
5. **未授权分支**：仅当命中「shell 意图」→ 回一句调皮回绝（固定文案，不调 LLM）；否则静默 `return nil`。
   - shell 意图 = 以任一前缀开头，或正文含 `shell|终端|命令|执行|运行|root|cmd|sudo|bash|安装|部署` 之一（大小写不敏感）。
6. **授权分支**：
   - 命中前缀 → `strip prefix` 后交给 `shellctl.Run`，回包（见 S6 回包格式）；`/sh reset`、`/sh exit` 特判重置会话。
   - 否则 → 进入 **LLM 人格对话循环**（S4）。

会话键：私聊 `private:<qq>`；群聊 `group:<groupID>`（同一群共享上下文）。

#### (S3) 回包格式（S6 细节）
- shell 结果（成功/失败）：
  ```
  🐋 主人~ 命令跑完啦（exit 0）
  <输出截断至 OutputLimit 字符>
  ```
- 超过 `OutputLimit`：截断并追加 `\n…（输出过长已截断）`；超过 1500 字符按 1500 分段发送多条。
- 空输出：`（没有输出喵~）`。

#### (S4) LLM 人格对话（JSON 模拟 function calling）
不改造 DeepSeek 客户端，复用 `ChatJSON`（JSON 模式）。约定模型每次输出：
```json
{"reply": "给主人的回复", "command": "要执行的 shell 命令，或 null"}
```
- system = 人格 prompt（`prompt.go`），含：身份=鲸鱼娘顽皮女仆、语气调皮卖萌、使用简体中文、`command` 仅在需要操作服务器时给出、禁止危险解释性长文本。
- user = 最近 `HistoryTurns` 轮历史 + 本轮正文（历史以纯文本拼接，形如 `主人: … / 你: … / [命令] … / [输出] …`）。
- 循环：若 `command != null` 且可解析 → `shellctl.Run` → 把 `[命令]/[退出码]/[输出]` 追加进历史 → 再次 `ChatJSON`；否则以 `reply` 作为最终回复。
- `MaxIterations` 用尽 → 用最后一次 `reply` 兜底；LLM 未配置或出错 → 回退固定文案 `🐋 呜…主人的鲸鱼脑有点晕，等下再试喵~`。
- 历史存内存（`history.go`），键同会话键，TTL 2h。

#### (S5) 群名获取：新增 `internal/groupmeta`
`server/internal/groupmeta/groupmeta.go`
```go
type Service struct{ api onebot.APICaller; st *store.Store; log; mu; done map[string]bool }
func (s *Service) Ensure(ctx context.Context, groupID string) // 首次见到该群 → get_group_info → UpsertGroup(id,name)
```
- `get_group_info` 失败 → 静默（群名保持为空，客户端回退显示「群 <id>」）。

#### (S6) OneBot 能力扩展
- `onebot/provider.go` 的 `APICaller` 增加：
  `GetGroupInfo(ctx context.Context, groupID string) (name string, err error)`
- `v11/apicaller.go` 实现：调用 `get_group_info`，解析 `data.group_name`。
- `v11/http_post.go` 若也实现 `Caller`，同样走 `invoke` 即可（无需改动，若编译报缺方法则补一个同构实现）。

#### (S7) ingest 挂载钩子
`internal/ingest/ingest.go` 增加：
```go
func (s *Service) SetResponder(r Responder)          // interface{ HandleMessage(ctx, onebot.Event) error }
func (s *Service) SetGroupNamer(g GroupNamer)        // interface{ Ensure(ctx, groupID string) }
```
- `handleMessage` 开头（**在 `allowed()` 判定之前**）调用 responder；错误仅记日志，不影响存库。
- `UpsertGroup` 处调用 `groupNamer.Ensure`。

#### (S8) 配置
`internal/config/config.go` 新增 `BotConfig`（yaml 键 `bot`）+ 默认值 + env 覆盖 `BOT_ENABLED`/`BOT_CONTROL_QQ`：
```yaml
bot:
  enabled: true
  control_qq: "3874095145"
  command_prefixes: ["/sh", "shell"]
  max_iterations: 6
  output_limit: 3500
  history_turns: 12
```
同步更新 `configs/config.yaml`、`configs/config.example.yaml`、`server/dist/deploy/config.yaml`。

#### (S9) 装配
`cmd/app/main.go`：构造 `shellctl.Manager` → `groupmeta.Service` → `bot.Service`；`ing.SetGroupNamer`、`ing.SetResponder`；关闭时 `shell.CloseAll()`。

> **安全声明（写入交付说明）**：该功能等价于把服务器 root shell 通过 QQ 暴露给单一 QQ 号；前缀+白名单+`enabled` 开关为唯一防线。建议用户确认小号密码与 NapCat token 安全。

### 3.2 客户端

#### (C1) 自动登录（R1）
- `utils/storage.ts`：`KEYS` 增加 `credentials: 'qqsa.credentials'`。
- `store/auth.ts`：新增 `saveCredentials(name, password)`、`loadCredentials()`、`clearCredentials()`（base64 混淆存储，非加密），并导出 `silentRelogin(): Promise<boolean>`（用保存的账号密码调 `api.login`，成功则 `setAuth`）。
- `pages/login/index.tsx`：新增「记住账号密码」开关（默认开）；进入页面时用已存账号密码预填；若已存在凭据且当前无有效 token → 自动提交登录。
- `app.tsx` `bootstrap()`：`无 token && 有凭据` → 先 `silentRelogin()`，成功再 `syncAll()`；失败则停在登录页。
- `services/api.ts` `handleUnauthorized()`：logout 后尝试一次 `silentRelogin()`，成功则 `reLaunch` 日程页（失败维持现有跳登录页逻辑）。

#### (C2) 群头像 + 群名（R2）
- 新增 `components/GroupChip/index.tsx` + `.scss`：给定 `groupId`/`groupName`，渲染 `<Image src={avatarUrl}>` + `<Text>` 群名。
  - 头像 URL：`https://p.qlogo.cn/gh/{group_id}/{group_id}/100`（QQ 群头像公开规则，无需服务端调用）。
  - `onError` 回退到纯文字 chip。
- `SourceCard/index.tsx`：`sourceGroupLabel` 改为返回 `Array<{group_id, name}>`；渲染 `GroupChip` 列表。
- `ItemCard/index.tsx`：来源行改为显示第一个群头像 + 「来自 A、B（2 个群）」。

#### (C3) 登录输入偏移 + 美化（R4）
- `pages/login/index.scss`：`.login__input` 增加 `display:block; width:100%; box-sizing:border-box; line-height:88px;`（单行输入垂直居中），label/输入间距与焦点态统一。
- 全站美化（受控改动，只动样式）：`app.scss` 增加更精细的卡片阴影/分隔线/渐变强调色；`PageHeader`、`ItemCard`、`SourceCard`、`TabBar` 的 scss 做间距/圆角/层级微调；登录页卡片加渐变标题区。
- 若 `bind`/`settings` 页存在同类输入框，同步套用 `line-height` 修复（实现时 grep `__input` 确认）。

#### (C5) 备注栏文本排版（R7）
根因（`pages/detail/index.scss` `.detail__textarea`）：H5 下 Taro `Textarea` 渲染为原生 `<textarea>`，**浏览器默认给 `<textarea>` 使用等宽字体且不继承 `font-family`**，而备注内容又常是 AI/群消息直接搬运的原文（含多余空行、行首缩进、`**加粗**`/反引号等标记），于是与卡片背景和正文字体「格格不入」。

- 样式修复：`.detail__textarea` 增加 `display:block; box-sizing:border-box; font-family:inherit; line-height:1.65; letter-spacing:0.01em; padding:20px 22px; resize:vertical;`（与 `.detail__input` 一起统一）。
- 新增 `src/utils/text.ts` `normalizeNotes(s: string): string`：
  - `\r\n`→`\n`；去除行尾空白；行首去缩进（多余前导空格/制表符）；
  - 去掉 Markdown 标记 `**`、`__`、行内反引号、行首 `- `/`* `/`# `（仅去掉符号，保留文字）；
  - 连续 ≥3 个空行折叠为 1 个；整体 `trim()`。
- `pages/detail/index.tsx`：`useState(item?.notes)` 初始化与保存时都经过 `normalizeNotes`（保证展示与再次保存后格式一致）。
- 若 `bind`/`settings` 页存在同类输入框，一并套用 `font-family:inherit` 修复（实现时 grep `__input|__textarea` 确认）。

#### (C6) 分辨率/比例自适应（R5）
在 `app.scss` 增加覆盖层（用 `!important` 覆盖 `dist/index.html` 内联脚本设置的根字号）：
```scss
@media (min-width: 700px) {                 /* 平板 / 桌面：不再整屏放大 */
  html, body { font-size: 22px !important; }
  .page-root { max-width: 860px; margin: 0 auto; box-shadow: var(--shadow-card); }
}
@media (min-width: 1100px) { html, body { font-size: 22px !important; } .page-root { max-width: 920px; } }
```
- 宽屏布局切换：`pages/schedule/index.scss` 的 `.schedule__list` 在 `@media (min-width:700px)` 变为 `display:grid; grid-template-columns: repeat(2, 1fr); gap: 16px;`（平板/桌面双列观感）。
- 移动端（<700px）维持现有 Taro 脚本行为。

---

## 4. 交付与部署（沿用既有链路）

1. 构建校验：`cd server && go build ./... && go vet ./...`
2. H5 → 服务端内嵌 → 交叉编译 → 上传重启（**kill PID 重启，禁止 systemctl**）：
   - cwd=`client`：`$env:TARO_APP_API_BASE="http://116.62.106.45:8080/api/v1"; npm run build:h5`
   - 复制 `client/dist` → `server/internal/web/dist`
   - cwd=`server`：`$env:CGO_ENABLED=0;$env:GOOS="linux";$env:GOARCH="amd64"; go build -trimpath -ldflags "-s -w" -o qqsched ./cmd/app`
   - scp 到 `/opt/qqsched/qqsched.new` → `mv` 覆盖 → kill 旧 PID
   - 同步更新远端配置 `bot:` 段（若远端配置为 `/opt/qqsched/config.yaml`，实现时先确认路径）
3. 桌面 exe：cwd=`client` `npm run desktop:build`（后台跑，耗时较长）
4. Android apk：`npm run build:h5` → `npm run cap:sync` → `capacitor/android` 下 `.\gradlew.bat assembleDebug`（JAVA_HOME=D:\jdk-17，ANDROID_HOME=D:\android-sdk）
5. 全部产物复制到 `C:\Users\Surface\Desktop\日程助手-发布`

## 5. 验证步骤

- 服务端：`curl -s http://116.62.106.45:8080/healthz`；`go vet` 无告警。
- Bot（需用户先扫码登录小号 3754609823）：
  1. 授权 QQ 群内 @ 机器人普通聊天 → 收到人格回复。
  2. 授权 QQ 群内 `@机器人 /sh whoami` → 返回 `root`。
  3. 授权 QQ 群内 `@机器人 /sh cd /tmp` 再 `/sh pwd` → 输出 `/tmp`（证明持久会话）。
  4. 非授权 QQ 群内 @ 机器人「帮我控制 shell」→ 收到调皮回绝。
  5. 授权 QQ 私聊小号 `/sh ls -al /opt` → 返回目录列表；非授权私聊 → 回绝。
- 客户端：登录页输入文字垂直居中；勾选记住密码后重启自动进入日程页；日程卡片显示群头像+群名；Windows exe 与平板宽度下为居中双列布局。
- 备注栏：打开一条含 `**加粗**` / 多空行 / 行首缩进的日程，备注显示为与正文一致的字体与行距，无多余空行与标记符（R7）。

## 6. 已知风险与限制

- 无 PTY：交互式全屏程序（vim/top）不可用。
- 群头像依赖腾讯 `p.qlogo.cn` 公开接口，网络受限时回退纯文字。
- 自动登录保存的是 base64 混淆口令（非加密），共享设备上有风险；已提供「记住账号密码」开关关闭。
- 远端配置中 `bot.control_qq` 与本地默认一致；如需更换需改远端 yaml。
- 前置阻断：小号 3754609823 登录态失效时必须重新扫码，否则群消息/私聊进不来，全部 bot 功能无法验证。
