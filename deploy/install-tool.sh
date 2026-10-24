#!/bin/sh
# 安装命令行工具并写入持久化清单；容器重启/更新后由 entrypoint 自动恢复。
set -e

PKG="$1"
if [ -z "$PKG" ]; then
  echo "用法: autonotice-install-tool <apt 包名>"
  exit 2
fi
case "$PKG" in
  *[!a-z0-9+.-]*)
    echo "包名不合法: $PKG"
    exit 2
    ;;
esac

mkdir -p /app/data/tools
apt-get update -qq
apt-get install -y --no-install-recommends "$PKG"

if ! grep -qx "$PKG" /app/data/tools/packages.txt 2>/dev/null; then
  echo "$PKG" >> /app/data/tools/packages.txt
fi

if command -v "$PKG" >/dev/null 2>&1; then
  echo "已安装并持久化：$PKG（$(command -v "$PKG")）"
else
  echo "已安装并持久化：$PKG（可执行文件可能不是同名命令，可用 dpkg -L $PKG 查看）"
fi
