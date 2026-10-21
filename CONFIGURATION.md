# Autonotice / qqsched 自助环境配置手册

> 这份文档是给**服务器上的 DeepSeek（鲸鱼娘）**和**主人本机**共用的操作手册。
> 目标：机器人可以在不询问主人的情况下，自己查、自己改自己的运行环境，并把结论写回本文档。
>
> 双向同步方式（两边都按「修改时间新的覆盖旧的」合并）：
>
> - 本机：`C:\Users\Surface\Documents\Trae-CN\default\CONFIGURATION.md`
> - 服务器：`/opt/qqsched/src/CONFIGURATION.md`
> - 本机执行 `powershell -File sync-docs.ps1` 即可双向同步（同时同步 HANDOFF.md / requirements.txt）。
> - **追加内容一律写在文末「变更记录」里，不要删除别人写的内容**，避免互相覆盖。

---

## 1. 部署速查

| 项目 | 值 |
| --- | --- |
| 公网 IP | `120.26.224.86` |
| 服务端口 | `8080`（API 与 H5 同一端口） |
| 二进制 | `/opt/qqsched/qqsched` |
| 环境变量 | `/opt/qqsched/app.env`（含 `ADMIN_PASSWORD`，权限 600，LF 换行） |
| 数据库 | `/opt/qqsched/data/app.db`（SQLite，无 sqlite3 命令行，可用 python3 标准库读取） |
| 源码副本 | `/opt/qqsched/src/server` |
| 文档 | `/opt/qqsched/src/HANDOFF.md`、`/opt/qqsched/src/CONFIGURATION.md` |
| 服务管理 | `systemctl restart qqsched` / `systemctl status qqsched` |
| 健康检查 | `curl -s http://127.0.0.1:8080/healthz` |
| NapCat | 反向 WebSocket 连入 `/onebot/v11/ws/`，重启服务后会自动重连（登录态可能需要重新扫码） |

---

## 2. 配置优先级（最容易踩的坑）

**数据库里的 `settings.runtime` 会覆盖 `config.yaml`。**
也就是说：

- 改 `config.yaml` 再重启 → **不生效**（会被数据库里的快照盖掉）。
- 正确做法：通过后台 API `PUT /api/v1/admin/settings` 写入数据库，服务端会立刻热更新（不需要重启）。

读取当前生效配置：

