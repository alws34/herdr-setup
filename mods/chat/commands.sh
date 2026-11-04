#!/bin/sh
# The slash commands a Claude Code session offers, for the chat's "/" menu: skills and commands
# of the user (~/.claude), of the project (<cwd>/.claude) and of enabled plugins (as plugin:name,
# the way Claude Code lists them). Built-ins are in main.js. One "name<TAB>description" per line.
# usage: commands.sh <session cwd>
cwd=$1

# name<TAB>description from a skill/command file's frontmatter; nothing if user-invocable: false.
meta() { # file default-name prefix
  awk -v def="$2" -v pre="$3" '
    NR == 1 && $0 != "---" { exit }
    NR > 1 && $0 == "---" { done = 1; exit }
    /^[a-zA-Z-]+:/ { key = $1; sub(/:$/, "", key); val = $0; sub(/^[^:]*:[ \t]*/, "", val); f[key] = val; last = key; next }
    /^[ \t]+/ && last == "description" { v = $0; sub(/^[ \t]+/, "", v); f["description"] = f["description"] " " v }
    END {
      if (f["user-invocable"] == "false") exit
      n = f["name"] != "" ? f["name"] : def; d = f["description"]
      gsub(/^["'\'']|["'\'']$/, "", n); sub(/^[|>]-?[ ]*/, "", d); gsub(/^["'\'' ]+|["'\'' ]+$/, "", d); gsub(/\t/, " ", d)
      print pre n "\t" d
    }' "$1"
}

each() { # base-dir prefix
  for f in "$1"/commands/*.md; do [ -f "$f" ] && meta "$f" "$(basename "$f" .md)" "$2"; done
  for f in "$1"/skills/*/SKILL.md; do [ -f "$f" ] && meta "$f" "$(basename "$(dirname "$f")")" "$2"; done
}

each "$HOME/.claude" ""
[ -n "$cwd" ] && [ "$cwd" != "$HOME" ] && each "$cwd/.claude" ""
# Enabled plugins only: settings.json's enabledPlugins, installed_plugins.json's paths.
jq -r --slurpfile s "$HOME/.claude/settings.json" '
  .plugins | to_entries[] | select(($s[0].enabledPlugins // {})[.key] == true)
  | "\(.key | split("@")[0])\t\(.value[0].installPath)"' "$HOME/.claude/plugins/installed_plugins.json" 2>/dev/null |
while IFS="$(printf '\t')" read -r name path; do each "$path" "$name:"; done
