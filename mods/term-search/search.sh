#!/bin/sh
# Search backend for the term-search mod (after ~/Desktop/herdr-find-tab).
# usage: search.sh <query> <terminal>...
# Claude Code terminals are searched in their whole transcript (~/.claude/projects/*/<session>.jsonl,
# found from each claude process's HC_TERMINAL_ID and ~/.claude/sessions/<pid>.json); the
# rest in their screen and last 2000 lines. Matching runs in grep/awk, not in Herdr's JS.
# Prints, tab-separated:
#   <terminal> first 0 0 <first typed prompt>
#   <terminal> <role> <rank> <lines up|-1> <text>    role: you (1) | claude (2) | tool, term (3)
# Up to 40 hits per terminal, best first. The query must be 3+ characters to search content.
q=$1; shift
here=$(dirname "$0")
cache="$HOME/.config/herdr-app/data/term-search"
mkdir -p "$cache"
tab=$(printf '\t')

map=$(for p in $(pgrep -x claude); do
  t=$(ps -E -p "$p" -o command= 2>/dev/null | grep -oE 'HC_TERMINAL_ID=[^ ]+' | head -1 | cut -d= -f2)
  s="$HOME/.claude/sessions/$p.json"
  [ -n "$t" ] && [ -r "$s" ] && printf '%s\t%s\n' "$t" "$(jq -r '.sessionId // empty' "$s")"
done)

for t in "$@"; do
  sid=$(printf '%s\n' "$map" | awk -F'\t' -v t="$t" '$1 == t { print $2; exit }')
  f=""
  [ -n "$sid" ] && f=$(ls "$HOME"/.claude/projects/*/"$sid".jsonl 2>/dev/null | head -1)
  if [ -n "$f" ]; then
    m="$cache/$sid.msgs"
    [ "$m" -nt "$f" ] || jq -r -f "$here/msgs.jq" "$f" 2>/dev/null | sed -E 's/\\[nrt]/ /g; s/  +/ /g' > "$m"
  else
    m="$cache/$(printf '%s' "$t" | tr '/' '_').term"
    hc read "$t" --lines 2000 2>/dev/null | tr '\t' ' ' | awk 'NF { print "term\t" $0 }' > "$m"
  fi
  first=$(awk -F'\t' '$1 == "you" { print substr($2, 1, 300); exit }' "$m")
  [ -n "$first" ] && printf '%s\tfirst\t0\t0\t%s\n' "$t" "$first"
  [ ${#q} -ge 3 ] || continue
  total=$(wc -l < "$m")
  grep -F -i -- "$q" "$m" | Q=$(printf '%s' "$q" | tr '[:upper:]' '[:lower:]') awk -F'\t' -v t="$t" -v n="$total" '
    BEGIN { r["you"] = 1; r["claude"] = 2; r["tool"] = 3; r["term"] = 3 }
    index(tolower($2), ENVIRON["Q"]) { print t "\t" $1 "\t" r[$1] "\t" ($1 == "term" ? n - NR : -1) "\t" substr($2, 1, 400) }' \
    | sort -t "$tab" -k3,3n -s | head -n 40
done