```bash
PW=$(grep '^ADMIN_PASSWORD=' /opt/qqsched/app.env | cut -d= -f2-)
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/api/v1/admin/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PW\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
curl -s http://127.0.0.1:8080/api/v1/admin/settings -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

写入配置（只写要改的字段，服务端做浅合并）：

```bash
curl -s -X PUT http://127.0.0.1:8080/api/v1/admin/settings \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"deepseek":{"model":"qwen3.8-flash"}}' | python3 -m json.tool
```

注意：

- `deepseek.api_key` 返回的是掩码 `sk-****xxxx`；**提交含 `*` 的 key 会被忽略并保留旧值**，换密钥时提交完整新 key。
- 设置写入后立即对下一条消息生效，无需重启。

### 2.1 settings.runtime 字段说明

```json
{
  "deepseek": {
    "api_key": "...",
    "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "model": "qwen3.8-flash",
    "enable_thinking": false
  },
  "capabilities": { "image": true, "sticker": true, "voice": true, "video": true, "file": true, "recall": true, "at_all": true },
  "auto_segment": {
    "enabled": true,
    "targets": ["owner"],
    "min_delay_ms": 1200,
    "max_delay_ms": 2600,
    "max_segments": 3,
    "start_index": 2
  },
  "babble": {
    "enabled": true,
    "windows": ["06:00-08:00", "11:00-13:00", "16:00-24:00"],
    "max_per_day": 3,
    "probability": 12,
    "quiet_minutes": 45,
    "recent_minutes": 30
  },
  "docs": { "quota_per_day": 2 }
}
```

- `model`：当前账号可用的模型见第 3 节；`enable_thinking=false` 时响应更快（聊天/抽取场景建议关闭）。
- `capabilities`：七类 NapCat 能力的总开关，关闭后模型即使输出对应调用也会被清洗。
- `auto_segment`：**多段回复**（一次回复拆成多条消息，不需要对方先回复）。
  - `targets`：`["owner"]` 表示只对主人生效；也可以填具体 QQ 号做白名单。
  - `min_delay_ms` / `max_delay_ms`：两段之间的随机延时区间（模型也可在单段里用 `wait_ms` 指定，服务端上限 8 秒）。
  - `max_segments`：最多补发几条（1–10）。
  - `start_index`：从第几条开始补发（2 = 主回复算第 1 条，后续全部补发）。
  - 模型在 JSON 的 `segments` 里按顺序给出后续消息；每条可带 `api`（发图片/表情/语音等 OneBot 调用）或 `autonotice`（推送提醒/闹钟），系统先执行动作再发该条文字，保证多段之间有递进关系。旧的 `followups`（纯文本数组）仍然兼容。
  - 若模型没给 `segments`/`followups`，服务端会把较长的多句回复按句号/换行自动拆成 2–3 段。
- `babble`：**群内随机冒泡**（机器人主动在群里随口接一句，不带 @）。
  - `windows`：允许冒泡的时段，格式 `HH:MM-HH:MM`，`24:00` 表示当天结束。
  - `max_per_day`：每天所有群累计最多冒泡几条（1–10）。
  - `probability`：**每小时**触发概率（百分比），服务端每 5 分钟评估一次。
  - `quiet_minutes`：同一个群两次冒泡之间的最小间隔。
  - `recent_minutes`：只有最近这个时间窗口内有人在聊天（至少 2 条非机器人消息）才会考虑冒泡。
- `docs.quota_per_day`：每人每天文档生成配额（1–20）。

---

## 3. 模型与视觉能力

`base_url` 固定为 `https://dashscope.aliyuncs.com/compatible-mode/v1`（DashScope 兼容模式）。

| 模型 | 说明 |
| --- | --- |
| `qwen3.8-flash` | 默认聊天模型，速度最快，纯文本 |
| `qwen3-vl-plus` | **视觉模型**，能看图（QQ 图片识别必须用这类模型） |
| `qwen3.8-omni-flash` | 多模态，可看图，速度较快 |
| `qwen-plus` / `qwen-max` | 通义通用文本模型 |
| `deepseek-chat` / `deepseek-reasoner` | DeepSeek 文本模型 |
| `qwen-vl-plus` | **该账号下不存在**，调用会返回 `model_not_found` |

JSON 模式要求：请求里必须出现 `json` 关键词（代码已处理；手工调试时注意）。
图片识别：`bot` 会把图片下载成 base64 data URI 后随消息一起发给模型，所以必须选视觉模型。

