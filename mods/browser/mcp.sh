#!/bin/sh
# The `browser` MCP for Claude Code (registered once: `claude mcp add -s user browser -- <this file>`).
# Claude Code runs inside a herdr terminal, and the MCP servers it starts inherit
# HC_TERMINAL_ID; chrome.mjs maps that terminal to its Herdr tab and makes sure that
# tab's own browser (the Electron window shown over the tab's browser pane) runs, so each
# session drives only its own browser. Outside Herdr it uses a shared "default" one.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
here=$(cd "$(dirname "$0")" && pwd)
port=$(node "$here/chrome.mjs" port-for-terminal "${HC_TERMINAL_ID:-}") || { echo "browser: could not start the browser" >&2; exit 1; }
# Pinned: chrome-devtools-mcp 1.11.0 (2026-10-15). The browser's own toolbar page is
# blocked so Claude only sees the web pages.
exec npx -y chrome-devtools-mcp@1.11.0 --browserUrl "http://127.0.0.1:$port" --no-usage-statistics --no-performance-crux \
  --blockedUrlPattern "file://$here/shell/ui.html"
