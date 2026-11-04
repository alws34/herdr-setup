# Claude Code transcript (.jsonl) -> one message per line: "<role>\t<text>".
# role is you (typed prompt), claude (reply text), or tool (tool output).
# Skips meta entries and injected text (slash commands, system reminders),
# which start with "<".
# @tsv writes newlines and tabs inside text as \n and \t. The caller turns
# them into spaces with sed, which is much faster than gsub in jq.

if .type == "user" and (.isMeta | not) then
  .message.content
  | if type == "string" then select(startswith("<") | not) | ["you", .]
    else .[]
      | if .type == "text" then .text | select(startswith("<") | not) | ["you", .]
        elif .type == "tool_result" then
          ["tool", (.content | if type == "string" then .
                               elif type == "array" then map(.text // "") | join(" ")
                               else "" end)]
        else empty end
    end
elif .type == "assistant" then
  .message.content[]? | select(.type == "text") | ["claude", .text]
else empty end
| select(.[1] != "")
| @tsv
