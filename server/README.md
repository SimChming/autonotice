# QQ 群 AI 日程助手 — Go 服务端

把 QQ 群消息（含群文件 / 网页链接 / 小程序卡片）按用户聚合，交给 DeepSeek 生成
**结构化日程 JSON**，客户端拉取后本地弹屏提醒；抓不到内容时生成高优先级
「需人工查看」告警。

服务端是**单一静态二进制**：SQLite 使用纯 Go 驱动 `modernc.org/sqlite`，
**无需 CGO**，可直接跑在精简容器或裸机上。

## 目录结构

```
server/
├── cmd/app/main.go        # 装配入口（唯一的 main）
├── internal/
│   ├── config/            # YAML + 环境变量覆盖
│   ├── onebot/            # 协议无关接口 + 归一化事件
│   │   └── v11/           # reverse_ws（推荐）/ http_post / apicaller
│   ├── ingest/            # 事件 → 指纹去重 → 落库 + 抽取文件/链接/卡片
│   ├── contentfetch/      # SSRF 安全直抓 + Jina 回退 + 屏蔽判定
│   │   └── docparse/      # pdf/xlsx/xls/docx/csv/text + zipguard
│   ├── analyze/           # title ↔ 正文比对 + 「需人工查看」文案生成
│   ├── summarize/         # 聚合 + Prompt + DeepSeek 客户端（含重试/校验）
│   ├── schedule/          # 日程模型 / 合并 / 冲突 / 导出
│   ├── store/             # SQLite 仓储 + 迁移执行器
│   ├── scheduler/         # cron 触发（TZ=Asia/Shanghai）
│   ├── auth/              # JWT + 口令哈希 + 群内绑定验证码
│   ├── httpapi/           # 路由 / handler / 中间件
│   └── notify/            # WebSocket 推送 + 可选 QQ 私聊推送
├── migrations/            # embed.FS 内嵌的 SQL 迁移
├── configs/config.example.yaml
└── deploy/                # systemd + docker
```

## 构建

```bash
# 中国网络环境建议先设置镜像（否则 proxy.golang.org 可能不可达）
export GOPROXY=https://goproxy.cn,direct
export GOSUMDB=sum.golang.google.cn

go mod tidy          # 首次会生成 go.sum
go build ./...
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o qqsched ./cmd/app
```

交叉编译（在 Linux 服务器上跑）：

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o qqsched ./cmd/app
```

## 运行

```bash
cp configs/config.example.yaml configs/config.yaml   # 按需修改
./qqsched -config configs/config.yaml
# 或： ./qqsched -config configs/config.yaml -log-level debug
```

未提供配置文件时会使用内置默认值 + 环境变量。

### 主要环境变量

环境变量**覆盖** YAML 同名项，密钥类建议只走环境变量。

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `SERVER_ADDR` | 监听地址 | `:8080` |
| `SERVER_BASE_PATH` | REST 前缀 | `/api/v1` |
| `DATABASE_PATH` | SQLite 文件路径 | `data/app.db` |
| `ONEBOT_MODE` | `reverse_ws` 或 `http_post` | `reverse_ws` |
| `ONEBOT_TOKEN` | 与 NapCat 一致的访问令牌 | — |
| `ONEBOT_WS_PATH` | 反向 WS 挂载路径 | `/onebot/v11/ws` |
| `ONEBOT_HTTP_POST_PATH` | http_post 上报路径 | `/onebot/v11/http` |
| `ONEBOT_API_BASE` | http_post 模式下主动调 API 的地址 | `http://127.0.0.1:3000` |
| `BOT_GROUPS` | 白名单群号，逗号分隔；空=不限 | — |
| `JWT_SECRET` | JWT 签名密钥（**务必改掉**） | — |
| `JWT_TTL_HOURS` | JWT 有效期 | `720` |
| `DEEPSEEK_API_KEY` | DeepSeek 密钥（**必填**） | — |
| `DEEPSEEK_BASE_URL` | OpenAI 兼容地址 | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 模型名（以官方文档为准） | `deepseek-chat` |
| `DEEPSEEK_MAX_TOKENS` / `DEEPSEEK_TIMEOUT_SECONDS` | 生成上限 / 超时 | `4096` / `90` |
| `JINA_ENABLED` | 是否启用 Jina Reader 回退 | `true` |
| `JINA_API_KEY` | Jina 密钥（可选，提高额度） | — |
| `JINA_BASE_URL` / `JINA_ENGINE` | Reader 地址 / `X-Engine` | `https://r.jina.ai/` / 空 |
| `FETCH_ENABLED` | 是否抓取文件与网页 | `true` |
| `FETCH_MAX_BYTES` / `FETCH_WEB_MAX_BYTES` | 文件 / 网页体积上限 | 20MB / 2MB |
| `FETCH_CONCURRENCY` | 抓取并发（1–5） | `4` |
| `NOTIFY_QQ_PRIVATE_PUSH` | 是否用 QQ 私聊推告警 | `false` |
| `TZ` / `SCHEDULE_TIMEZONE` | 定时任务时区 | `Asia/Shanghai` |

