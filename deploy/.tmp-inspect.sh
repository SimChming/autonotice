#!/usr/bin/env bash
find /opt/autonotice/napcat -maxdepth 4 -name '*.json' 2>/dev/null | head -20
echo ---
for f in /opt/autonotice/napcat/config/onebot11_*.json; do
  [ -f "$f" ] || continue
  echo "## $f"
  cat "$f"
done
