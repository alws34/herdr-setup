#!/bin/sh
# Side chat backend: ask a question on the side of a tab's Claude Code session.
# usage: ask.sh <terminal> <side session id | -> <question>
# The first question forks the terminal's session (claude --resume <id> --fork-session), so the
# side Claude knows the whole conversation and the main session is never touched; follow-ups
# resume that fork. Read-only: only the Read, Grep and Glob tools exist for it (--tools), so the
# user's allow rules can't run anything, and no MCP servers start (--strict-mcp-config: the
# `browser` MCP would otherwise start a hidden browser per question).
# Prints claude's JSON result ({ session_id, result, is_error, ... }) on stdout.
t=$1; side=$2; q=$3

if [ "$side" = "-" ]; then
  # The terminal's Claude session: its claude process carries HC_TERMINAL_ID, and
  # ~/.claude/sessions/<pid>.json names the session (as mods/term-search/search.sh does).
  sid=""
  for p in $(pgrep -x claude); do
    pt=$(ps -E -p "$p" -o command= 2>/dev/null | grep -oE 'HC_TERMINAL_ID=[^ ]+' | head -1 | cut -d= -f2)
    [ "$pt" = "$t" ] || continue
    sid=$(jq -r '.sessionId // empty' "$HOME/.claude/sessions/$p.json" 2>/dev/null)
    [ -n "$sid" ] && break
  done
  [ -n "$sid" ] || { echo '{"is_error":true,"result":"Could not find this tab'"'"'s Claude session."}'; exit 0; }
  exec claude -p --resume "$sid" --fork-session --tools "Read,Grep,Glob" --strict-mcp-config --permission-mode default --output-format json -- "$q"
fi
exec claude -p --resume "$side" --tools "Read,Grep,Glob" --strict-mcp-config --permission-mode default --output-format json -- "$q"