> 定时任务默认：每日 `0 7 * * *` 全量增量总结、每 2 小时 `0 */2 * * *` 轻量增量、
> 每日 `30 23 * * *` 清理过期绑定码与裁剪旧消息（见 `schedule` 段的 cron 项）。

## NapCat 反向 WebSocket 配置

服务端作为 WS **服务端**，NapCat 主动连入（无需内网穿透）。两者**同机部署**。

1. 在 NapCat 的 `config/onebot11_<QQ号>.json`（或 WebUI「网络配置」）中新增
   一个**反向 WebSocket 客户端**：

   ```json
   {
     "name": "qqsched",
     "enable": true,
     "url": "ws://127.0.0.1:8080/onebot/v11/ws",
     "token": "与 ONEBOT_TOKEN 完全一致",
     "reportSelfMessage": false,
     "messagePostFormat": "array",
     "enableForcePushEvent": true
   }
   ```

   - `url` 的路径必须等于 `ONEBOT_WS_PATH`（默认 `/onebot/v11/ws`）。
   - `token` 必须等于 `ONEBOT_TOKEN`；服务端同时接受
     `Authorization: Bearer <token>` 与 `?access_token=<token>` 两种形式。
   - `messagePostFormat` 建议 `array`（服务端按 OneBot v11 消息段数组解析）。

2. 重启 NapCat 后，服务端日志会打印 `onebot endpoint`；连接建立即可开始收消息。

3. 服务端通过同一条 WS 双工调用 `get_group_file_url` / `send_*` 等 action
   （`echo` 关联响应）。若使用 `ONEBOT_MODE=http_post`，则 NapCat 用 HTTP 上报，
   服务端经 `ONEBOT_API_BASE` 主动调用 action（需 NapCat 开启 HTTP 服务端口）。

> **风险提示**：NapCat 为非官方框架，存在封号风险。请使用**独立小号**、
> 固定设备与 IP，勿频繁更新 QQ 客户端。

## REST API 一览

