#!/bin/sh
# 容器启动入口：恢复主人让 AI 安装过的命令行工具，再启动服务端。
set -e

mkdir -p /app/data/tools/bin
export PATH="/app/data/tools/bin:$PATH"

PACKAGE_FILE="/app/data/tools/packages.txt"
if [ -s "$PACKAGE_FILE" ]; then
  echo "[tools] 正在恢复持久化工具：$(tr '\n' ' ' < "$PACKAGE_FILE")"
  apt-get update -qq || echo "[tools] apt update 失败，跳过在线恢复"
  while IFS= read -r pkg; do
    [ -z "$pkg" ] && continue
    if dpkg -s "$pkg" >/dev/null 2>&1; then
      continue
    fi
    echo "[tools] 安装 $pkg"
    apt-get install -y --no-install-recommends "$pkg" \
      || echo "[tools] $pkg 安装失败（可能暂无网络），稍后可让 AI 重新安装"
  done < "$PACKAGE_FILE"
else
  echo "[tools] 暂无持久化工具"
fi

exec "$@"
