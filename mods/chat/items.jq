# Claude Code transcript line (.jsonl, read with -R) -> the chat mod's items, one compact
# JSON object per line. Run by read.sh. Kinds:
#   user  {id, text, imgs}      a typed prompt (also one queued while Claude worked)
#   text  {id, text, before?, at?, think?}  Claude's reply text (markdown); `before`: the tool call it
#                               precedes; `at`: when it was written (ms), for "5 min ago";
#                               `think`: a thinking update (drawn as interim text)
#   tool  {id, name, in}        a tool call; `in` keeps only the fields the chat shows
#   res   {id, out, err, add, del}  its result (output cut to 1500 chars; +/- lines for edits)
#   note  {id, text}            "Interrupted", "Conversation compacted"
#   model {name, id}  mode {mode}  ctx {used}   facts for the meta line under the composer
#   bg    {}                    the session is a background job (its in-between replies aren't saved)
# Thinking, sidechains (sub-agents), meta entries and injected text (slash-command wrappers,
# system reminders, task notifications: anything starting with "<") are left out.

# Claude Code saves a big paste wrapped in <pasted_content id="…"> … </pasted_content id="…">: the
# tags showed in the bubble, and a message starting with one was dropped as markup (2026-11-02).
def unpaste: if type == "string" then gsub("</?pasted_content[^>]*>"; "") | sub("^\\s+"; "") | sub("\\s+$"; "") else . end;
def prose: unpaste | select(type == "string" and (startswith("<") | not) and . != "");
def cut($n): if length > $n then .[0:$n] + "…" else . end;
def shown_input:
  with_entries(select(.key | IN("command", "description", "file_path", "path", "pattern",
    "url", "query", "prompt", "subagent_type", "skill", "notebook_path", "todos")))
  # The command is shown whole when a tool row is opened; other fields are only summarized.
  | with_entries((.key == "command") as $long | if (.value | type) == "string" then .value |= cut(if $long then 4000 else 400 end) else . end);
def text_of: if type == "string" then . elif type == "array" then map(.text // "") | join("\n") else "" end;
def user_item($id; $text; $imgs):
  if ($text | startswith("[Request interrupted")) then {k: "note", id: $id, text: "Interrupted"}
  else {k: "user", id: $id, text: $text, imgs: $imgs} end;

fromjson? | select(.isSidechain | not) |
if .type == "user" and (.isMeta | not) and (.isCompactSummary | not) then
  .uuid as $u
  | (if .permissionMode then {k: "mode", mode: .permissionMode} else empty end),
    (.message.content as $c
     | if ($c | type) == "string" then ($c | prose | user_item($u; .; []))
       else
         ([$c[] | select(.type == "text") | .text | prose] | join("\n\n")) as $t
         | ([$c | to_entries[] | select(.value.type == "image") | "\($img)/\($u)-\(.key).png"]) as $imgs
         | (if $t != "" or ($imgs | length) > 0 then user_item($u; $t; $imgs) else empty end),
           ([.toolUseResult | objects | .structuredPatch[]?.lines[]?] as $p
            | ($c[] | select(.type == "tool_result")
               | {k: "res", id: .tool_use_id, out: (.content | text_of | cut(1500)), err: (.is_error == true),
                  add: ($p | map(select(startswith("+"))) | length),
                  del: ($p | map(select(startswith("-"))) | length)}))
       end)
elif .type == "assistant" then
  .uuid as $u | ((.timestamp // "" | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601? // null) * 1000) as $at | (.thinkingDisplay == "updates") as $updates
  # A background job session ("bg") doesn't save the replies written between tool calls.
  | (if .sessionKind == "bg" then {k: "bg"} else empty end),
    (.message.content[]?
     | if .type == "text" then (.text | select(. != "") | {k: "text", id: $u, text: ., at: $at})
       # thinkingDisplay "updates" (Claude Code 2.1.3xx): the short updates between tool calls are
       # saved as thinking blocks; the terminal shows them as replies, so the chat does too.
       elif .type == "thinking" and $updates then (.thinking // "" | select(. != "") | {k: "text", id: $u, text: ., at: $at, think: true})
       elif .type == "tool_use" then {k: "tool", id: .id, name: .name, in: (.input | objects | shown_input)}
       else empty end),
    (.message.usage | objects
     | {k: "ctx", used: ((.input_tokens // 0) + (.cache_read_input_tokens // 0) + (.cache_creation_input_tokens // 0))})
elif .type == "api-request-blob" and .message.role == "assistant" then
  # This Claude Code version keeps the reply text written between tool calls only here (the
  # assistant entries hold just thinking and tool_use), a few seconds after the tool call. Each
  # text goes before the first tool call after it; a trailing text (the final reply) is skipped:
  # that one is a normal assistant entry (2026-11-01).
  (.message.content // []) as $c
  | range(0; $c | length) as $i
  | select($c[$i].type == "text" and (($c[$i].text // "") != ""))
  | ([$c[$i + 1:][] | select(.type == "tool_use") | .id] | first) as $tool
  | select($tool != null)
  | {k: "text", id: "blob:\($tool)", text: $c[$i].text, before: $tool}
elif .type == "attachment" and .attachment.type == "queued_command" then
  .uuid as $u | .attachment.prompt | prose | user_item($u; .; [])
elif .type == "attachment" and .attachment.type == "model" then
  {k: "model", name: .attachment.identity.marketingName, id: .attachment.identity.modelId}
elif .type == "system" and .subtype == "compact_boundary" then
  # rule: drawn as a divider, like the desktop app; saved: context tokens freed (older Claude Codes
  # wrote no postTokens).
  {k: "note", id: .uuid, text: "Conversation compacted", rule: true,
   saved: (.compactMetadata | if .preTokens and .postTokens then .preTokens - .postTokens else null end)}
else empty end