前缀 `/api/v1`；除 `auth/*`、`/healthz`、`/metrics` 外均需
`Authorization: Bearer <jwt>`（`/ws` 亦可用 `?token=` 传递）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/register` | 注册（用户名 + 口令） |
| POST | `/auth/login` | 登录，返回 JWT |
| POST | `/bindings/qq/initiate` | 生成群内绑定验证码 |
| POST | `/bindings/qq/confirm` | 校验验证码并置 `verified` |
| GET | `/bindings` | 列出已绑定 QQ |
| DELETE | `/bindings/{qq_uid}` | 解绑 |
| GET | `/schedules/me` | 完整日程文档（带 `ETag`，`If-None-Match` 命中返 `304`） |
| GET | `/schedules/me/delta?since=<rev>` | 自某版本以来的增量（`changed` + `deleted`） |
| GET | `/schedules/me/revision` | 仅取当前 `revision`（轻量轮询） |
| POST | `/schedules/me/items` | 新建一条日程 |
| PATCH | `/schedules/me/items/{id}` | 修改（带 `base_revision`；冲突返 **409 + 服务端最新项**） |
| DELETE | `/schedules/me/items/{id}` | 删除（软删） |
| POST | `/schedules/me/sync` | 离线批量同步（`create`/`update`/`delete`，逐项返回冲突） |
| GET | `/alerts/me` | 「需人工查看」告警列表 |
| POST | `/alerts/me/{id}/read` | 标记告警已读 |
| GET | `/ws` | 实时推送：日程更新 / 新告警（`notify.Event`） |
| GET | `/healthz` `/metrics` | 健康检查 / Prometheus 文本指标 |

日程文档：

```json
{
  "user_id": "…", "qq_uid": "…", "generated_at": "RFC3339",
  "revision": 12, "digest": "sha1…",
  "items": [{
    "id": "uuid…", "title": "交班费", "type": "fee",
    "status": "pending", "priority": "high",
    "due_at": "2026-10-20T18:00:00+08:00", "remind_at": null,
    "all_day": false, "notes": "", "locked_by_user": false,
    "revision": 12,
    "source": {
      "kind": "ai", "group_id": "123456", "message_ids": ["…"],
      "excerpt": "…", "confidence": 0.8,
      "content_asset_id": "…", "link_title": "…", "fetch_status": "ok"
    },
    "created_at": "…", "updated_at": "…"
  }]
}
```

**QQ 绑定**：用户在群里（或私聊 bot）发送 `#bind 123456`，
NapCat 上报后服务端比对 `sender_qq` 即证明其控制该 QQ。**未验证的绑定不进入 AI 总结**。

## 部署

### systemd（推荐，裸机）

```bash
sudo useradd -r -s /usr/sbin/nologin qqsched
sudo mkdir -p /opt/qqsched/data && sudo chown -R qqsched:qqsched /opt/qqsched
sudo cp qqsched /opt/qqsched/
sudo cp configs/config.yaml /opt/qqsched/
sudo cp deploy/app.service /etc/systemd/system/qqsched.service
# 密钥写入 /opt/qqsched/app.env（权限 600）：DEEPSEEK_API_KEY=… 等
sudo systemctl daemon-reload && sudo systemctl enable --now qqsched
sudo journalctl -u qqsched -f
```

NapCat 见 `deploy/napcat.service`（headless 需 Xvfb；脚本路径按官方安装结果调整）。

### Docker

```bash
cd deploy
ONEBOT_TOKEN=xxx DEEPSEEK_API_KEY=sk-xxx JWT_SECRET=yyy docker compose up -d --build
```

SQLite 数据落在命名卷 `qqsched-data`。

## 运维注意

- **务必替换** `JWT_SECRET` 与 `ONEBOT_TOKEN` 的默认值，密钥只放环境变量。
- 抓取有 **SSRF 防护**（连接前校验解析后的 IP，拒绝私网/保留段，仅 http(s) 与
  80/443/8080，重定向逐跳校验 ≤5 次）；文件按 content_hash 缓存复用，
  同一群有每小时抓取上限，避免被滥用。
- 无法解析的内容（扫描版 PDF、需登录、微信小程序卡片等）**不会生成日程**，
  而是生成高优「需人工查看」告警，正文附带卡片标题与前文聊天摘要。
- DeepSeek 返回为空/非法 JSON 时会重试 ≤2 次；仍失败则记为 `failed`
  **不覆盖**旧日程，不影响已有数据。
- 时区由内嵌 `time/tzdata` 提供，容器/裸机无需单独安装 tzdata 也能解析
  `Asia/Shanghai`。