自检模型连通性：

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/admin/settings/test-llm \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
# → {"ok":true,"model":"...","reply":"OK"}
```

---

## 4. 主人 / 白名单

- 内置主人 QQ：`3874095145`（`CONTROL_QQ`，恒为 `owner`，不可删除 / 降级，拥有 shell 与后台权限）。
- 四档角色存于 `bot_roles` 表（`qq` 主键 + `role` + `note` + `enabled`），后台可增删改，30 秒内热生效：

| 角色 | 权限 |
| --- | --- |
| `owner` | 全部权限：shell、写入系统级偏好、操作任意已绑定账号、后台 SSO |
| `admin` | 可驱动机器人 / OneBot / Autonotice 动作，但不能执行 shell、不能写系统偏好 |
| `member` | 正常聊天 + 调用系统能力（默认） |
| `guest` | 只能文字聊天，Autonotice / OneBot 动作一律拒绝 |

- `GET/POST /api/v1/admin/bot-users`、`DELETE /api/v1/admin/bot-users/{qq}` 管理角色；内置主人只允许 `owner`，尝试降级 / 删除返回 `409`。
- 旧的 `settings.owners` 名单仍作为 `owner` 兼容保留，启动时以 `INSERT OR IGNORE` 写入 `bot_roles`，不覆盖后台已改过的角色。
- 客户端账号「杨镇赫的机器人」已绑定该 QQ，服务端 `GET /api/v1/me/privileges` 会返回 `is_owner=true`；
  客户端据此显示「后台」入口，并用 `POST /api/v1/admin/owner-sso` 免密换取后台 token。
- 非主人 QQ 请求 shell / root 时，只回复调皮的拒绝话术，不消耗模型额度。

后台 API 一览（全部需要 admin scope token）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/v1/admin/login` | 账号密码登录，拿 admin token |
| GET/PUT | `/api/v1/admin/settings` | 读取 / 修改运行配置 |
| POST | `/api/v1/admin/settings/test-llm` | 测试模型连通 |
| GET/POST | `/api/v1/admin/bot-users` | QQ 用户与角色列表 / 新增或修改 |
| DELETE | `/api/v1/admin/bot-users/{qq}` | 移除某个 QQ 的角色配置 |
| GET/POST/DELETE | `/api/v1/admin/owners` | 旧主人白名单（兼容保留） |
| GET | `/api/v1/admin/status` | NapCat / 模型 / 文档状态 |
| GET | `/api/v1/admin/audit` | 管理操作审计 |
| GET | `/api/v1/admin/doc-files` | 文档生成记录 |

---

## 5. Autonotice Agent API（任意大模型可直接调用）

QQ 机器人、App/网页，以及**任意第三方大模型**都能通过这套接口驱动某个 Autonotice 账号的客户端（发提醒、震动闹钟、增删改日程）。鉴权用普通用户 JWT（`Authorization: Bearer <user token>`），与 App 登录态一致。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/v1/agent/catalog` | 动作清单（机器可读，便于大模型做 tool discovery） |
| POST | `/api/v1/agent/actions` | 执行一个动作，body: `{"action":"notify.send","params":{...}}` |
| GET | `/api/v1/me/actions` | 本账号待执行的客户端动作（客户端 15s 轮询） |
| POST | `/api/v1/me/actions/{id}/ack` | 客户端执行完回执，避免重复提醒 |

动作清单：

- `account.whoami`：返回 user_id / 已绑定 QQ / 是否主人。
- `notify.send` `{title, body, level(info|important|urgent), at(RFC3339，可空), vibrate(bool), route}`：推送到该账号客户端，弹系统通知/应用内横幅。
- `client.alarm` `{title, body, mode(vibrate|ring|both)}`：让客户端立即震动/响铃（叫醒、强提醒）。
- `schedule.list` `{limit}`、`schedule.create` `{title, type, priority, due_at, remind_at, notes, all_day}`、`schedule.update` `{id, ...}`、`schedule.delete` `{id}`。

权限（硬规则，服务端强制执行，不依赖模型自觉）：

- 普通账号只能操作**自己**：params 里传 `target_qq` / `target_user_id` 一律 403 `forbidden`。
- 主人账号（`CONTROL_QQ` 与后台主人白名单）可传 `target_qq`（该 QQ 必须已验证绑定）或 `target_user_id` 操作他人。
- QQ 侧：机器人先按发送者 QQ 反查已验证绑定；未绑定任何账号的用户只能聊天，动作请求会被拒绝并提示先绑定。主人不受此限制（但仍不能操作未绑定 QQ）。
- 动作只落库 + WS 推送，真正的弹窗/震动由客户端轮询执行；客户端离线时下次上线补执行，执行后 ack。

示例：

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/agent/actions \
  -H "Authorization: Bearer $USER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"action":"notify.send","params":{"title":"该交作业啦","body":"今晚 23:59 截止","level":"urgent","vibrate":true}}'
```

