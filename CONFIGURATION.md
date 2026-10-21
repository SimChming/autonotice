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
  "docs": { "quota_per_day": 2 }
}
```

- `model`：当前账号可用的模型见第 3 节；`enable_thinking=false` 时响应更快（聊天/抽取场景建议关闭）。
- `capabilities`：七类 NapCat 能力的总开关，关闭后模型即使输出对应调用也会被清洗。
- `auto_segment`：**自主补发**（一次回复拆成多条消息，不需要对方先回复）。
  - `targets`：`["owner"]` 表示只对主人生效；也可以填具体 QQ 号做白名单。
  - `min_delay_ms` / `max_delay_ms`：两段之间的随机延时区间。
  - `max_segments`：最多补发几条（1–10）。
  - `start_index`：从第几条开始补发（2 = 主回复算第 1 条，后续全部补发）。
  - 模型在 JSON 的 `followups` 里给出后续分段；若模型没给，服务端会把较长的多句回复按句号/换行自动拆成 2–3 段。
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

- 内置主人 QQ：`3874095145`（`CONTROL_QQ`，拥有 shell 与后台权限）。
- 追加/移除主人：`POST /api/v1/admin/owners`、`DELETE /api/v1/admin/owners/{qq}`。
- 客户端账号「杨镇赫的机器人」已绑定该 QQ，服务端 `GET /api/v1/me/privileges` 会返回 `is_owner=true`；
  客户端据此显示「后台」入口，并用 `POST /api/v1/admin/owner-sso` 免密换取后台 token。
- 非主人 QQ 请求 shell / root 时，只回复调皮的拒绝话术，不消耗模型额度。

后台 API 一览（全部需要 admin scope token）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/v1/admin/login` | 账号密码登录，拿 admin token |
| GET/PUT | `/api/v1/admin/settings` | 读取 / 修改运行配置 |
| POST | `/api/v1/admin/settings/test-llm` | 测试模型连通 |
| GET/POST/DELETE | `/api/v1/admin/owners` | 主人白名单 |
| GET | `/api/v1/admin/status` | NapCat / 模型 / 文档状态 |
| GET | `/api/v1/admin/audit` | 管理操作审计 |
| GET | `/api/v1/admin/doc-files` | 文档生成记录 |

---

## 5. 编译与部署（服务器上）

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

## 6. 常见故障速查

| 现象 | 原因 / 处理 |
| --- | --- |
| @ 机器人固定回「鲸鱼脑有点晕」 | API key 失效（401），先 `test-llm`；换 key 用 PUT settings |
| 图片识别不出来 | 模型不是视觉模型；切 `qwen3-vl-plus` 或 `qwen3.8-omni-flash` |
| 改了 config.yaml 没反应 | 数据库 settings 覆盖，必须走后台 API |
| 服务进程僵死、SSH 连不上 | 编译触发 OOM，控制台重启实例，之后务必加 MemoryMax |
| 客户端提示网络不可用 | CORS / 明文流量 / API_BASE 同源配置问题，见 HANDOFF.md |
| 后台设置保存后旧值还在 | `api_key` 掩码含 `*` 被忽略，属于预期行为 |
| 自主补发不生效 | `auto_segment.enabled=false`，或发送者不在 `targets` 里 |

---

## 7. 变更记录（两边都往这里追加）

格式：`- YYYY-MM-DD 谁（主人 / 鲸鱼娘）改了什么，为什么`

- 2026-10-21 主人：初版。整理配置优先级、后台 API、模型清单、编译部署与故障速查。
- 2026-10-21 主人：`auto_segment` 默认开启（targets=`owner`，1.2–2.6s，最多 3 段），并要求模型优先「一次问完所有缺失信息、先结论后补充」。
