#!/usr/bin/env sh
# 服务器端唯一运维脚本（§8.2）：pull → up → healthz 自检 → 清理旧镜像
set -eu

cd "$(dirname "$0")"

echo "[1/3] 安装/更新开机自启服务"
if [ -f ./autonotice.service ]; then
  cp ./autonotice.service /etc/systemd/system/autonotice.service
  systemctl daemon-reload
  systemctl enable autonotice.service >/dev/null 2>&1 || true
fi

echo "[2/3] 启动服务（镜像由 CI 通过 SSH 传入，不在服务器拉取）"
docker compose up -d server

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
