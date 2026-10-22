# Autonotice v2 运维手册（HANDOFF）

> 本文件替代旧版 `/opt/qqsched` 手册。工程设计与阶段说明见同仓库 `AI-WORKFLOW.md`。

## 1. 线上拓扑

| 项目 | 值 |
| --- | --- |
| 服务器 | `120.26.224.86`（阿里云 ECS，Ubuntu 22.04.5） |
| 部署目录 | `/opt/autonotice`（`data/`、`napcat/`、`.env`、`docker-compose.yml`、`deploy.sh`） |
| 容器 | `autonotice-server`（8080）、`autonotice-napcat`（6099） |
| 访问 | Web/API：`http://120.26.224.86:8080`；管理后台：`/admin` |
| 仓库 | GitHub `SimChming/autonotice`，开发分支 `v2` |
| 镜像 | `ghcr.io/simchming/autonotice-server:latest` + `v<run_number>` |

SSH：`root@120.26.224.86`，本机 `~/.ssh/id_ed25519` 与 CI 专用 `~/.ssh/autonotice_deploy` 均已授权。

## 2. 部署流程（唯一入口）

1. 推送 `v2`（或 `main`）→ GitHub Actions `CI` 跑 typecheck/lint/test/build。
2. `Deploy` workflow：runner 侧构建镜像并推到 ghcr → `docker save | gzip | ssh 'gunzip | docker load'` 传到服务器 → `deploy.sh` 启动并健康检查。
3. **不要在服务器上编译**（内存仅 1.7GB，容易 OOM）。服务器只允许 Docker。

查看部署：

```bash
ssh root@120.26.224.86 'cd /opt/autonotice && docker compose ps && docker logs --tail 100 autonotice-server'
```

## 3. 配置

- 运行时配置：`/opt/autonotice/.env`（600 权限、LF 换行）。修改后需重启 server 容器才生效。
- 热更新：管理后台「模型」页写入数据库 `settings`，聊天/抽取立即生效，无需重启。
- 管理员账号：`ADMIN_USERNAME` / `ADMIN_PASSWORD`（见 `.env`），登录 `/admin`。
- LLM：DashScope compatible-mode；默认 `LLM_MODEL=deepseek-v4.1-flash`，视觉 `qwen3-vl-plus`，向量 `text-embedding-v4`。

## 4. NapCat / QQ

- 小号 `3754609823` 存在风控：**容器重建后通常需要重新扫码**；WebUI 6099 被阿里云安全组拦截，使用本机 SSH 隧道：

```powershell
ssh -N -L 6099:127.0.0.1:6099 root@120.26.224.86
```

然后打开 `http://127.0.0.1:6099/webui/?token=<webui token>`（token 见 `napcat/config/webui.json` 或容器日志）。

- 反向 WS 配置：`/opt/autonotice/napcat/config/onebot11_3754609823.json`，指向 `ws://server:8080/onebot/v11/ws`，token 与 `.env` 的 `ONEBOT_ACCESS_TOKEN` 一致；字段是 **`enable`**（不是 `enabled`）。
- 不想掉登录：不要频繁 `docker compose up -d` 重建 napcat。

## 5. 数据与备份

- SQLite：`/opt/autonotice/data/app.db`（WAL 模式，含 `-wal/-shm`）。
- 备份：

```bash
ssh root@120.26.224.86 'cd /opt/autonotice && tar czf /tmp/autonotice-data-$(date +%F).tgz data napcat/config'
```

- 恢复：停 server → 覆盖 `data/` → 起 server（迁移会自动执行）。

## 6. 常用排查

| 现象 | 处理 |
| --- | --- |
| 机器人回复兜底话术 | 检查 `.env` 的 `LLM_API_KEY` 是否失效 |
| OneBot 未连接 | 看 napcat 日志是否登录成功；确认反向 WS 地址与 token |
| 8080 访问超时 | 阿里云安全组是否放行 8080；`docker compose ps` |
| 部署拉镜像慢 | 已改为 SSH 传镜像；若仍慢查 CI 日志 |
| 技能异常 | 管理后台「技能」页启停；或让主人在 QQ 里让机器人 `tool.skill.manage` 自检 |

## 7. 已知限制

- 本机无 Android SDK / Rust 工具链，未产出 APK / exe；三端目前以 Web（含移动端自适应）交付。
- 48 小时稳定性观察尚未完成（Phase 8 观察项）。
- 触发器为一次性执行，暂不支持 cron 周期表达式。
- shell 技能运行在 server 容器内（非宿主机 root），无法操作 Docker/宿主机。
