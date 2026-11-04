#!/bin/sh
# The canvases Claude Code transcripts published, for the canvases mod (canvases.jq says what
# counts). usage: scan.sh <transcript.jsonl>...  prints {"file":…,"canvases":[{url,title,file,at}]}
# per transcript. Transcripts get big (40 MB), so only the lines that can matter reach jq (perl:
# 0.08 s for 40 MB; macOS grep -E took 0.6 s), and only when the transcript changed since its
# cached answer. `scan.sh --check` tests it.
here=$(dirname "$0")
CACHE="$HOME/.config/herdr-app/data/herdr-canvases"
filter() { perl -ne 'print if /"name":"Artifact","input"|"tool_result".*claude\.ai\/(code\/)?artifact\//' "$1"; }
if [ "$1" = --check ]; then
  t=$(mktemp -t canvases) || exit 1
  cat > "$t" <<'JSONL'
{"type":"assistant","timestamp":"2026-11-01T10:00:00Z","message":{"content":[{"type":"tool_use","id":"a","name":"Artifact","input":{"type_url":"https://claude.ai/artifact/TYPE","title":"Themes"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a","content":"Created a new Artifact at https://claude.ai/artifact/NEW1 (version 1) from the Artifact type https://claude.ai/artifact/TYPE"}]}}
{"type":"assistant","timestamp":"2026-11-01T11:00:00Z","message":{"content":[{"type":"tool_use","id":"b","name":"Artifact","input":{"url":"https://claude.ai/artifact/NEW1","file_path":"/x/a.html"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b","content":[{"type":"text","text":"Updated the Artifact at https://claude.ai/artifact/NEW1"}]}]}}
{"type":"assistant","timestamp":"2026-11-01T10:30:00Z","message":{"content":[{"type":"tool_use","id":"c","name":"Artifact","input":{"file_path":"/x/report.html"}},{"type":"tool_use","id":"d","name":"Artifact","input":{"action":"read","url":"https://claude.ai/artifact/READ"}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c","content":"Published https://claude.ai/code/artifact/0f0e-11 (private)"},{"type":"tool_result","tool_use_id":"d","content":"https://claude.ai/artifact/READ"}]}}
JSONL
  got=$(filter "$t" | jq -nRc -f "$here/canvases.jq" | jq -c 'map([.url, .title, .file])')
  rm -f "$t"
  want='[["https://claude.ai/artifact/NEW1","Themes","/x/a.html"],["https://claude.ai/code/artifact/0f0e-11",null,"/x/report.html"]]'
  [ "$got" = "$want" ] && echo "scan ok" || { echo "scan FAILED: $got"; exit 1; }
  exit 0
fi
mkdir -p "$CACHE"
for f in "$@"; do
  c="$CACHE/$(md5 -q -s "$f").json"
  if [ ! -s "$c" ] || [ "$f" -nt "$c" ]; then
    { filter "$f" 2>/dev/null | jq -nRc -f "$here/canvases.jq" | jq -c --arg file "$f" '{file: $file, canvases: .}'; } > "$c.tmp" && mv "$c.tmp" "$c"
  fi
  cat "$c"
done