QQ 机器人侧（模型输出字段）：

```json
{"autonotice": {"action": "client.alarm", "params": {"title": "起床啦", "body": "早八要迟到了", "mode": "both"}}}
```

### 5.1 总结指针与长期偏好记忆

- **总结指针**：按 `(user_id, group_id)` 各存一条游标（表 `summary_cursors`，字段 `last_msg_time` + `last_row_id`）。每次「AI 总结」只从游标之后的新消息开始汇总，成功后指针推进到最后一条被消费的消息；同一秒多条消息用 SQLite `rowid` 精确定位。冷启动（没有游标）才回落到默认 168 小时窗口。
  - 手动重排 `POST /api/v1/replan/run` 默认走游标；需要整窗重扫时显式加 `?full=1`。
  - 定时排程（daily 7 点、light 每 2 小时）同样推进指针，不会重复汇总同一批消息。
- **长期偏好（preference）**：`memories` 表用 `kind`（`chat` / `preference`）+ `scope`（`peer` / `global`）区分。
  - 聊天中模型输出的 `memory.scope="system"` 只有在说话人是主人时才落库为 `global`；普通同学一律降级为普通记忆。
  - 总结流程也会抽取「目标用户本人明确强调的长期偏好」（每轮最多 3 条，每条 ≤120 字），写库前同样校验主人身份。
  - 下一轮聊天时，服务端直接按 `(scope='global' OR 本人)` 查出偏好，作为【长期偏好】块注入 prompt（最多 12 条），不依赖关键词命中。

### 5.2 三层上下文记忆（QQ 机器人）

参考业界常用的「短期缓冲 + 滚动摘要 + 长期检索」架构，全部落库、重启不丢：

| 层 | 载体 | 行为 |
| --- | --- | --- |
| L0 工作缓冲 | 内存 `history` + 表 `bot_turns` | 每个会话保留最近 `HistoryTurns` 轮；进程启动后首次触达会话时从 `bot_turns` 水合一次 |
| L1 滚动摘要 | 表 `bot_summaries` | 未摘要 turn ≥16 条时，后台异步把较早的（保留最新 10 条原文）压缩成 ≤700 字摘要，注入 prompt 时截断到 900 字；失败不影响回复 |
| L2 长期记忆 | 表 `memories` | 跨会话（当前群 + 该 QQ 在其他会话的片段）候选 200 条，按关键词命中 ×2、同发言人 +3、同会话 +1.5、时效加分排序，取 TopN（默认 5）；无关键词命中且分数 <4.5 直接丢弃 |

- `bot_turns` 每会话保留 120 条，写库是 fire-and-forget（5s 超时），慢盘不会拖慢回复。
- 摘要与偏好互不替代：`kind=preference` 的偏好仍每轮全量注入（≤12 条）。
- 原有 `memories` 数据、`summary_cursors`、偏好配置全部沿用，不需要迁移脚本。
- 发送安全：回复按 CQ 码原子边界分块（`splitMessage`），图片 / 文件 / 语音等 CQ 码绝不截断；即使自动分段关闭，`segments` 里的 API / Autonotice 动作仍会执行，不再出现「说要发图片却没有发」。

---


## 6. 编译与部署（服务器上）

内存只有 1.7G，**严禁并行编译**，必须先加内存限制：

```bash
free -h
cd /opt/qqsched/src/server
systemd-run --scope -p MemoryMax=1200M -p MemorySwapMax=1G -- \
  env GOMAXPROCS=1 go build -p 1 -trimpath -ldflags="-s -w" -o /opt/qqsched/qqsched.new ./cmd/app
mv -f /opt/qqsched/qqsched.new /opt/qqsched/qqsched
systemctl restart qqsched
sleep 2 && curl -s http://127.0.0.1:8080/healthz
```

