#!/bin/sh
# 容器启动入口：恢复主人让 AI 安装过的命令行工具，再启动服务端。
set -e

mkdir -p /app/data/tools/bin
export PATH="/app/data/tools/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive

# 国内服务器访问 deb.debian.org 经常超时，启动时切到阿里云镜像。
if [ -f /etc/apt/sources.list.d/debian.sources ]; then
  sed -i 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g; s|http://security.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' \
    /etc/apt/sources.list.d/debian.sources
fi

PACKAGE_FILE="/app/data/tools/packages.txt"
if [ -s "$PACKAGE_FILE" ]; then
  echo "[tools] 正在恢复持久化工具：$(tr '\n' ' ' < "$PACKAGE_FILE")"
  # 与运行中的 autonotice-install-tool 共用一把锁，避免 apt 并发冲突。
  exec 9>/app/data/tools/.apt.lock
  if flock -w 120 9; then
    timeout 60 apt-get update -qq || echo "[tools] apt update 超时/失败，跳过在线刷新"
    while IFS= read -r pkg; do
      [ -z "$pkg" ] && continue
      if dpkg -s "$pkg" >/dev/null 2>&1; then
        continue
      fi
      echo "[tools] 安装 $pkg"
      timeout 180 apt-get install -y --no-install-recommends "$pkg" \
        || echo "[tools] $pkg 安装失败（可能暂无网络），稍后可让 AI 重新安装"
    done < "$PACKAGE_FILE"
  else
    echo "[tools] apt 正被占用，跳过本次恢复"
  fi
else
  echo "[tools] 暂无持久化工具"
fi

exec "$@"
