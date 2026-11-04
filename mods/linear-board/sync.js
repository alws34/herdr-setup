// The Linear MCP sync: the prompt for `claude -p`, its stream parsed into issues, and the config.
// No Herdr imports, so `node --test` can load this file.

// Headless `claude -p` has the claude.ai connector; a session may have the plugin instead.
export const SYNC_TOOLS = ["mcp__claude_ai_Linear__list_issues", "mcp__plugin_linear_linear__list_issues"];
const SYNC_STATES = ["triage", "backlog", "unstarted", "started"];
const FIELDS = ["id", "title", "url", "priority", "createdAt", "status", "statusType", "labels", "team", "project", "parentId", "gitBranchName"];

export const SYNC_PROMPT = `Call ${SYNC_TOOLS[0]} four times in parallel, each with assignee "me", limit 100, fields ${JSON.stringify(FIELDS)}, and state set to ${SYNC_STATES.map((s) => `"${s}"`).join(", ")} respectively. Do nothing else, then reply ok.`;

export const NO_PROJECT = "No project";
const LABEL_COLORS = ["#2f80ed", "#27ae60", "#f2994a", "#bb87fc", "#eb5757", "#26b5ce", "#f2c94c"];

function labelColor(name) {
  let sum = 0;
  for (const c of name) sum += c.codePointAt(0);
  return LABEL_COLORS[sum % LABEL_COLORS.length];
}

function toIssue(n) {
  return {
    id: n.id, identifier: n.id, title: n.title, url: n.url, branchName: n.gitBranchName ?? null,
    priority: n.priority?.value ?? 0, createdAt: n.createdAt,
    team: n.id.split("-")[0], project: n.project?.name ?? n.project ?? NO_PROJECT, parentId: n.parentId ?? null,
    state: n.status ?? "", stateType: n.statusType ?? "",
    labels: (n.labels ?? []).map((name) => ({ name, color: labelColor(name) })),
  };
}

// The issues in `claude -p --output-format stream-json`, read from the tool results themselves
// so nothing passes through the model. A state whose call didn't answer fails the whole sync.
export function parseSync(stream) {
  const calls = {}, results = {};
  for (const line of stream.split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    for (const c of event.message?.content ?? []) {
      if (c.type === "tool_use" && SYNC_TOOLS.includes(c.name)) calls[c.id] = c.input?.state;
      if (c.type !== "tool_result" || !(c.tool_use_id in calls)) continue;
      const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((part) => part.text ?? "").join("");
      try { results[calls[c.tool_use_id]] = JSON.parse(text).issues; } catch { /* a failed call, retried or reported below */ }
    }
  }
  const missing = SYNC_STATES.filter((state) => !results[state]);
  if (missing.length) throw new Error(`Linear MCP gave no answer for: ${missing.join(", ")}`);
  const issues = SYNC_STATES.flatMap((state) => results[state]).map(toIssue);
  const byId = new Map(issues.map((i) => [i.identifier, i]));
  return issues.map((i) => ({ ...i, parent: i.parentId ? { identifier: i.parentId, title: byId.get(i.parentId)?.title ?? null } : null }));
}

// The file a sync leaves: its start time, the stream, its exit code. Throws if it failed.
export function parseSyncResult(text) {
  const lines = text.split("\n").filter(Boolean);
  const { startedAt } = JSON.parse(lines[0]), { exit } = JSON.parse(lines.at(-1));
  if (exit !== 0) throw new Error(lines.at(-2) || "claude -p failed");
  return { at: startedAt, issues: parseSync(text) };
}

// `~/.config/herdr-app/linear-board.json`: { "repos": { "<TEAM KEY>": "~/dev/repo" } }.
export function parseRepos(text, home) {
  if (text == null) return {};
  let raw;
  try { raw = JSON.parse(text); } catch { return {}; }
  const repos = {};
  for (const [team, folder] of Object.entries(raw?.repos ?? {})) {
    if (typeof folder === "string" && folder.trim()) repos[team.toUpperCase()] = folder.trim().replace(/^~\//, `${home}/`);
  }
  return repos;
}
