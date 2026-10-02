#!/bin/zsh

set -eu

dashboard_url="https://portfolio-dashboard-delta-eight.vercel.app/"

print -rn -- "$dashboard_url" | pbcopy

echo ""
echo "========================================"
echo "固定持仓链接："
echo "$dashboard_url"
echo "========================================"
echo ""
echo "链接已复制到剪贴板。电脑无需启动本地服务。"

if [[ "${1:-}" != "--no-open" ]]; then
  open "$dashboard_url"
  osascript -e 'display notification "固定链接已复制" with title "持仓看板"' >/dev/null 2>&1 || true
fi
