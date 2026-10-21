# Tasks：机器人人格/shell 控制 + 客户端体验增强

> 每完成一项即时更新状态。执行前需 `spec.md` 已获批。

## 服务端

- [x] T1 `internal/shellctl/shellctl.go` 新建：持久 bash 会话池（哨兵行协议、超时、256KB 截断、空闲回收、`Reset`/`CloseAll`）
- [x] T2 `onebot/APICaller` 增加 `GetGroupInfo`；`v11/apicaller.go` 实现 `get_group_info`（`http_post.go` 按需补同构实现）
- [x] T3 `internal/groupmeta/groupmeta.go` 新建：首次见群 → `get_group_info` → `UpsertGroup(id,name)`，失败静默
- [x] T4 `internal/bot/prompt.go` 新建：鲸鱼娘顽皮女仆人格 system prompt + JSON 契约（reply/command）
- [x] T5 `internal/bot/history.go` 新建：按会话键的内存历史（TTL 2h、HistoryTurns 截断）
- [x] T6 `internal/bot/bot.go` 新建：触发判定（群需 @、私聊直通）、授权判定、未授权调皮回绝、前缀直执行、LLM 循环、回包分段
- [x] T7 `internal/ingest/ingest.go` 增加 `SetResponder`/`SetGroupNamer` 钩子并在 `handleMessage` 调用
- [x] T8 `internal/config/config.go` 增加 `BotConfig` + 默认值 + env；同步 `configs/config.yaml`、`config.example.yaml`、`dist/deploy/config.yaml`
- [x] T9 `cmd/app/main.go` 装配 shellctl/groupmeta/bot 并注入 ingest；关闭时 `CloseAll`
- [x] T10 `go build ./... && go vet ./...` 通过

## 客户端

- [x] C1 `utils/storage.ts` 增 `KEYS.credentials`；`store/auth.ts` 增 `saveCredentials/loadCredentials/clearCredentials/silentRelogin`
- [x] C2 `pages/login/index.tsx` 增「记住账号密码」开关、预填、自动提交
- [x] C3 `app.tsx` bootstrap 与 `services/api.ts` `handleUnauthorized` 接入静默重登
- [x] C4 `components/GroupChip/` 新建（头像 URL + onError 回退纯文字）
- [x] C5 `components/SourceCard/index.tsx` 改用 `GroupChip`（groups → {group_id,name}）
- [x] C6 `components/ItemCard/index.tsx` 来源行显示首个群头像 + 群名列表
- [x] C7 `pages/login/index.scss` 修复 `.login__input` 文字偏移；全站样式美化（app.scss / ItemCard / SourceCard / PageHeader / TabBar）
- [x] C8 `app.scss` + `pages/schedule/index.scss` 增加响应式覆盖（≥700px 根字号、`.page-root` 居中限宽、列表双列 grid）
- [x] C9 `pages/detail/index.scss` `.detail__textarea`/`.detail__input` 统一 `font-family:inherit` + 行高/内边距
- [x] C10 `utils/text.ts` 新建 `normalizeNotes`；`pages/detail/index.tsx` 初始化与保存时套用
- [x] C11 前端构建 `npm run build:h5` 通过（无 TS/构建错误）

## 交付与部署

- [~] D1 复制 `client/dist` → `server/internal/web/dist`；交叉编译 linux amd64（已完成）；上传并 kill 重启（阻塞：SSH 认证失败，产物已放桌面「服务端部署」）
- [~] D2 更新远端 `bot:` 配置并 `curl /healthz` 验证（阻塞：同上）
- [x] D3 构建 Tauri 客户端 exe（`npm run desktop:build`）
- [x] D4 构建 Android apk（build:h5 + cap:sync + gradlew assembleDebug）
- [x] D5 全部产物复制到 `C:\Users\Surface\Desktop\日程助手-发布`
