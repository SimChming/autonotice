#!/usr/bin/env sh
# 服务器端唯一运维脚本（§8.2）：pull → up → healthz 自检 → 清理旧镜像
set -eu

cd "$(dirname "$0")"

echo "[1/3] 拉取最新镜像"
timeout 1800 docker compose pull server

echo "[2/3] 启动服务"
docker compose up -d

echo "[3/3] 健康检查"
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS http://127.0.0.1:8080/api/v1/healthz >/dev/null 2>&1; then
    echo "healthz OK"
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

echo "healthz 超时，输出最近日志：" >&2
docker compose logs --tail=100 server >&2 || true
exit 1
