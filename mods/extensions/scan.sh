# Lists Claude Code skills and subagents for the extensions mod, one per line:
#   kind \t source \t name \t description \t path \t on|off
# $1: folder for disabled agents. Then pairs of <plugin name> <plugin install path>.
# Frontmatter: the `name:` and first line of `description:` between the first two `---`.
front() {
  awk 'NR==1 && $0!="---" {exit} NR>1 && $0=="---" {exit}
       /^name:/ {sub(/^name:[ \t]*/, ""); gsub(/["\047]/, ""); n=$0}
       /^description:/ {sub(/^description:[ \t]*[>|]?-?[ \t]*/, ""); d=$0; grab=(d=="")}
       grab && !/^description:/ && /^[ \t]+/ {sub(/^[ \t]+/, ""); d=$0; grab=0}
       END {gsub(/\t/, " ", d); printf "%s\t%s", n, substr(d, 1, 300)}' "$1"
}
row() { # kind source fallback-name file state
  nd=$(front "$4"); n=${nd%%"	"*}; d=${nd#*"	"}; [ -n "$n" ] || n=$3
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$n" "$d" "$4" "$5"
}
off=$1; shift
for f in "$HOME"/.claude/skills/*/SKILL.md; do [ -f "$f" ] && row skill user "$(basename "$(dirname "$f")")" "$f" on; done
for f in "$HOME"/.claude/agents/*.md; do [ -f "$f" ] && row agent user "$(basename "$f" .md)" "$f" on; done
for f in "$off"/*.md; do [ -f "$f" ] && row agent user "$(basename "$f" .md)" "$f" off; done
while [ $# -ge 2 ]; do
  p=$1; dir=$2; shift 2
  for f in "$dir"/skills/*/SKILL.md; do [ -f "$f" ] && row skill "$p" "$(basename "$(dirname "$f")")" "$f" on; done
  for f in "$dir"/agents/*.md; do [ -f "$f" ] && row agent "$p" "$(basename "$f" .md)" "$f" on; done
done