- 前端（Taro）**不能**在服务器上构建，只能在主人本机构建后把产物放到 `server/internal/web/dist`，再随二进制 `go:embed` 打包。
- 重启后 NapCat 反向 WS 会自动重连；若 QQ 登录态失效，需要主人重新扫码。
- 改动前先 `cp` 备份；改完 `go build ./...`、`go vet ./...` 自检。

---

## 7. 常见故障速查

| 现象 | 原因 / 处理 |
| --- | --- |
| @ 机器人固定回「鲸鱼脑有点晕」 | API key 失效（401），先 `test-llm`；换 key 用 PUT settings |
| 图片识别不出来 | 模型不是视觉模型；切 `qwen3-vl-plus` 或 `qwen3.8-omni-flash` |
| 改了 config.yaml 没反应 | 数据库 settings 覆盖，必须走后台 API |
| 服务进程僵死、SSH 连不上 | 编译触发 OOM，控制台重启实例，之后务必加 MemoryMax |
| 客户端提示网络不可用 | CORS / 明文流量 / API_BASE 同源配置问题，见 HANDOFF.md |
| 后台设置保存后旧值还在 | `api_key` 掩码含 `*` 被忽略，属于预期行为 |
| 自主补发不生效 | `auto_segment.enabled=false`，或发送者不在 `targets` 里 |
| 说要发图片 / 文件却没发 | 旧版本按宽度硬切导致 CQ 码截断、或分段关闭后动作被丢弃；1.0.5 起改用 CQ 原子分块并兜底执行 segments 动作 |
| 机器人「失忆」 | 检查 `bot_turns` / `bot_summaries` 是否增长；L1 摘要需模型可用，失败只记 warn 不影响聊天 |
| 新增用户后权限没变化 | 角色缓存 30 秒 TTL，等半分钟或重启；确认 `bot_roles.enabled=1` |
| QQ 里让机器人设提醒没反应 | 该 QQ 未绑定 Autonotice 账号；先在客户端登录并绑定，再让机器人操作 |
| Agent 动作成功但手机没弹 | 客户端未打开/未授权通知；动作在队列里，客户端上线轮询后会补发并 ack |
| Agent 调 `target_qq` 返回 403 | 调用者不是主人；普通账号只能操作自己 |

---

## 8. 变更记录（两边都往这里追加）

格式：`- YYYY-MM-DD 谁（主人 / 鲸鱼娘）改了什么，为什么`

- 2026-10-21 主人：初版。整理配置优先级、后台 API、模型清单、编译部署与故障速查。
- 2026-10-21 主人：`auto_segment` 默认开启（targets=`owner`，1.2–2.6s，最多 3 段），并要求模型优先「一次问完所有缺失信息、先结论后补充」。
- 2026-10-21 主人：新增 Autonotice Agent API（`/agent/catalog`、`/agent/actions`、`/me/actions`、ack），QQ 机器人新增 `autonotice` 工具字段并明确自己是 Autonotice 的一部分；普通账号只能操作自己绑定的账号，主人可指定 target。
- 2026-10-21 主人：总结改为按 `(user_id, group_id)` 游标增量汇总（`?full=1` 才整窗重扫）；新增 `kind=preference/scope=global` 长期偏好记忆，仅主人可写入并每轮注入；多段回复改用 `segments`（段间可插 API/Autonotice 动作，保证递进连续）；新增 `babble` 群内随机冒泡（时段 6-8/11-13/16-24，每天 ≤3 条）。
- 2026-10-21 鲸鱼娘：v1.0.5 —— 记忆重构为 L0 `bot_turns` / L1 `bot_summaries` / L2 跨会话召回；权限改为 `bot_roles` 四档角色并新增后台「QQ 用户与权限」管理；修复 CQ 码被硬切导致图片/文件发送失败、以及分段关闭时 segments 动作被丢弃的问题；文档、语音、视频、表情、撤回发送已统一走能力开关 + 原子分块。
