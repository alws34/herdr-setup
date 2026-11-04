// Pure helpers for the ClickUp board: its columns, filter and dates.
// No Herdr imports, so `node --test` can load this file (board.test.js).

import { NO_PROJECT } from "./sync.js";

// "My tasks" mixes lists with different statuses, so its columns go by kind.
const KIND_ORDER = ["triage", "backlog", "unstarted", "started", "review", "done"];

// Sorts in place by precomputed keys, stable. Not `.sort(compare)`: a compare callback runs hundreds
// of times per render, and until the JIT has compiled it each call stalls the window.
function sortByKeys(items, keys) {
  for (let i = 1; i < items.length; i++) {
    const item = items[i], key = keys[i];
    let j = i - 1;
    for (; j >= 0 && keys[j] > key; j--) { items[j + 1] = items[j]; keys[j + 1] = keys[j]; }
    items[j + 1] = item; keys[j + 1] = key;
  }
  return items;
}

// A list's board: one column per status in the list's own order, empty ones included, as ClickUp
// draws it. Without `statuses` ("My tasks"): one column per status that has tasks, by kind.
// Cards go most urgent first; no priority (0) goes last.
export function boardColumns(issues, statuses = null) {
  const columns = new Map();
  for (const s of statuses ?? []) {
    columns.set(s.name.toLowerCase(), { name: s.name, color: s.color, closed: s.type === "closed" || s.type === "done", kind: null, issues: [] });
  }
  for (const issue of issues) {
    const key = issue.state.toLowerCase();
    if (!columns.has(key)) columns.set(key, { name: issue.state, color: issue.statusColor, closed: issue.closed, kind: issue.stateType, issues: [] });
    columns.get(key).issues.push(issue);
  }
  const list = [...columns.values()], order = [];
  for (const column of list) {
    const ranks = [];
    for (const issue of column.issues) ranks.push(issue.priority || 5);
    sortByKeys(column.issues, ranks);
    order.push(KIND_ORDER.indexOf(column.kind));
  }
  return statuses ? list : sortByKeys(list, order);
}

// The projects your issues are in, biggest first; issues without one come last.
export function projectsOf(issues) {
  const counts = new Map();
  for (const { project } of issues) counts.set(project, (counts.get(project) ?? 0) + 1);
  const projects = [], order = [];
  for (const [name, count] of counts) {
    projects.push({ name, count });
    order.push(name === NO_PROJECT ? Infinity : -count);
  }
  return sortByKeys(projects, order);
}

// Shares the limit out one card at a time across the columns, so no column starves.
export function limitCards(columns, limit) {
  const counts = [];
  let left = limit, total = 0;
  for (const column of columns) { counts.push(0); total += column.issues.length; }
  if (left > total) left = total;
  while (left > 0) {
    for (let i = 0; i < columns.length && left > 0; i++) {
      if (counts[i] < columns[i].issues.length) { counts[i]++; left--; }
    }
  }
  const limited = [];
  for (let i = 0; i < columns.length; i++) limited.push({ ...columns[i], shown: columns[i].issues.slice(0, counts[i]) });
  return limited;
}

const ISSUE_ID = /\b[A-Z][A-Z0-9]*-[A-Z0-9]*\d[A-Z0-9]*\b/g; // ENG-123 and ClickUp's CU-86abc12
const AGENT_RANK = { blocked: 3, working: 2, done: 1, idle: 0 };

// The agent on each issue, the most urgent if there are several: the Agent dialog names its tab after
// the issue, and a branch or space can carry the id too. `branches` maps a pane to its git branch.
export function issueAgents(agents, branches) {
  const found = new Map();
  for (const agent of agents) {
    const ids = `${agent.tab_name} ${agent.space_name} ${branches.get(agent.pane) ?? ""}`.toUpperCase().match(ISSUE_ID) ?? [];
    for (const id of ids) {
      const held = found.get(id);
      if (!held || AGENT_RANK[agent.status] > AGENT_RANK[held.status]) found.set(id, agent);
    }
  }
  return found;
}

export function filterIssues(issues, text, project = null) {
  const needle = (text ?? "").trim().toLowerCase();
  if (!project && !needle) return issues;
  const found = [];
  for (const i of issues) {
    if ((!project || i.project === project) && (!needle || `${i.identifier} ${i.title}`.toLowerCase().includes(needle))) found.push(i);
  }
  return found;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthName = (month) => MONTHS[month - 1];
export function shortDate(iso) {
  const date = new Date(iso);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

export function ago(time, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - new Date(time).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

const pad = (n) => String(n).padStart(2, "0");
// Due dates as the calendar's "YYYY-MM-DD", in local time.
export function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// Local noon, so the day reads the same for teammates up to 11 hours away.
export function dayToMs(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

// "Today", "Tomorrow", "Yesterday" or "Nov 3"; overdue when the day has passed and the task is open.
export function dueLabel(ms, closed = false, now = Date.now()) {
  const days = Math.round((dayToMs(dayOf(ms)) - dayToMs(dayOf(now))) / 86400000);
  const text = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : shortDate(ms);
  return { text, overdue: days < 0 && !closed };
}
