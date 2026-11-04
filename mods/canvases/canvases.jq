# The canvases (claude.ai artifacts) one Claude Code transcript published, for scan.sh.
# Input: transcript lines (raw). A canvas is what an Artifact publish (no action or "publish",
# not an asset upload) made: its `url` input, else the first artifact link in its result (a
# create's new artifact comes first there). Same url: one entry, its newest publish's time and
# title, else an older title. Newest first.
def link: [match("https://claude\\.ai/(code/)?artifact/[A-Za-z0-9-]+").string][0];
[inputs | fromjson? | select(.message.content | type == "array")] as $lines
| ([$lines[] | select(.type == "assistant") | .timestamp as $at | .message.content[]
    | select(.type == "tool_use" and .name == "Artifact" and ((.input.action // "publish") == "publish") and (.input.asset | not))
    | {key: .id, value: {at: $at, url: .input.url, title: .input.title, file: .input.file_path}}] | from_entries) as $pubs
| [$lines[] | select(.type == "user") | .message.content[]
    | select(.type == "tool_result" and $pubs[.tool_use_id] != null and (.is_error | not))
    | (.content | if type == "string" then . else map(.text? // "") | join(" ") end) as $text
    | $pubs[.tool_use_id] | .url = (.url // ($text | link))
    | select(.url != null and ($text | test("claude\\.ai/(code/)?artifact/")))]
| group_by(.url)
| map({url: .[0].url, at: (map(.at) | max), title: ([.[].title // empty] | last), file: ([.[].file // empty] | last)})
| sort_by(.at) | reverse
