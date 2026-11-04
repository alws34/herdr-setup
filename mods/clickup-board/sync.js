// ClickUp's REST API v2 with your personal token (forked from nu0ma/herdr-linear-board, which went
// through the Linear MCP with `claude -p`): every read and write the board and its task panel make, so
// nothing needs the browser and no call costs a model run.
// No Herdr imports, so `node --test` can load this file.

export const NO_PROJECT = "No list";
const API = "https://api.clickup.com/api/v2";
const MAX_PAGES = 10; // 100 tasks a page
// ponytail: closed tasks are one page (the 100 most recently updated); page through them if that's short.
const CLOSED_PAGES = 1;

async function call(token, method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: body ? { Authorization: token, "Content-Type": "application/json" } : { Authorization: token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (r.status === 401) throw new Error("ClickUp rejected the token: check ~/.config/herdr-app/clickup-board.json");
  if (r.status < 200 || r.status >= 300) throw new Error(`ClickUp ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
const get = (token, path) => call(token, "GET", path);

const isClosed = (type) => type === "done" || type === "closed";
// ClickUp's status types → the board's kinds.
const KIND = { open: "unstarted", custom: "started", done: "done", closed: "done" };

const person = (u) => ({ id: u.id, username: u.username ?? u.email ?? "?", initials: u.initials ?? (u.username ?? "?").slice(0, 2).toUpperCase(), color: u.color || "#7b68ee" });

// `CU-<id>` is ClickUp's own git convention, so branches and tabs named after it link back.
export function toIssue(t, workspace = "") {
  const id = t.custom_id || `CU-${t.id}`;
  return {
    id: t.id, identifier: id.toUpperCase(), title: t.name, url: t.url, priority: Number(t.priority?.id) || 0,
    team: (t.list?.name ?? "").toUpperCase(), workspace, project: t.list?.name ?? NO_PROJECT, parentId: t.parent ?? null,
    state: t.status?.status ?? "", stateType: /review/i.test(t.status?.status ?? "") ? "review" : KIND[t.status?.type] ?? "started",
    statusColor: t.status?.color || "#87909e", closed: isClosed(t.status?.type),
    listId: t.list?.id ?? null, assignees: (t.assignees ?? []).map(person),
    dueDate: t.due_date ? Number(t.due_date) : null,
    labels: (t.tags ?? []).map((tag) => ({ name: tag.name, color: tag.tag_bg || "#7b68ee" })),
  };
}

// Parents by title, for the "Parent › task" line on cards.
function withParents(issues) {
  const byId = new Map(issues.map((i) => [i.id, i]));
  return issues.map((i) => ({ ...i, parent: i.parentId ? { identifier: byId.get(i.parentId)?.identifier ?? `CU-${i.parentId}`.toUpperCase(), title: byId.get(i.parentId)?.title ?? null } : null }));
}

async function pages(token, path, max) {
  const tasks = [];
  for (let page = 0; page < max; page++) {
    const d = await get(token, `${path}&page=${page}`);
    tasks.push(...(d.tasks ?? []));
    if (d.last_page !== false || !(d.tasks ?? []).length) break;
  }
  return tasks;
}

// Open tasks assigned to you across every workspace, subtasks included.
export async function fetchMine(token) {
  const { user } = await get(token, "/user");
  const { teams } = await get(token, "/team");
  const issues = [];
  for (const team of teams ?? []) {
    for (const t of await pages(token, `/team/${team.id}/task?assignees[]=${user.id}&subtasks=true&include_closed=false`, MAX_PAGES)) {
      if (!isClosed(t.status?.type)) issues.push(toIssue(t, team.name));
    }
  }
  return { name: "My tasks", statuses: null, issues: withParents(issues) };
}

// Workspaces › spaces › folders › lists, for the sidebar.
export async function fetchTree(token) {
  const { teams } = await get(token, "/team");
  const tree = [];
  for (const team of teams ?? []) {
    const { spaces } = await get(token, `/team/${team.id}/space?archived=false`);
    const out = await Promise.all((spaces ?? []).map(async (s) => {
      const [{ folders }, { lists }] = await Promise.all([get(token, `/space/${s.id}/folder?archived=false`), get(token, `/space/${s.id}/list?archived=false`)]);
      const list = (l) => ({ id: l.id, name: l.name });
      return {
        id: s.id, name: s.name, color: s.color || null,
        folders: (folders ?? []).map((f) => ({ id: f.id, name: f.name, lists: (f.lists ?? []).map(list) })),
        lists: (lists ?? []).map(list),
      };
    }));
    tree.push({ id: team.id, name: team.name, spaces: out });
  }
  return tree;
}

// A list's statuses, in its own order.
export async function fetchListInfo(token, listId) {
  const l = await get(token, `/list/${listId}`);
  return { name: l.name, statuses: (l.statuses ?? []).map((s) => ({ name: s.status, type: s.type, color: s.color || "#87909e" })) };
}

// Every open top-level task in a list, plus the most recently updated closed ones.
export async function fetchList(token, listId) {
  const info = await fetchListInfo(token, listId);
  const closed = info.statuses.filter((s) => isClosed(s.type)).map((s) => `statuses[]=${encodeURIComponent(s.name)}`).join("&");
  const [open, done] = await Promise.all([
    pages(token, `/list/${listId}/task?include_closed=false`, MAX_PAGES),
    closed ? pages(token, `/list/${listId}/task?include_closed=true&order_by=updated&${closed}`, CLOSED_PAGES) : [],
  ]);
  const seen = new Set(), issues = [];
  for (const t of [...open, ...done]) if (!seen.has(t.id)) { seen.add(t.id); issues.push(toIssue(t)); }
  return { name: info.name, statuses: info.statuses, issues: withParents(issues) };
}

export async function fetchMembers(token, listId) {
  const { members } = await get(token, `/list/${listId}/member`);
  return (members ?? []).map(person);
}

export async function fetchTask(token, taskId) {
  const t = await get(token, `/task/${taskId}?include_markdown_description=true&include_subtasks=true`);
  return { issue: toIssue(t), markdown: t.markdown_description ?? t.text_content ?? "", subtasks: (t.subtasks ?? []).map((s) => toIssue(s)) };
}

export async function fetchComments(token, taskId) {
  const { comments } = await get(token, `/task/${taskId}/comment`);
  // ClickUp answers newest first; a thread reads oldest first.
  return (comments ?? []).map((c) => ({ id: c.id, text: c.comment_text ?? "", user: person(c.user ?? {}), date: Number(c.date) })).reverse();
}

// `fields`: name, markdown_content, status, priority (1-4 or null), due_date (ms or null),
// assignees: { add: [ids], rem: [ids] }.
export async function updateTask(token, taskId, fields) {
  return toIssue(await call(token, "PUT", `/task/${taskId}`, fields));
}

export async function createTask(token, listId, fields) {
  return toIssue(await call(token, "POST", `/list/${listId}/task`, fields));
}

export async function addComment(token, taskId, text) {
  await call(token, "POST", `/task/${taskId}/comment`, { comment_text: text, notify_all: false });
}

// `~/.config/herdr-app/clickup-board.json`:
//   { "token": "pk_…", "repos": { "<LIST NAME>": "~/dev/repo" } }
export function parseConfig(text, home) {
  let raw = {};
  try { raw = JSON.parse(text ?? "{}") ?? {}; } catch { raw = {}; }
  const repos = {};
  for (const [list, folder] of Object.entries(raw.repos ?? {})) {
    if (typeof folder === "string" && folder.trim()) repos[list.toUpperCase()] = folder.trim().replace(/^~\//, `${home}/`);
  }
  return { token: typeof raw.token === "string" ? raw.token.trim() : "", repos };
}
