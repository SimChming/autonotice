#!/bin/sh
# 把 AI 对环境的一句话改动记录到 AI-WORKFLOW.md，并持久化到 /app/data/ai-notes.md。
set -e

TEXT="$1"
if [ -z "$TEXT" ]; then
  echo "用法: autonotice-workflow-log <一句话记录>"
  exit 2
fi

mkdir -p /app/data
TS=$(date -u -d '+8 hours' '+%Y-%m-%d %H:%M' 2>/dev/null || date '+%Y-%m-%d %H:%M')
LINE="- $TS [AI] $TEXT"

echo "$LINE" >> /app/data/ai-notes.md

DOC=/repo/AI-WORKFLOW.md
if [ -f "$DOC" ] && ! grep -q '^## AI 运行记录（持久化）' "$DOC"; then
  printf '\n## AI 运行记录（持久化）\n\n' >> "$DOC"
fi
if [ -f "$DOC" ]; then
  echo "$LINE" >> "$DOC"
fi

echo "已记录：$LINE"
