#!/bin/sh
# Transcript reader for the chat mod: part of a Claude Code transcript as chat items.
# usage: read.sh <transcript.jsonl> <from> [<to>]
#   from = a byte offset, or "tail": the last 300 KB (first paint of a big transcript is the
#          newest messages, in ~0.1 s; older ones are read later, a range at a time)
#   to   = stop there (an offset an earlier read reported); default: the end of the file
# Prints items.jq's items (one JSON object per line), then
#   {"k":"end","offset":<where the next forward read starts>,"head":<where this read started>}
# Transcripts are append-only. A line still being written (no newline yet) is left for next
# time; a read that starts mid-line (tail, or a range below an earlier "head") skips to the
# next line. Images in prompts (base64 in the transcript) are written once to $IMG as PNGs,
# since the mod can only draw images from files.
f=$1; from=${2:-0}
here=$(dirname "$0")
IMG="$HOME/.config/herdr-app/data/herdr-chat/img"
size=$(stat -f %z "$f" 2>/dev/null) || { echo '{"k":"end","offset":0,"head":0,"missing":true}'; exit 0; }
to=${3:-$size}
[ "$to" -gt "$size" ] && to=$size
if [ "$from" = tail ]; then from=$((to > 307200 ? to - 307200 : 0)); fi
[ "$from" -gt "$to" ] && from=0                        # replaced or truncated: start over
[ "$from" -eq "$to" ] && { echo "{\"k\":\"end\",\"offset\":$to,\"head\":$from}"; exit 0; }

tmp=$(mktemp -t herdr-chat) || exit 1
trap 'rm -f "$tmp" "$tmp.c"' EXIT
# Counted from the start (tail -c +N seeks): counting back from a size read a moment ago went
# wrong while Claude appended in between, cutting or repeating lines (review 2026-11-01).
tail -c +$((from + 1)) "$f" | head -c $((to - from)) > "$tmp"
total=$(wc -c < "$tmp" | tr -d ' ')
first=0
if [ "$from" -gt 0 ] && [ "$(tail -c +$from "$f" | head -c 1)" != "$(printf '\n')" ]; then
  first=$(head -n 1 "$tmp" | wc -c | tr -d ' ')       # started mid-line: skip to the next one
fi
partial=0
[ -n "$(tail -c 1 "$tmp")" ] && partial=$(tail -n 1 "$tmp" | wc -c | tr -d ' ')
end=$((total - partial))
head=$((from + first))
[ "$end" -gt "$first" ] || { echo "{\"k\":\"end\",\"offset\":$((from + end > head ? from + end : head)),\"head\":$head}"; exit 0; }
head -c "$end" "$tmp" | tail -c +$((first + 1)) > "$tmp.c"

if grep -q '"type":"image"' "$tmp.c"; then
  mkdir -p "$IMG"
  jq -rR 'fromjson? | select(.type == "user" and (.message.content | type) == "array") | .uuid as $u
    | .message.content | to_entries[] | select(.value.type == "image" and .value.source.type == "base64")
    | "\($u)-\(.key)\t\(.value.source.data)"' "$tmp.c" |
  while IFS="$(printf '\t')" read -r name data; do
    [ -s "$IMG/$name.png" ] || printf '%s' "$data" | base64 -D > "$IMG/$name.png" 2>/dev/null
  done
fi
jq -cR --arg img "$IMG" -f "$here/items.jq" "$tmp.c"
echo "{\"k\":\"end\",\"offset\":$((from + end)),\"head\":$head}"
