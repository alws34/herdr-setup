#!/bin/sh
# Which transcript a Claude Code terminal is writing, for the canvases mod. A copy of
# mods/chat/find.sh (mods can't share code): keep the two in step.
# usage: find.sh <claude's cwd> <terminal title> <sessionId from ~/.claude/sessions/<pid>.json>
# The sessions file's id can be stale (a resumed or continued session keeps writing a new
# transcript while the file still names the old one: seen on the user's main tab). Claude Code
# titles its terminal with the session's title, which the transcript records as aiTitle (or
# customTitle after /rename), so the newest transcript in the folder's project whose latest
# title matches the terminal's is taken, unless the sessions file's transcript was written more
# recently (after /clear the new one has no title yet). Else the newest transcript there.
cwd=$1; title=$2; sid=$3
dir="$HOME/.claude/projects/$(printf '%s' "$cwd" | sed 's/[^a-zA-Z0-9]/-/g')"
a=""; b=""
if [ -n "$title" ]; then
  for f in $(ls -t "$dir"/*.jsonl 2>/dev/null | head -30); do
    t=$(tail -c 1000000 "$f" | grep -o '"\(aiTitle\|customTitle\)":"[^"]*"' | tail -1 | sed 's/^[^:]*:"//; s/"$//')
    [ "$t" = "$title" ] && { a=$f; break; }
  done
fi
[ -n "$sid" ] && b=$(ls -t "$HOME"/.claude/projects/*/"$sid".jsonl 2>/dev/null | head -1)
# Both: the one written last (after /clear the new transcript has no title yet).
if [ -n "$a" ] && [ -n "$b" ]; then [ "$b" -nt "$a" ] && echo "$b" || echo "$a"
elif [ -n "$a$b" ]; then echo "$a$b"
# A session id with no transcript yet: a fresh session (one is written on the first message), so
# nothing. The newest transcript there was the previous session's: a new tab showed it (2026-11-04).
elif [ -z "$sid" ]; then ls -t "$dir"/*.jsonl 2>/dev/null | head -1; fi
