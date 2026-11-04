// Chat: a Claude Code session drawn like the Claude desktop app's chat, over the real session.
// It lives in the vscode layout's `work` stack (child "chat"); session-files flips each tab
// between Chat and Terminal (shared "chat.view") and defaults Claude tabs to Chat.
//
// Why it works the way it does:
// - Reading: the tab's Claude pane -> its process (terminals()[i].foreground.pid) ->
//   ~/.claude/sessions/<pid>.json and the terminal's title -> the transcript (find.sh: the
//   sessions file alone can name a stale session). Transcripts are append-only,
//   so read.sh hands over only the bytes after the last offset, as compact items (items.jq).
//   It's polled only while the chat is shown (faster while Claude works).
// - Long transcripts: only the newest 40 rows are built ("Show earlier" adds more), hung from
//   the bottom of a clipped box the wheel moves (see render): no gpui scroll area opens at the bottom.
// - Writing: `hc send` pastes the text into the real terminal and presses Enter. Images are
//   saved as files and sent as `@/abs/path.png` lines *before* the text: Claude Code then
//   attaches them as images (verified). Put last, the @-completion menu eats the Enter.
// - Questions: when the agent is blocked, the terminal's screen (`hc read`) is parsed for the
//   prompt and its options; a button presses the option's number (or arrows + Enter).
import { View, div, image } from "gpui-kit";
import { h_flex, v_flex, TextView, TextareaState, Textarea, EditorState, Editor } from "gpui-base";
import { spaces, panes, agents, terminals, exec, hc, readTextFile, writeTextFile, home, appHome, theme, shared, setShared, layout, run, notify, settings, window } from "herdr";

const VIEW = "chat.view";                       // { [tabId]: "chat" | "terminal" } (session-files reads it)
const READER = `${appHome()}/mods/chat/read.sh`;
const FINDER = `${appHome()}/mods/chat/find.sh`;
const COMMANDS = `${appHome()}/mods/chat/commands.sh`;
// $3 if it exists, else the newest file under $1 whose path ends in /$2 (big folders skipped).
const FIND_FILE = '[ -e "$3" ] && { echo "$3"; exit; }; find "$1" -maxdepth 8 \\( -name .git -o -name node_modules -o -name .venv -o -name __pycache__ \\) -prune -o -type f -path "*/$2" -print 2>/dev/null | head -200 | tr "\\n" "\\0" | xargs -0 ls -t 2>/dev/null | head -1';
// Inside the app folder (a real folder, not a symlink): image() only draws files under it.
const STATE = `${appHome()}/data/herdr-chat`;
const COLUMN = 720;                              // the desktop app's reading width
// Images sent before 2026-11-01 15:50 name the old folder (~/.local/state/herdr-chat, now a link here).
const OLD_STATE = `${home()}/.local/state/herdr-chat`;
const imgSrc = (p) => (p.startsWith(STATE) ? `data/herdr-chat${p.slice(STATE.length)}`
  : p.startsWith(OLD_STATE) ? `data/herdr-chat${p.slice(OLD_STATE.length)}` : p);
const MODELS = [
  { label: "Opus 5.5 (1M)", arg: "opus[1m]" }, { label: "Opus 5.5", arg: "opus" },
  { label: "Sonnet 5.5", arg: "sonnet" }, { label: "Haiku 5.5", arg: "haiku" }, { label: "Fable 5.1", arg: "claude-fable-5-1" },
];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// Permission modes in Claude Code's shift+tab order, and how its footer names each.
const MODES = [
  { id: "bypassPermissions", label: "Bypass permissions", screen: "bypass permissions on" },
  { id: "auto", label: "Auto mode", screen: "auto mode on" },
  { id: "default", label: "Ask permissions", screen: "manual mode on" },
  { id: "acceptEdits", label: "Accept edits", screen: "accept edits on" },
  { id: "plan", label: "Plan mode", screen: "plan mode on" },
];
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const AT_IMAGE = /(^|\s)@(\/\S+\.(?:png|jpe?g|gif|webp))(?=\s|$)/gi;

// Parsed conversations by tab, outliving this copy of the mod (tab switches, reloads).
const SESSIONS = (globalThis.__herdrChatSessionsV7 ??= {});
const ROWS = 40;                                 // rows built at first; "Show earlier" adds 50

// Runs read.sh: { items, end } (end: {offset, head, missing?}).
async function readItems(file, from, to) {
  const r = await exec("sh", [READER, file, from, ...(to ? [to] : [])]);
  const items = [];
  let end = {};
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    try {
      const item = JSON.parse(line);
      if (item.k === "end") end = item;
      else items.push(item);
    } catch (_) { /* a cut line: read again next time */ }
  }
  return { items, end };
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const shownTab = () => spaces().find((s) => s.active)?.tabs.find((x) => x.active) ?? null;
const isClaude = (p) => p.terminal && (p.program?.key === "claude" || p.app === "claude-code");
// The tab's Claude pane: the focused one if it's Claude, else the first.
function claudePane(tabId) {
  const here = panes().filter((p) => p.tab === tabId && isClaude(p));
  return here.find((p) => p.focused) ?? here[0] ?? null;
}
// A spinner on screen means working, whatever Herdr's status says (it can lag at "idle", or be
// missing when Herdr doesn't know the agent); a question (blocked) still wins.
function statusOf(pane, s) {
  const st = agents().find((a) => a.address === pane.terminal)?.status;
  return st === "blocked" ? "blocked" : s?.spin ? "working" : st;
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fileName = (p) => String(p ?? "").split("/").pop();
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
// Code-block languages as the editor knows them (same table as mods/editor/main.js's LANG).
const LANG = { ts: "js", tsx: "js", jsx: "js", mjs: "js", javascript: "js", typescript: "js", py: "python", sh: "bash",
  shell: "bash", zsh: "bash", console: "bash", toml: "yaml", yml: "yaml", jsonc: "json", md: "markdown", vue: "html", svelte: "html" };
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
// The "/" menu, as in the desktop app: Claude Code's own commands first, then the skills and
// commands commands.sh finds. Ones that open a dialog show it on the chat's prompt card.
const BUILTINS = [
  ["clear", "Clear the conversation and start fresh"], ["compact", "Summarize the conversation to free up context"],
  ["context", "Show what fills the context window"], ["usage", "Show plan usage and limits"],
  ["model", "Switch the model"], ["effort", "Set the reasoning effort"], ["fast", "Toggle fast mode"],
  ["init", "Write a CLAUDE.md for this project"], ["review", "Review a pull request"],
  ["security-review", "Security review of the pending changes"], ["pr-comments", "Get the comments on a GitHub pull request"],
  ["code-review", "Review the current diff for bugs"], ["simplify", "Review changed code for cleanups and apply them"],
  ["loop", "Run a prompt or command on an interval"], ["schedule", "Schedule a cloud agent to run on a cron"],
  ["memory", "Edit Claude's memory files"], ["add-dir", "Add a working directory"], ["rename", "Rename this conversation"],
  ["rewind", "Go back to an earlier point in the conversation"], ["resume", "Resume another conversation"],
  ["export", "Export the conversation"], ["todos", "Show the todo list"], ["agents", "Manage subagents"],
  ["mcp", "Manage MCP servers"], ["plugin", "Manage plugins"], ["hooks", "Manage hooks"], ["permissions", "Manage tool permissions"],
  ["config", "Open settings"], ["status", "Show version, model and account"], ["doctor", "Check the Claude Code install"],
  ["release-notes", "Show the release notes"], ["help", "Show help"],
];

// --- Right-to-left text (Hebrew, Arabic), as the VS Code Claude RTL extension does it -------------
// TextView lays out every paragraph left to right, and a Hebrew one came out right-aligned to the
// left, its wrapped lines in reverse order and cut mid-word (2026-11-02). So a reply with RTL text
// is split into blocks; a block whose first letter is RTL is drawn as words flowing right to left
// (flex row-reverse + wrap), English runs kept in their own order, list markers on the right.

// Plain text as Markdown for a selectable TextView: every markup character escaped, each line
// ended with a hard break, leading and repeated spaces and empty lines kept. (TextView's HTML
// mode dropped <br>, joining a paste's lines: 2026-11-02.)
function plainMd(text) {
  const esc = (l) => l.replace(/[\\`*_{}\[\]()#+\-.!|<>~&]/g, (c) => `\\${c}`);
  return String(text).split("\n").map((l) => esc(l).replace(/^ +| {2,}/g, (m) => "&nbsp;".repeat(m.length)) || "&nbsp;").join("\\\n");
}

function isRtl(s) { return /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(s); }

// The direction of a block: its first letter's, skipping link targets and inline code.
function startsRtl(s) {
  const m = /[֐-ࣿיִ-﷿ﹰ-﻿A-Za-zÀ-ɏ]/.exec(s.replace(/`[^`]*`|\]\([^)]*\)/g, ""));
  return Boolean(m) && isRtl(m[0]);
}

// Markdown text -> blocks { kind: p | h | li | raw, text, rtl, level?, marker?, indent? }. Tables
// and other lines that need TextView stay "raw".
function rtlBlocks(md) {
  const out = [];
  let para = [];
  const flush = () => { if (para.length) { const text = para.join(" "); out.push({ kind: "p", text, rtl: startsRtl(text) }); para = []; } };
  for (const line of md.split("\n")) {
    let m;
    if (!line.trim()) { flush(); continue; }
    if (/^\s*\|/.test(line) || /^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flush();
      const last = out[out.length - 1];
      if (last?.kind === "raw") last.text += `\n${line}`; else out.push({ kind: "raw", text: line, rtl: false });
      continue;
    }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); out.push({ kind: "h", level: m[1].length, text: m[2], rtl: startsRtl(m[2]) }); continue; }
    if ((m = /^(\s*)(\d+[.)]|[-*+])\s+(.*)$/.exec(line))) {
      flush();
      out.push({ kind: "li", indent: Math.floor(m[1].length / 2), marker: /\d/.test(m[2]) ? m[2] : "•", text: m[3], rtl: startsRtl(m[3]) });
      continue;
    }
    const last = out[out.length - 1];
    if (!para.length && last?.kind === "li" && /^\s+\S/.test(line)) { last.text += ` ${line.trim()}`; last.rtl = startsRtl(last.text); continue; }
    para.push(line.replace(/^\s*>\s?/, "").trim());
  }
  flush();
  return out;
}

// A block's text -> words, each a list of styled pieces { t, b?, i?, code?, link? }, grouped into
// runs { rtl, words }: an RTL word is a run of its own, consecutive other words (English, numbers)
// one left-to-right run. Punctuation ending such a run before RTL text belongs to the RTL side.
function rtlRuns(text) {
  const pieces = [], re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) pieces.push({ t: text.slice(last, m.index) });
    pieces.push(m[1] != null ? { t: m[1], b: true } : m[2] != null ? { t: m[2], code: true } : m[3] != null ? { t: m[3], link: m[4] } : { t: m[5], i: true });
    last = re.lastIndex;
  }
  if (last < text.length) pieces.push({ t: text.slice(last) });
  const words = [];
  let cur = [];
  const end = () => { if (cur.length) { words.push(cur); cur = []; } };
  for (const p of pieces) {
    if (p.code) { cur.push(p); continue; }
    const parts = p.t.split(/(\s+)/);
    parts.forEach((part) => {
      if (/^\s+$/.test(part)) { end(); return; }
      if (part) cur.push({ ...p, t: part });
    });
  }
  end();
  const runs = [];
  for (const w of words) {
    const rtl = isRtl(w.map((p) => p.t).join(""));
    const prev = runs[runs.length - 1];
    if (!rtl && prev && !prev.rtl) prev.words.push(w); else runs.push({ rtl, words: [w] });
  }
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.rtl) continue;
    const w = r.words[r.words.length - 1], p = w[w.length - 1], tail = /[.,;:!?]+$/.exec(p.t);
    if (tail && tail[0] !== p.t && !p.code) {
      w[w.length - 1] = { ...p, t: p.t.slice(0, -tail[0].length) };
      runs.splice(i + 1, 0, { rtl: true, words: [[{ t: tail[0] }]] });
      i++;
    }
  }
  return runs;
}

// The commands matching what follows "/": name starts with it (also after "plugin:"), then name
// contains it, then the description does. List order within each group.
function matchCommands(list, q) {
  q = q.toLowerCase();
  const groups = [[], [], []];
  for (const c of list) {
    const n = c.name.toLowerCase();
    const g = !q || n.startsWith(q) || n.slice(n.indexOf(":") + 1).startsWith(q) ? 0 : n.includes(q) ? 1 : c.desc.toLowerCase().includes(q) ? 2 : -1;
    if (g >= 0) groups[g].push(c);
  }
  return groups.flat();
}

// `path/to/file.js` and `~/x.md` in a reply become links the chat opens as file tabs, as the
// desktop app does (custom "hfile:" links, handled in on_link_click). Fenced code is split out
// before this runs, so only inline code is touched.
function linkFiles(md) {
  const span = /`((?:~\/|\/|\.{1,2}\/)?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z][\w]{0,9}(?::\d+(?:-\d+)?)?)`/g;
  return md.replace(span, (m, path) => (/^v?\d+\.\d/.test(path) ? m : `[${path}](hfile:${encodeURIComponent(path)})`));
}

// One dim line per run of tool calls: "Read 3 files, ran 2 commands", "Edited x.py +12 −3".
function toolSummary(tools) {
  if (tools.length === 1 && tools[0].name === "Bash" && tools[0].in?.description) return [{ text: tools[0].in.description }];
  const count = {}, edited = new Set();
  let add = 0, del = 0;
  for (const tool of tools) {
    const n = tool.name;
    const kind = n === "Bash" || n === "BashOutput" ? "cmd" : n === "Read" ? "read"
      : EDIT_TOOLS.includes(n) ? "edit"
      : ["Grep", "Glob", "ToolSearch"].includes(n) ? "search" : n === "WebSearch" || n === "WebFetch" ? "web"
      : n === "Task" || n === "Agent" ? "agent" : n === "TodoWrite" || /^Task(Create|Update|List|Get)$/.test(n) ? "todo" : "tool";
    count[kind] = (count[kind] ?? 0) + 1;
    if (kind === "edit") { edited.add(tool.in?.file_path ?? tool.in?.notebook_path); add += tool.res?.add ?? 0; del += tool.res?.del ?? 0; }
  }
  const parts = [];
  if (count.edit) parts.push({ text: edited.size === 1 ? `Edited ${fileName([...edited][0])}` : `Edited ${plural(edited.size, "file")}`, add, del });
  if (count.read) parts.push({ text: `Read ${plural(count.read, "file")}` });
  if (count.cmd) parts.push({ text: `Ran ${plural(count.cmd, "command")}` });
  if (count.search) parts.push({ text: `Searched ${plural(count.search, "time")}` });
  if (count.web) parts.push({ text: `Looked at the web ${plural(count.web, "time")}` });
  if (count.agent) parts.push({ text: `Ran ${plural(count.agent, "agent")}` });
  if (count.todo) parts.push({ text: "Updated the plan" });
  if (count.tool) parts.push({ text: `Used ${plural(count.tool, "tool")}` });
  return parts.map((p, i) => i ? { ...p, text: p.text[0].toLowerCase() + p.text.slice(1) } : p);
}

// Claude's task list, for the card over the composer: the task files (TaskCreate/TaskUpdate keep
// ~/.claude/tasks/<session id>/<n>.json), else the newest TodoWrite call's list (SDK sessions).
function taskList(files, tools) {
  if (files?.length) return files.filter((x) => x.subject && x.status !== "deleted")
    .sort((a, b) => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id)))
    .map((x) => ({ text: x.subject, active: x.activeForm, status: x.status }));
  const last = tools.filter((x) => x.name === "TodoWrite" && Array.isArray(x.in?.todos)).pop();
  return (last?.in.todos ?? []).map((x) => ({ text: x.content, active: x.activeForm, status: x.status }));
}

// What sits in Claude Code's text box: the lines between the last two rules at the bottom of
// the screen, without the ❯, spaces collapsed. "" when there's no box.
function boxText(screen) {
  const lines = screen.replace(/\s+$/, "").split("\n");
  const rules = lines.flatMap((l, i) => /^\s*─{8,}/.test(l) ? [i] : []);
  if (rules.length < 2) return "";
  const [a, b] = rules.slice(-2);
  return lines.slice(a + 1, b).join(" ").replace(/^\s*❯\s?/, "").replace(/\s+/g, " ").trim();
}

// Whether a sent message still sits in the box (its Enter was dropped): its first words, or the
// placeholders Claude Code puts for a long paste or an image.
function stuckIn(box, text) {
  const probe = text.trim().replace(/\s+/g, " ").slice(0, 12);
  return Boolean(box) && ((probe && box.includes(probe)) || /\[(Pasted text|Image) #|@\//.test(box));
}

// Each reply text's role, by index in items: "interim" (narration with a tool call after it in
// the same turn, or a thinking update), "final" (a turn's closing reply), or "live" (the last
// turn's closing text: drawn as interim while Claude still works, as another tool call may follow).
function textRoles(items) {
  const roles = [];
  let toolAfter = false, lastTurn = true;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.k === "user") { toolAfter = false; lastTurn = false; }
    if (it.k === "tool") toolAfter = true;
    if (it.k === "text") roles[i] = toolAfter || it.think ? "interim" : lastTurn ? "live" : "final";
  }
  return roles;
}

// What one tool call did, for the expanded view.
function toolTitle(tool) {
  const i = tool.in ?? {};
  switch (tool.name) {
    case "Bash": return `$ ${i.command ?? ""}`;
    case "Read": return `Read ${i.file_path ?? ""}`;
    case "Edit": case "Write": case "MultiEdit": return `${tool.name} ${i.file_path ?? ""}`;
    case "Grep": return `Grep "${i.pattern ?? ""}"${i.path ? ` in ${i.path}` : ""}`;
    case "Glob": return `Glob ${i.pattern ?? ""}`;
    case "WebFetch": return `Fetch ${i.url ?? ""}`;
    case "WebSearch": return `Search "${i.query ?? ""}"`;
    case "Task": case "Agent": return `Agent: ${i.description ?? i.subagent_type ?? ""}`;
    case "Skill": return `Skill ${i.skill ?? ""}`;
    default: return `${tool.name.replace(/^mcp__/, "").replace(/__/g, " · ")} ${i.description ?? i.query ?? i.file_path ?? ""}`;
  }
}

// Markdown -> prose and fenced code segments, so a code block can be its own row (with copy).
function segments(text) {
  const out = [], re = /^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm;
  let at = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > at) out.push({ md: text.slice(at, m.index) });
    out.push({ code: m[2].replace(/\n$/, ""), lang: m[1].trim() });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ md: text.slice(at) });
  return out.filter((s) => s.code !== undefined || s.md.trim());
}

// The terminal's question, from its screen: the part under the last full-width rule.
// Returns { title, body, question, options: [{ label, keys }] } or null.
export function parsePrompt(screen) {
  const lines = screen.split("\n").map((l) => l.replace(/^\s*│ ?/, "").replace(/\s*│\s*$/, "").replace(/\s+$/, ""));
  const RULE = /^\s*[─━]{20,}/;
  const move = (from, to) => [...Array(Math.abs(to - from)).fill(to > from ? "down" : "up"), "enter"];
  // Claude Code's question widget (AskUserQuestion) puts its options *above* a rule and only
  // "Chat about this" below it, so the read below the last rule saw that one option alone
  // (2026-11-01). Arrows walk every row in screen order, "Next" included; Enter toggles a
  // checkbox (multi-select) or picks and moves to the next question; "Chat about this" drops
  // the whole question so a typed message can go through.
  const chatAt = lines.findLastIndex((l) => /^\s*(❯\s*)?\d+\.\s+Chat about this\s*$/.test(l));
  if (chatAt > 0) {
    const sep = lines.slice(0, chatAt).findLastIndex((l) => RULE.test(l));
    const top = lines.slice(0, Math.max(sep, 0)).findLastIndex((l) => RULE.test(l));
    const rows = [], asked = [];
    let tabs = [];
    for (const l of lines.slice(top + 1, chatAt + 1)) {
      if (RULE.test(l)) continue;
      if (/^\s*←.*→\s*$/.test(l)) { tabs = [...l.matchAll(/([☐☒✔])\s+(.+?)(?=\s{2,}[☐☒✔→]|\s*→\s*$)/g)].map((m) => ({ label: m[2], done: m[1] !== "☐" })); continue; }
      const m = /^\s*(❯)?\s*\d+\.\s+(?:\[(.)\]\s+)?(.*\S)/.exec(l), next = /^\s*(❯)?\s*Next\s*$/.exec(l);
      if (m) rows.push({ label: m[3], checked: m[2] === undefined ? null : m[2] !== " ", cur: Boolean(m[1]), desc: "" });
      else if (next) rows.push({ label: "Next", next: true, cur: Boolean(next[1]), desc: "" });
      else if (rows.length && l.trim()) rows[rows.length - 1].desc = `${rows[rows.length - 1].desc} ${l.trim()}`.trim();
      else if (!rows.length && l.trim()) asked.push(l.trim());
    }
    const sel = Math.max(0, rows.findIndex((r) => r.cur));
    rows.forEach((r, i) => { r.keys = move(sel, i); });
    const chat = rows.find((r) => r.label === "Chat about this");
    return {
      kind: "question", title: "", body: [], question: asked.join(" "), tabs, chat: chat?.keys ?? null,
      multi: rows.some((r) => r.checked !== null),
      options: rows.filter((r) => r !== chat && !/^Type something\.?$/.test(r.label)),
    };
  }
  // The part under a rule. A named session draws its prompt box's top rule ("── name ─") under
  // the prompt too, so when nothing parses under the last rule, the one above it is tried
  // (2026-11-01: the question widget's Review step had no Submit button).
  const fromRule = (rule) => {
    const region = lines.slice(rule + 1);
    const numbered = region.map((l, i) => [i, /^\s*(❯\s*)?(\d+)\.\s+(.*\S)/.exec(l)]).filter(([, m]) => m);
    // Options are chosen with arrows from the highlighted one, then Enter (move, above): a digit
    // would be typed into an option that has a text field ("Yes, and tell Claude what to do next").
    let options = [], first = -1;
    if (numbered.length) {
      first = numbered[0][0];
      const sel = Math.max(0, numbered.findIndex(([, m]) => m[1]));
      options = numbered.map(([, m], i) => ({ label: m[3], keys: move(sel, i) }));
    } else {
      const sel = region.findIndex((l) => /^\s*❯\s+\S/.test(l));
      if (sel < 0) return null;
      let a = sel, b = sel;
      while (a > 0 && /^\s{2,}\S/.test(region[a - 1])) a--;
      while (b + 1 < region.length && /^\s{2,}\S/.test(region[b + 1])) b++;
      first = a;
      options = region.slice(a, b + 1).map((l, i) => ({
        label: l.replace(/^\s*❯?\s*/, ""),
        keys: move(sel, i + a),
      }));
    }
    if (!options.length) return null;
    const before = region.slice(0, first).map((l) => l.trim()).filter((l) => l && !/^[╌─━┄\s]+$/.test(l) && !/^Tip:/.test(l) && !/^←.*→$/.test(l));
    const question = before.pop() ?? "";
    const title = before.shift() ?? "";
    return { title, body: before.slice(0, 8), question, options };
  };
  const rules = lines.map((l, i) => (RULE.test(l) ? i : -1)).filter((i) => i >= 0).reverse();
  for (const rule of rules.length ? rules.slice(0, 3) : [-1]) {
    const found = fromRule(rule);
    if (found) return found;
  }
  return null;
}

export default class Chat extends View {
  init(_props, cx) {
    this.open = (globalThis.__herdrChatOpen ??= {}); // row key -> expanded (kept across reloads)
    this.editors = {};         // code block key -> EditorState (null: draw plain)
    this.wantEditors = new Map();
    this.attach = {};          // tabId -> image paths waiting above the composer
    this.copied = null;
    this.busy = false;
    this.ticks = 0;
    this.shown = ROWS;         // rows built (the newest); "Show earlier" adds more
    this.input = TextareaState.new({ placeholder: "Reply to Claude…" });
    this.input.set_auto_grow(1, 10);
    this.input.on("submit", (e, cx) => {
      if (e.shift || e.secondary) return;      // Shift/Cmd+Enter: a new line, not a send
      this.send(cx);
    });
    this.input.on("paste_other", (_e, cx) => this.pasteImage(cx));
    // One composer serves every tab: each tab keeps its own draft, which also survives a reload
    // of this mod (a saved edit restarts it).
    try { this.drafts = JSON.parse(localStorage.getItem("drafts") ?? "{}"); } catch (_) { this.drafts = {}; }
    this.inputTab = null;
    this.slash = null;         // the "/" menu: { q, sel } while the box holds just "/word"
    this.cmds = {};            // session cwd -> { at, list } from BUILTINS + commands.sh
    this.input.on("change", (_e, cx) => {
      this.slashUpdate(cx);
      if (this.inputTab) this.saveDraft(this.inputTab, this.input.value());
    });
    cx.timer.every(700, (cx) => this.tick(cx));
  }

  saveDraft(tabId, text) {
    this.drafts[tabId] = text;
    try { localStorage.setItem("drafts", JSON.stringify(this.drafts)); } catch (_) {}
  }

  // --- reading ---------------------------------------------------------------------------

  // A tab's parsed conversation. Kept in SESSIONS (globalThis), so a tab seen before renders at
  // once, also after this mod reloads; the tick then only reads what's new.
  session(tabId) {
    return (SESSIONS[tabId] ??= { tab: tabId, raw: [], items: [], tools: {}, blocks: [], pending: [], offset: 0, head: 0 });
  }

  visible(tab) {
    return Boolean(tab) && find(layout(), "work")?.active === "chat" && ((shared(VIEW) ?? {})[tab.id] ?? "chat") === "chat";
  }

  // Only the shown tab polls: every tick while Claude works or asks, every ~3 s when idle.
  // A poll with nothing new costs one tiny read.sh run (a stat) and no redraw.
  tick(cx) {
    this.ticks++;
    if (this.makeEditors()) cx.notify();
    const tab = shownTab();
    if (!this.visible(tab) || this.busy) return;
    const pane = claudePane(tab.id);
    if (!pane) return;
    const s = this.session(tab.id), status = statusOf(pane, s);
    // Herdr counts a session as seen only when its terminal is looked at, so one read here stayed
    // "done" for good and every read session kept a waiting dot (2026-11-04). Mark it seen as the
    // terminal view does (hc label herdr.seen = its turn), while the window is in front.
    if (pane.status === "done" && window().active && !this.marking) this.markSeen(pane.terminal);
    const due =!s.loaded || s.underfilled || status === "working" || status === "blocked" || s.status !== status || this.ticks % 4 === 0;
    s.status = status;
    if (!due) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try { if (await this.sync(s, pane.terminal, status)) cx.notify(); }
      catch (e) { console.log(`chat: ${e?.message ?? e}`); }
      this.busy = false;
    });
  }

  async markSeen(address) {
    this.marking = true;
    try {
      const turn = JSON.parse((await hc(["get", address])).stdout)?.turn;
      if (turn != null) await hc(["label", address, `herdr.seen=${turn}`]);
    } catch (e) { console.log(`chat: ${e?.message ?? e}`); }
    this.marking = false;
  }

  // Brings a session up to date. Returns whether anything shown changed.
  async sync(s, address, status) {
    let changed = false;
    const term = terminals().find((t) => t.address === address);
    const pid = term?.foreground?.pid;
    const argv = term?.foreground?.argv ?? [];
    const asked = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : null;
    if (asked && !s.argvModel) s.argvModel = MODELS.find((m) => m.arg === asked || asked.includes(m.arg.replace("[1m]", "")))?.label ?? asked;
    // Which transcript: find.sh, only when the process, its sessions file's id or the terminal's
    // title changed. Until it answers, the cached conversation stays on screen.
    if (pid && (pid !== s.pid || !s.file || this.ticks % 8 === 0)) {
      const info = JSON.parse((await readTextFile(`${home()}/.claude/sessions/${pid}.json`)) ?? "null");
      s.pid = pid;
      const title = String(term?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
      const key = `${pid}|${info?.sessionId}|${title}`;
      // Every time, not only when the transcript changes: a tab cached from before had none, and
      // its file links opened under the home folder (2026-11-02).
      const cwd = info?.cwd ?? term?.foreground?.cwd ?? term?.cwd ?? "";
      s.cwd = cwd || s.cwd;
      // No transcript yet (a fresh session), or one that isn't this session's own (a guess, or a
      // stale sessions file): look again. A new tab kept the SSD handoff's guess for an hour (2026-11-04).
      if (key !== s.findKey || !s.file || s.sid !== info?.sessionId) {
        const file = (await exec("sh", [FINDER, cwd, title, info?.sessionId ?? ""])).stdout.trim() || null;
        s.findKey = key;
        if (file !== s.file) {
          Object.assign(s, { file, sid: fileName(file).replace(/\.jsonl$/, ""), offset: 0, head: 0, raw: [], items: [], tools: {}, blocks: [], pending: [], ctx: null, loaded: !file, tasks: undefined, tasksRaw: null });
          changed = true;
        }
      }
    }
    if (s.file) {
      // First read: the newest part only (read.sh "tail"); older history on "Show earlier".
      const { items, end } = await readItems(s.file, s.loaded ? String(s.offset) : "tail");
      if (!s.loaded) { s.head = end.head; s.loaded = true; changed = true; }
      if (end.missing) { s.file = null; s.findKey = null; }
      s.offset = end.offset ?? s.offset;
      if (items.length) { this.add(s, items, false); changed = true; }
      // Big tool outputs can leave the tail with a handful of rows: fill to ROWS, 2 MB per tick.
      else if (s.blocks.length < ROWS && s.head > 0 && !s.loadingEarlier) {
        this.add(s, await this.readEarlier(s), true);
        changed = true;
      }
      s.underfilled = s.blocks.length < ROWS && s.head > 0;
    }
    // The task files (taskList): every check while working, else every 8th. This Mac only.
    if (s.sid && (status === "working" || s.tasks === undefined || this.ticks % 8 === 0)) {
      const out = (await exec("sh", ["-c", 'cat "$1"/*.json 2>/dev/null | jq -cs .', "_", `${home()}/.claude/tasks/${s.sid}`])).stdout.trim() || "[]";
      if (out !== s.tasksRaw) {
        s.tasksRaw = out;
        try { s.tasks = JSON.parse(out); } catch { s.tasks = []; }
        changed = true;
      }
    }
    // The screen: the question when blocked, and the footer's live effort and permission mode.
    if (status === "blocked" || status === "working" || s.spin || s.prompt || this.ticks % 8 === 0 || !s.footer) {
      const screen = (await hc(["read", address])).stdout;
      const before = JSON.stringify([s.prompt, s.effort, s.screenMode, s.spin]);
      s.prompt = status === "blocked" ? parsePrompt(screen) : null;
      this.readFooter(s, screen);
      if (JSON.stringify([s.prompt, s.effort, s.screenMode, s.spin]) !== before) changed = true;
    }
    return changed;
  }

  // "Show earlier messages": more of the rows already read, else the next 2 MB further back.
  showEarlier(s, rowCount, cx) {
    if (rowCount > this.shown) { this.shown += 50; cx.notify(); return; }
    if (!s.file || s.head <= 0 || s.loadingEarlier) return;
    s.loadingEarlier = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try { this.add(s, await this.readEarlier(s), true); this.shown += 50; }
      finally { s.loadingEarlier = false; cx.notify(); }
    });
  }

  // The next window of history before s.head. One line bigger than the window (a pasted
  // screenshot is base64 in the transcript) left head where it was, so the fill loop re-read
  // 2 MB every tick forever: double the window then. A file switched meanwhile (/clear) is
  // ignored rather than mixed in (review 2026-11-01).
  async readEarlier(s) {
    const span = s.span ?? 2097152, file = s.file;
    const { items, end } = await readItems(file, String(Math.max(0, s.head - span)), String(s.head));
    if (s.file !== file) return [];
    const head = end.head ?? 0;
    s.span = head === s.head && head > 0 ? span * 2 : 2097152;
    s.head = head;
    return items;
  }

  readFooter(s, screen) {
    // Claude Code's own spinner line, e.g. "✶ Quantumizing… (1m 9s · ↓ 3.9k tokens · thought for 17s)":
    // the chat shows the same words instead of a generic "working".
    const spin = [...screen.matchAll(/^\s*[·✢✳✶✻✽*]\s+([^\s(][^(\n]*…)\s*(?:\(([^)\n]*)\))?/gm)].pop();
    s.spin = spin ? { verb: spin[1].trim(), info: spin[2] ?? "" } : null;
    const effort = /[◐◑◒◓○●◉]\s+(\w+)\s+·\s+\/effort/.exec(screen)?.[1];
    if (effort) s.effort = effort;
    const mode = MODES.find((m) => screen.includes(m.screen));
    if (mode) s.screenMode = mode.id;
    s.footer = true;
  }

  // New items join the raw list (older ones in front); the shown rows are derived from it.
  add(s, items, older) {
    s.raw = older ? items.concat(s.raw) : s.raw.concat(items);
    if (!older) {
      for (const item of items) {
        if (item.k !== "user") continue;
        const text = item.text.replace(AT_IMAGE, (_m, sp) => sp).trim();
        // The same text, else the oldest: messages come back in order, but Claude Code sometimes
        // records a pasted text differently, and an unmatched grey bubble stayed forever (a double).
        const i = s.pending.findIndex((p) => p.text.trim() === text);
        if (s.pending.length) s.pending.splice(i >= 0 ? i : 0, 1);
      }
    }
    this.digest(s);
  }

  digest(s) {
    s.items = []; s.tools = {};
    const results = {}, early = {}, seen = new Set();
    // Reply text from api-request-blob entries names the tool call it came before (items.jq).
    const placeBefore = (tool, item) => {
      const i = s.items.indexOf(tool), prev = s.items[i - 1];
      if (prev?.k === "text" && prev.text === item.text) return; // already there (older transcripts)
      s.items.splice(i, 0, { k: "text", id: item.id, text: item.text });
    };
    for (const item of s.raw) {
      // One row per id, however a copy got in (overlapping reads, re-reads): no doubles.
      if (item.id && (item.k === "user" || item.k === "text" || item.k === "tool" || item.k === "note")) {
        const key = `${item.k}:${item.id}:${item.before ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      switch (item.k) {
        case "tool": {
          s.tools[item.id] = { ...item, res: results[item.id] };
          s.items.push(s.tools[item.id]);
          if (early[item.id]) { placeBefore(s.tools[item.id], early[item.id]); delete early[item.id]; }
          break;
        }
        case "text":
          if (!item.before) { s.items.push(item); break; }
          if (s.tools[item.before]) placeBefore(s.tools[item.before], item); else early[item.before] = item;
          break;
        case "res": if (s.tools[item.id]) s.tools[item.id].res = item; else results[item.id] = item; break;
        case "model": s.model = item.name; s.window = /\[1m\]|\b1M\b/i.test(`${item.id} ${item.name ?? ""}`) ? 1e6 : 2e5; break;
        case "mode": s.mode = item.mode; break;
        case "ctx": s.ctx = item.used; break;
        case "bg":
          if (!s.bg && s.tab && !(shared(VIEW) ?? {})[s.tab]) setShared(VIEW, { ...(shared(VIEW) ?? {}), [s.tab]: "terminal" });
          s.bg = true; break;
        case "user": {
          const imgs = [...item.imgs ?? []];
          const text = item.text.replace(AT_IMAGE, (_m, sp, path) => { imgs.push(path); return sp; }).trim();
          s.items.push({ ...item, text, imgs });
          break;
        }
        default: s.items.push(item);
      }
    }
    s.blocks = this.blocks(s.items);
  }

  // Items -> list rows: runs of tool calls fold into one row, replies split at code blocks.
  blocks(items) {
    const out = [];
    let group = null, turn = null;
    const roles = textRoles(items);
    // The end of each reply, as in the desktop app: "Changed N files" (per-file +/-) and a row
    // with Copy and its age. The last turn's are marked live: hidden while Claude still works.
    const close = (live) => {
      if (!turn || (!turn.texts.length && !turn.files.size)) return;
      if (turn.files.size) out.push({ key: `chg:${turn.key}`, kind: "changes", live, files: [...turn.files.values()] });
      if (turn.texts.length) out.push({ key: `foot:${turn.key}`, kind: "foot", live, text: turn.texts.join("\n\n"), at: turn.at });
    };
    for (const [n, item] of items.entries()) {
      if (item.k === "user") { close(false); turn = null; }
      if (!turn && item.k !== "user") turn = { key: item.id, texts: [], files: new Map(), at: null };
      if (item.k === "text" && turn) { turn.texts.push(item.text); turn.at = item.at ?? turn.at; }
      if (item.k === "tool" && turn && EDIT_TOOLS.includes(item.name)) {
        const path = item.in?.file_path ?? item.in?.notebook_path;
        const f = turn.files.get(path) ?? { path, add: 0, del: 0 };
        f.add += item.res?.add ?? 0; f.del += item.res?.del ?? 0;
        if (path) turn.files.set(path, f);
      }
      if (item.k === "tool") {
        if (!group) out.push(group = { key: `g:${item.id}`, kind: "tools", tools: [] });
        group.tools.push(item);
        continue;
      }
      group = null;
      if (item.k === "text") {
        segments(item.text).forEach((seg, i) => out.push(seg.code !== undefined
          ? { key: `c:${item.id}:${i}`, kind: "code", code: seg.code, lang: seg.lang }
          : { key: `t:${item.id}:${i}`, kind: "md", text: seg.md, role: roles[n] }));
      } else out.push({ key: `${item.k}:${item.id}`, kind: item.k, text: item.text, imgs: item.imgs });
    }
    close(true);
    return out;
  }

  // Opens a file Claude named as a tab of the shown Herdr tab, in the main window (shared
  // "session-files", drawn by session-files). Copied from files-plus/workspace.js openInSession.
  openFile(path, s) {
    const tab = shownTab();
    if (!tab || !path) return;
    let p = path.replace(/:\d+(?:-\d+)?$/, "");
    const rel = p.replace(/^\.\//, "");
    if (p.startsWith("~/")) p = `${home()}${p.slice(1)}`;
    else if (!p.startsWith("/")) p = `${s?.cwd ?? home()}/${rel}`;
    // Claude often names a file without its folder ("threshold_curves_val.png" in a list under
    // results/run/): not there, take the newest file under the session's folder ending in it.
    if (path.startsWith("/") || path.startsWith("~/") || !s?.cwd) return this.showFile(tab, p);
    exec("sh", ["-c", FIND_FILE, "sh", s.cwd, rel, p]).then((r) => this.showFile(tab, r.stdout.trim() || p), () => this.showFile(tab, p));
  }

  showFile(tab, p) {
    const live = new Set(spaces().flatMap((x) => x.tabs.map((y) => y.id)));
    const all = Object.fromEntries(Object.entries(shared("session-files") ?? {}).filter(([id]) => live.has(id)));
    const files = all[tab.id]?.files ?? [];
    all[tab.id] = { files: files.some((f) => f.path === p) ? files : [...files, { path: p, on: null }], active: p };
    setShared("session-files", all);
  }

  openLink(url, s) {
    if (url.startsWith("hfile:")) return this.openFile(decodeURIComponent(url.slice(6)), s);
    if (url.startsWith("file://")) return this.openFile(decodeURIComponent(url.slice(7)), s);
    if (/^https?:/.test(url)) return exec("open", [url]).catch(() => {});
    if (url.startsWith("/") || url.startsWith("~/")) return this.openFile(url, s);
  }

  // Code blocks are drawn with the read-only editor for syntax colors. Its state can't be made
  // in render, so render asks (this.wantEditors) and the next tick makes it.
  makeEditors() {
    if (!this.wantEditors?.size) return false;
    const t = theme();
    for (const [key, b] of this.wantEditors) {
      const lang = (b.lang || "").toLowerCase();
      try {
        this.editors[key] = EditorState.new({ language: LANG[lang] ?? (lang || "text"), value: b.code, readonly: true,
          line_numbers: false, folding: false, soft_wrap: false, font_family: settings().font_family, font_size: 12.5,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch (_) { this.editors[key] = null; }
    }
    this.wantEditors.clear();
    return true;
  }

  // --- writing ---------------------------------------------------------------------------

  send(cx) {
    const tab = shownTab(), pane = tab && claudePane(tab.id);
    if (!pane) return;
    const text = this.input.value().replace(/\s+$/, "");
    const imgs = this.attach[tab.id] ?? [];
    if (!text.trim() && !imgs.length) { this.input.set_value(""); return; }
    // Images first: Claude Code attaches `@/path.png`; at the end its @-menu would take the Enter.
    const message = [...imgs.map((p) => `@${p}`), text.trim() || "(image)"].join("\n");
    this.input.set_value("");
    this.scrollY = 0; // show what was just sent
    // set_value doesn't fire "change": clear the saved draft too, or the sent text comes back on reload.
    this.saveDraft(tab.id, "");
    this.attach[tab.id] = [];
    // `/cmd`, `!shell` and `<…>` come back changed or not at all, so a grey bubble never cleared.
    const entry = /^[\/!<]/.test(text.trim()) ? null : { text: text.trim() || "(image)", imgs };
    const s = this.session(tab.id), chatKeys = s.prompt?.chat ?? null;
    s.prompt = null;
    if (entry) s.pending.push(entry);
    cx.notify();
    cx.spawn(async (cx) => {
      // Only into a live Claude: after a crash the terminal can be a bare shell still showing Claude's
      // last screen, and the message would run as a shell command (2026-11-01, disk full).
      const ALIVE = 'for p in $(pgrep -x claude); do ps -E -p "$p" -o command= 2>/dev/null | grep -q "HC_TERMINAL_ID=$1\\( \\|$\\)" && exit 0; done; exit 1';
      let r, done = false;
      // hc send waits for the terminal (a person typing there, a busy screen): say so instead of
      // a grey bubble that looks sent (2026-11-01: one waited 8 minutes).
      cx.spawn(async (cx) => { await cx.sleep(5000); if (!done && entry) { entry.waiting = true; cx.notify(); } });
      const alive = await exec("sh", ["-c", ALIVE, "sh", pane.terminal]).then((x) => x.code === 0, () => false);
      if (!alive) r = { code: 1, stderr: "Claude isn't running in this terminal any more (it shows its last screen). Start or re-attach Claude there, then send again." };
      // A question widget on screen would swallow the pasted text: "Chat about this" drops it first
      // (and Claude answers that), then the message goes in as usual (2026-11-01).
      else if (chatKeys) {
        await hc(["keys", pane.terminal, ...chatKeys]);
        for (let i = 0; i < 20 && parsePrompt((await hc(["read", pane.terminal])).stdout)?.chat; i++) await cx.sleep(200);
      }
      // "--": a message starting with "- " (a list) was read as an option and failed.
      if (alive) try { r = await exec("env", ["-u", "HC_TERMINAL_ID", "hc", "send", "--json", pane.terminal, "--", message]); }
      catch (e) { r = { code: 1, stderr: String(e?.message ?? e) }; }
      // An image path makes Claude Code load the file as the paste lands, and an Enter that comes
      // meanwhile is dropped: hc send gives up after 5 s ("started": false, exit 0) and the text sits
      // in the terminal's box (2026-11-02, a 760 KB photo, 3 of 3). Press Enter again until a turn
      // starts, so an empty box never gets an Enter. Started = working (or asking) now, or the turn
      // count moved: hc counts a turn when it ends, so a long one left the count alone and a message
      // Claude had taken was reported as failed (2026-11-02).
      let res = {};
      try { res = JSON.parse(r?.stdout || "{}"); } catch (_) {}
      if (r?.code === 0 && res.started === false && (res.status === "idle" || res.status === "done")) {
        const begun = async () => {
          try {
            const g = JSON.parse((await hc(["get", pane.terminal, "--json"])).stdout);
            return g.turn !== res.turn || ["working", "blocked"].includes(g.status?.state ?? g.status);
          } catch (_) { return false; }
        };
        let started = false;
        for (let i = 0; i < 5 && !started; i++) {
          if (await begun()) { started = true; break; }
          await hc(["keys", pane.terminal, "enter"]);
          await cx.sleep(1500);
          started = await begun();
        }
        if (!started) r = { code: 1, stderr: "Claude didn't take the message: it's still in the terminal's text box. Press Enter there, or clear it and send again." };
      }
      // The same dropped Enter mid-turn: the text stayed in the box, looked queued, and went out
      // only with the next message, all three as one (2026-11-03). Enter again while it's there.
      if (r?.code === 0 && res.status === "working") {
        for (let i = 0; i < 5; i++) {
          await cx.sleep(i ? 1500 : 800);
          if (!stuckIn(boxText((await hc(["read", pane.terminal])).stdout), message)) break;
          await hc(["keys", pane.terminal, "enter"]);
        }
      }
      done = true;
      if (entry?.waiting) { entry.waiting = false; cx.notify(); }
      // Typed while Claude works, Claude Code queues it until the running tool call ends (a subagent
      // can take minutes): it shows above the composer with Send now, not as a sent bubble (2026-11-01).
      if (r.code === 0 && entry && /"status":"working"/.test(r.stdout ?? "")) { entry.queued = true; cx.notify(); }
      if (r.code === 0) return;
      notify({ title: "Couldn't send to Claude", body: (r.stderr || r.stdout || "").trim().slice(0, 300), level: "error" });
      if (entry) s.pending = s.pending.filter((p) => p !== entry);
      // Give the text back instead of losing it (the box was emptied on send).
      if (shownTab()?.id === tab.id && !this.input.value()) {
        this.input.set_value(text);
        this.saveDraft(tab.id, text);
        this.attach[tab.id] = imgs;
      }
      cx.notify();
    });
  }

  addImage(tabId, path) {
    (this.attach[tabId] ??= []).push(path);
  }

  // ⌘V with an image on the clipboard: macOS hands it over as PNG through AppleScript.
  pasteImage(cx) {
    const tab = shownTab();
    if (!tab) return;
    const path = `${STATE}/${tab.id}/${Date.now()}.png`;
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", `${STATE}/${tab.id}`]);
      const r = await exec("osascript", [
        "-e", "try", "-e", "set d to the clipboard as «class PNGf»", "-e", "on error", "-e", 'return "none"', "-e", "end try",
        "-e", `set f to open for access (POSIX file "${path}") with write permission`,
        "-e", "set eof f to 0", "-e", "write d to f", "-e", "close access f", "-e", 'return "ok"']);
      if (r.stdout.trim() === "ok") { this.addImage(tab.id, path); cx.notify(); }
    });
  }

  // Dropped image files are copied next to pasted ones (their own paths may have spaces).
  dropFiles(paths, cx) {
    const tab = shownTab();
    if (!tab) return;
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", `${STATE}/${tab.id}`]);
      for (const [i, src] of paths.filter((p) => IMAGE_EXT.test(p)).entries()) {
        const dst = `${STATE}/${tab.id}/${Date.now()}-${i}${src.match(IMAGE_EXT)[0].toLowerCase()}`;
        if ((await exec("cp", [src, dst])).code === 0) this.addImage(tab.id, dst);
      }
      cx.notify();
    });
  }

  pickImage(cx) {
    const tab = shownTab();
    if (!tab) return;
    cx.spawn(async (cx) => {
      const r = await exec("osascript", ["-e", 'POSIX path of (choose file of type {"public.image"} with prompt "Attach an image")']);
      const path = r.stdout.trim();
      if (r.code === 0 && path) this.dropFiles([path], cx);
    });
  }

  // The stop button: Esc is Claude Code's own interrupt. The working line hides at once; the next
  // tick brings the real status back.
  stop(s, address, cx) {
    s.spin = null;
    cx.notify();
    cx.spawn(async () => { await hc(["keys", address, "esc"]); });
  }

  // Messages Claude Code holds until its running tool call ends. Send now is its own Ctrl+Enter:
  // the running command or subagent moves to the background (it keeps running) and Claude reads
  // the message at once. A queued message leaves the strip when it shows up in the transcript.
  queued(t, s, address) {
    const q = s.pending.filter((p) => p.queued);
    return div().w_full().max_w(COLUMN).px(28).child(v_flex().w_full().px(12).py(8).gap(6).rounded(10).border(1).border_color(t.border).bg(t.raised)
      .child(h_flex().items_center().gap(8).text_size(12).text_color(t.muted)
        .child(div().flex_1().child(q.length > 1 ? `${q.length} queued · Claude reads them when its current step ends` : "Queued · Claude reads it when its current step ends"))
        .child(div().id("send-now").px(10).py(3).rounded(6).border(1).border_color(t.input).text_color(t.foreground).cursor_pointer()
          .hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.sendNow(address, cx)).child("Send now")))
      .children(q.map((p) => div().text_size(13.5).text_color(t.foreground).truncate()
        .child(`${p.imgs?.length ? `[${p.imgs.length} image${p.imgs.length > 1 ? "s" : ""}] ` : ""}${p.text.replace(/\s+/g, " ")}`))));
  }

  // Claude's task list over the composer, like the desktop app: "N of M done", the task in
  // progress in its "-ing" words. The head folds it to that one task. Gone once all are done
  // and Claude has stopped.
  tasksCard(t, s, status) {
    const list = taskList(s.tasks, Object.values(s.tools ?? {}));
    const done = list.filter((x) => x.status === "completed").length;
    if (!list.length || (done === list.length && status !== "working")) return null;
    const now = list.find((x) => x.status === "in_progress");
    const row = (x, i) => h_flex().gap(8).items_start().text_size(13)
      .child(div().flex_none().w(14).text_color(x.status === "completed" ? t.ansi2 : x.status === "in_progress" ? t.accent : t.dim)
        .child(x.status === "completed" ? "✓" : x.status === "in_progress" ? "◉" : "○"))
      .child(div().flex_1().min_w(0).id(`task-${i}`)
        .when(x.status === "completed", (el) => el.text_color(t.muted).line_through())
        .when(x.status === "in_progress", (el) => el.text_color(t.foreground).font_medium())
        .when(x.status === "pending", (el) => el.text_color(t.foreground))
        .child(x.status === "in_progress" && x.active ? x.active : x.text));
    return div().w_full().max_w(COLUMN).px(28).child(v_flex().w_full().px(12).py(8).gap(6).rounded(10).border(1).border_color(t.border).bg(t.raised)
      .child(h_flex().id("tasks-head").items_center().gap(8).text_size(12).text_color(t.muted).cursor_pointer()
        .on_click((_e, cx) => { s.tasksFolded = !s.tasksFolded; cx.notify(); })
        .child(div().flex_1().child(`Tasks · ${done} of ${list.length} done`))
        .child(div().child(s.tasksFolded ? "▸" : "▾")))
      .when(s.tasksFolded && Boolean(now), (el) => el.child(row(now, list.indexOf(now))))
      .when(!s.tasksFolded, (el) => el.children(list.map(row))));
  }

  // Selectable plain text (user messages, tool output, notes).
  selText(id, text) {
    return div().min_w(0).on_mouse_down("left", () => { this.keepFocus = true; })
      .child(TextView.markdown(id, plainMd(text)).selectable(true));
  }

  // --- right-to-left text -----------------------------------------------------------------

  // Markdown with RTL text: RTL blocks as right-to-left word flow, the rest through TextView.
  rtlView(t, key, md) {
    const s = this.session(shownTab()?.id);
    const piece = (p, id) => {
      let el = div().whitespace_nowrap();
      if (p.b) el = el.font_bold();
      if (p.i) el = el.italic();
      if (p.code) el = el.font_family("JetBrains Mono").text_size(12.5).px(4).rounded(4).bg(t.raised);
      if (p.link) el = el.id(id).text_color(t.accent).cursor_pointer().on_click(() => this.openLink(p.link, s));
      return el.child(p.t);
    };
    const word = (w, rtl, id) => w.length === 1 ? piece(w[0], id)
      : h_flex().when(rtl, (el) => el.flex_row_reverse()).children(w.map((p, k) => piece(p, `${id}.${k}`)));
    const flow = (text, id) => h_flex().flex_1().min_w(0).flex_row_reverse().flex_wrap().gap_x(4)
      .children(rtlRuns(text).flatMap((r, i) => r.rtl ? r.words.map((w, j) => word(w, true, `${id}-${i}-${j}`))
        : [h_flex().flex_wrap().gap_x(4).children(r.words.map((w, j) => word(w, false, `${id}-${i}-${j}`)))]));
    return v_flex().w_full().gap(8).children(rtlBlocks(md).map((b, i) => {
      const id = `${key}:${i}`;
      if (!b.rtl) {
        const src = b.kind === "h" ? `${"#".repeat(b.level)} ${b.text}` : b.kind === "li" ? `${"  ".repeat(b.indent)}${b.marker === "•" ? "-" : b.marker} ${b.text}` : b.text;
        return TextView.markdown(id, linkFiles(src)).selectable(true).on_link_click((url) => this.openLink(url, s));
      }
      if (b.kind === "h") return div().w_full().pt(6).font_bold().text_size(b.level <= 1 ? 20 : b.level === 2 ? 17 : 15).child(flow(b.text, id));
      if (b.kind === "li") return h_flex().w_full().flex_row_reverse().items_start().gap(8).pr(b.indent * 22)
        .child(div().flex_none().min_w(18).text_color(t.muted).child(b.marker === "•" ? "•" : b.marker.replace(/[.)]$/, "") + "."))
        .child(flow(b.text, id));
      return h_flex().w_full().child(flow(b.text, id));
    }));
  }

  // --- the "/" menu ----------------------------------------------------------------------

  slashUpdate(cx) {
    const m = /^\/(\S*)$/.exec(this.input.value()), was = this.slash;
    this.slash = m ? { q: m[1], sel: was?.q === m[1] ? was.sel : 0 } : null;
    if (m) this.loadCommands(cx);
    if (m || was) cx.notify();
  }

  // Read once a minute per folder: a skill added meanwhile shows up the next time "/" is typed.
  loadCommands(cx) {
    const cwd = this.session(shownTab()?.id).cwd ?? home(), c = this.cmds[cwd];
    if (c && Date.now() - c.at < 60000) return;
    this.cmds[cwd] = { at: Date.now(), list: c?.list ?? BUILTINS.map(([name, desc]) => ({ name, desc })) };
    cx.spawn(async (cx) => {
      const r = await exec("sh", [COMMANDS, cwd]).catch(() => ({ stdout: "" }));
      const seen = new Set(), list = [];
      for (const [name, desc] of [...BUILTINS, ...(r.stdout ?? "").split("\n").filter(Boolean).map((l) => l.split("\t"))]) {
        if (!seen.has(name)) { seen.add(name); list.push({ name, desc: desc ?? "" }); }
      }
      this.cmds[cwd] = { at: Date.now(), list };
      cx.notify();
    });
  }

  slashMatches() {
    if (!this.slash) return [];
    return matchCommands(this.cmds[this.session(shownTab()?.id).cwd ?? home()]?.list ?? [], this.slash.q);
  }

  // The picked command goes into the box with a space, ready for arguments; Enter then sends it.
  pickCommand(c) {
    const v = `/${c.name} `;
    this.slash = null;
    this.input.set_value(v);
    try { this.input.set_selected_range({ start: v.length, end: v.length }); } catch (_) {}
    if (this.inputTab) this.saveDraft(this.inputTab, v);
  }

  slashMenu(t, items) {
    const sel = Math.min(this.slash.sel, items.length - 1);
    return v_flex().id("slash-menu").w_full().max_h(320).overflow_y_scroll().p(4).rounded(10)
      .border(1).border_color(t.border).bg(t.popover).shadow_md()
      .children(items.slice(0, 60).map((c, i) => h_flex().id(`slash-${i}`).w_full().px(10).py(5).gap(12).rounded(6).items_center()
        .cursor_pointer().when(i === sel, (el) => el.bg(t.hover)).hover((st) => st.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.pickCommand(c); this.input.focus(); cx.notify(); })
        .child(div().flex_none().text_size(13).text_color(t.foreground).child(`/${c.name}`))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(c.desc))));
  }

  sendNow(address, cx) {
    // Only while Claude Code still offers it: on an empty prompt Ctrl+Enter could take its grey suggestion.
    // A message whose Enter was dropped is still in the box: Enter sends (or queues) it.
    cx.spawn(async () => {
      const screen = (await hc(["read", address])).stdout;
      if (screen.includes("ctrl+enter to send now")) await hc(["keys", address, "ctrl+enter"]);
      else if (this.session(shownTab()?.id).pending.some((p) => p.queued && stuckIn(boxText(screen), p.text))) await hc(["keys", address, "enter"]);
    });
  }

  answer(address, keys, cx) {
    // Hide the card first: a double click used to send Enter again and approve the next question.
    const s = this.session(shownTab()?.id);
    s.prompt = null;
    cx.notify();
    cx.spawn(async () => { await hc(["keys", address, ...keys]); });
  }

  toTerminal(tab, address) {
    setShared(VIEW, { ...(shared(VIEW) ?? {}), [tab.id]: "terminal" });
    if (address) run("pane.focus", { terminal: address });
  }

  // --- drawing ---------------------------------------------------------------------------

  // A row with its one action: tool lines expand, code blocks copy.
  clickable(t, b) {
    let inner;
    try { inner = this.row(t, b); } catch (e) { inner = div().text_color(t.ansi1).child(`row ${b.kind}: ${e?.stack ?? e}`); }
    return div().id(`row-${b.key}`).flex_none().w_full().child(inner);
  }

  row(t, b) {
    const col = (el) => h_flex().w_full().justify_center().child(v_flex().w_full().max_w(COLUMN).px(28).child(el));
    switch (b.kind) {
      case "user":
        return col(v_flex().w_full().items_end().pt(18).pb(10).child(
          v_flex().max_w(560).px(16).py(11).gap(8).rounded(14).bg(t.raised).text_color(t.foreground)
            .when(b.pending, (el) => el.opacity(0.6))
            .when(Boolean(b.waiting), (el) => el.child(h_flex().gap(8).text_size(12).text_color(t.muted)
              .child("Waiting for the terminal to take it…")
              .child(div().id(`wait-${b.key}`).text_color(t.accent).cursor_pointer().on_click(() => this.toTerminal(shownTab(), null)).child("Open Terminal"))))
            .when(b.imgs?.length > 0, (el) => el.child(h_flex().gap(8).flex_wrap().children(
              b.imgs.map((p) => div().rounded(8).overflow_hidden().border(1).border_color(t.border).child(image(imgSrc(p)).h(90))))))
            .when(Boolean(b.text), (el) => {
              // Bubbles read before items.jq dropped Claude Code's paste tags still carry them.
              const text = b.text.replace(/<\/?pasted_content[^>]*>/g, "").trim();
              return el.child(div().text_size(14).line_height("22px")
                .child(isRtl(text) ? this.rtlView(t, `u-${b.key}`, text) : this.selText(`ut-${b.key}`, text)));
            })));
      case "md": {
        // Narration between tool calls reads quieter than the reply: muted (still ~4.5:1), 1px smaller.
        const quiet = b.role === "interim";
        return col(div().w_full().py(5).text_size(quiet ? 13 : 14).line_height(quiet ? "21px" : "23px").text_color(quiet ? t.muted : t.foreground)
          .on_mouse_down("left", () => { this.keepFocus = true; })
          .child(isRtl(b.text) ? this.rtlView(t, b.key, b.text) : TextView.markdown(b.key, linkFiles(b.text)).selectable(true)
            .on_link_click((url) => this.openLink(url, this.session(shownTab()?.id)))));
      }
      case "code": {
        const ed = this.editors[b.key], lines = b.code.split("\n").length;
        if (ed === undefined) this.wantEditors.set(b.key, b);
        const copy = div().id(`copy-${b.key}`).px(8).py(2).rounded(6).text_size(12).cursor_pointer()
          .text_color(this.copied === b.key ? t.foreground : t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.write_to_clipboard(b.code); this.copied = b.key; cx.notify(); })
          .child(this.copied === b.key ? "✓ Copied" : "⧉ Copy");
        return col(v_flex().w_full().my(8).rounded(10).border(1).border_color(t.border).bg(t.surface).overflow_hidden()
          .child(h_flex().h(32).px(12).items_center().justify_between().bg(t.raised).border_b(1).border_color(t.border)
            .child(div().text_size(12).text_color(t.dim).child(b.lang || "text")).child(copy))
          .child(ed
            ? div().w_full().h(Math.min(lines, 30) * 19 + 18).px(6).py(6).on_mouse_down("left", () => { this.keepFocus = true; })
              .child(Editor.new(ed).size_full())
            : v_flex().px(14).py(10).font_family("JetBrains Mono").text_size(12.5).line_height("19px").text_color(t.foreground)
              .children(b.code.split("\n").slice(0, 400).map((l) => div().child(l || " ")))));
      }
      case "changes": {
        const all = this.open[b.key], shownFiles = all ? b.files : b.files.slice(0, 3);
        const add = b.files.reduce((n, f) => n + f.add, 0), del = b.files.reduce((n, f) => n + f.del, 0);
        const nums = (a, d) => h_flex().gap(4).text_size(13).child(div().text_color(t.ansi2).child(`+${a}`)).child(div().text_color(t.ansi1).child(`−${d}`));
        return col(v_flex().w_full().my(10).rounded(12).border(1).border_color(t.border).bg(t.surface).overflow_hidden()
          .child(h_flex().h(42).px(16).items_center().border_b(1).border_color(t.border).text_size(14)
            .child(div().child(`Changed ${plural(b.files.length, "file")}`)))
          .children(shownFiles.map((f, i) => h_flex().id(`chg-${b.key}-${i}`).h(38).px(16).gap(10).items_center().cursor_pointer()
            .hover((st) => st.bg(t.hover)).on_click(() => this.openFile(f.path, this.session(shownTab()?.id)))
            .child(div().text_size(12).text_color(t.dim).child("<>"))
            .child(div().text_size(14).child(fileName(f.path)))
            .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.dim).child(fileName(String(f.path).split("/").slice(0, -1).join("/"))))
            .child(nums(f.add, f.del))))
          .when(b.files.length > 3, (el) => el.child(h_flex().id(`chg-more-${b.key}`).h(38).px(16).items_center().cursor_pointer()
            .hover((st) => st.bg(t.hover)).on_click((_e, cx) => { this.open[b.key] = !all; cx.notify(); })
            .child(div().flex_1().text_size(14).child(all ? "Show less" : "See all")).child(nums(add, del)))));
      }
      case "foot":
        return col(h_flex().w_full().pt(2).pb(14).gap(12).items_center().text_size(12.5).text_color(t.dim)
          .child(div().id(`foot-copy-${b.key}`).px(6).py(2).rounded(6).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.write_to_clipboard(b.text); this.copied = b.key; cx.notify(); })
            .child(this.copied === b.key ? "✓ Copied" : "⧉"))
          .when(Boolean(b.at), (el) => el.child(div().child(ago(b.at)))));
      case "tools": {
        const open = this.open[b.key];
        const parts = toolSummary(b.tools);
        return col(v_flex().w_full().py(7)
          // Only the summary line toggles: a drag over the output below selects it.
          .child(h_flex().id(`tools-${b.key}`).gap(0).text_size(13.5).text_color(t.muted).cursor_pointer()
            .hover((st) => st.text_color(t.foreground))
            .on_click((_e, cx) => { this.open[b.key] = !this.open[b.key]; cx.notify(); })
            .children(parts.flatMap((p, i) => [
              div().child(`${i ? ", " : ""}${p.text}`),
              ...(p.add || p.del ? [div().ml(6).text_color(t.ansi2).child(`+${p.add}`), div().ml(4).text_color(t.ansi1).child(`−${p.del}`)] : []),
            ]))
            .child(div().ml(6).text_size(11).child(open ? "▾" : "▸")))
          .when(Boolean(open), (el) => el.child(v_flex().mt(6).gap(10)
            .children(b.tools.map((tool) => this.toolDetail(t, tool, b.tools.length > 1))))));
      }
      case "note":
        return col(h_flex().w_full().py(10).justify_center().text_size(12).text_color(t.dim).child(this.selText(`n-${b.key}`, b.text)));
      default:
        return col(div());
    }
  }

  // One call in an opened tool row: its description (when the row holds several), then a box with
  // what ran (a Bash call's whole command) and the start of its output.
  toolDetail(t, tool, label) {
    const out = (tool.res?.out ?? "").split("\n"), more = out.length - 12;
    return v_flex().gap(4)
      .when(label && Boolean(tool.in?.description), (el) => el.child(div().text_size(12.5).text_color(t.muted).child(tool.in.description)))
      .child(v_flex().rounded(8).border(1).border_color(t.border).bg(t.surface).overflow_hidden()
        .font_family("JetBrains Mono").text_size(12).line_height("18px")
        .child(div().px(12).py(8).text_color(t.foreground).child(this.selText(`tt-${tool.id}`, toolTitle(tool))))
        .when(Boolean(tool.res?.out), (el) => el.child(div().px(12).py(8).border_t(1).border_color(t.border)
          .text_color(tool.res.err ? t.ansi1 : t.muted)
          .child(this.selText(`to-${tool.id}`, out.slice(0, 12).map((l) => l.slice(0, 300)).join("\n")
            + (more > 0 ? `\n… ${plural(more, "more line")}` : ""))))));
  }

  promptCard(t, tab, address, s) {
    const report = terminals().find((x) => x.address === address)?.report;
    const p = s.prompt;
    const btn = (id, label, primary, action) => div().id(id).px(12).py(5).rounded(7).text_size(13)
      .border(1).border_color(primary ? t.accent : t.input).bg(primary ? t.accent : t.surface)
      .text_color(primary ? t.accent_foreground : t.foreground).hover((st) => st.opacity(0.85)).cursor_pointer()
      .on_click((_e, cx) => action(cx)).child(label);
    return v_flex().w_full().p(14).gap(8).rounded(12).border(1).border_color(t.blocked).bg(t.surface)
      .child(div().text_size(13.5).font_semibold().text_color(t.foreground)
        .child(p?.title || report?.msg || "Claude is asking something"))
      .when(Boolean(p?.body?.length), (el) => el.child(v_flex().px(10).py(7).rounded(6).bg(t.background)
        .font_family("JetBrains Mono").text_size(12).line_height("18px").text_color(t.muted)
        .children(p.body.map((l) => div().child(l)))))
      .when(Boolean(p?.question), (el) => el.child(div().text_size(13.5).text_color(t.foreground).child(p.question)))
      .when(p?.kind === "question", (el) => el.child(this.questionRows(t, address, p)))
      .child(h_flex().flex_wrap().gap(6)
        .when(p?.kind === "question" && Boolean(p.chat), (el) => el.child(btn("chat-about", "Chat about this instead", false, (cx) => this.answer(address, p.chat, cx))))
        .children((p?.kind === "question" ? [] : p?.options ?? []).map((o, i) => btn(`opt-${i}`, o.label.length > 70 ? `${o.label.slice(0, 68)}…` : o.label, i === 0, (cx) => this.answer(address, o.keys, cx))))
        .child(btn("open-terminal", p ? "Open Terminal" : "Claude is asking something — open Terminal", false, () => this.toTerminal(tab, address))));
  }

  // An AskUserQuestion's tabs and options. A press is the arrows to that row and Enter: it ticks
  // a box (multi-select) or picks and moves on; the next read redraws what the terminal shows.
  questionRows(t, address, p) {
    return v_flex().w_full().gap(4)
      .when(p.tabs.length > 1, (el) => el.child(h_flex().gap(6).pb(2).children(p.tabs.map((tb) =>
        div().px(8).py(2).rounded(10).text_size(11.5).bg(tb.done ? t.selected : t.background).text_color(tb.done ? t.foreground : t.dim)
          .child(`${tb.done ? "✓ " : ""}${tb.label}`)))))
      .children(p.options.map((o, i) => h_flex().id(`q-${i}`).w_full().px(10).py(6).gap(10).items_start().rounded(8).cursor_pointer()
        .border(1).border_color(o.cur ? t.accent : t.border).bg(o.next ? t.accent : t.background)
        .text_color(o.next ? t.accent_foreground : t.foreground).hover((st) => st.opacity(0.85))
        .on_click((_e, cx) => this.answer(address, o.keys, cx))
        .when(o.checked !== null, (el) => el.child(div().text_size(14).text_color(o.checked ? t.accent : t.dim).child(o.checked ? "☑" : "☐")))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(13.5).child(o.next ? "Next →" : o.label))
          .when(Boolean(o.desc), (el) => el.child(div().text_size(12).text_color(t.dim).child(o.desc))))))
      .child(div().pt(2).text_size(11.5).text_color(t.dim).child("Or type below: your message drops the question and goes to Claude as a normal reply."));
  }

  composer(t, tab, s, status, address) {
    const imgs = this.attach[tab.id] ?? [];
    // The transcript's model id has no [1m] suffix; usage past 200k means the 1M window.
    const window = s.ctx > (s.window ?? 0) ? 1e6 : s.window;
    const pct = s.ctx && window ? Math.round((100 * s.ctx) / window) : null;
    // What the session runs with: the screen's footer, else the transcript, else the user's defaults.
    const model = (s.model ?? s.argvModel ?? "Opus 5.5 (1M context)").replace(" (1M context)", " (1M)");
    const effort = s.effort ?? "high";
    const mode = MODES.find((m) => m.id === (s.screenMode ?? s.mode ?? "bypassPermissions")) ?? MODES[0];
    const metaItem = (id, label) => div().id(`meta-${id}`).px(5).py(1).rounded(5).cursor_pointer()
      .text_color(this.menu === id ? t.foreground : t.dim).hover((st) => st.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { this.menu = this.menu === id ? null : id; cx.notify(); }).child(`${label} ▾`);
    const options = this.menu === "model" ? MODELS.map((m) => ({ label: m.label, on: m.label === model, pick: m }))
      : this.menu === "effort" ? EFFORTS.map((e) => ({ label: e[0].toUpperCase() + e.slice(1), on: e === effort, pick: e }))
      : this.menu === "mode" ? MODES.map((m) => ({ label: m.label, on: m.id === mode.id, pick: m })) : [];
    const slashItems = this.slashMatches();
    return v_flex().w_full().max_w(COLUMN).px(28).pb(10).gap(6)
      .when(slashItems.length > 0, (el) => el.child(this.slashMenu(t, slashItems)))
      .child(v_flex().w_full().rounded(14).border(1).border_color(t.input).bg(t.surface).px(12).py(8).gap(8)
        .when(imgs.length > 0, (el) => el.child(h_flex().gap(10).pt(6).px(2).children(imgs.map((p, i) =>
          div().id(`att-${i}`).relative().size(64).flex_none()
            .child(div().size(64).rounded(10).overflow_hidden().border(1).border_color(t.border).child(image(imgSrc(p)).size(64)))
            .child(div().id(`att-x-${i}`).absolute().top(-6).right(-6).size(18).rounded(9).bg(t.raised).border(1).border_color(t.border)
              .flex().items_center().justify_center().text_size(11).text_color(t.foreground).cursor_pointer()
              .on_click((_e, cx) => { imgs.splice(i, 1); cx.notify(); }).child("×"))))))
        .child(h_flex().w_full().items_center().gap(10)
          .child(div().id("attach").size(22).flex_none().flex().items_center().justify_center().rounded(6).text_size(17).text_color(t.muted)
            .hover((st) => st.bg(t.hover)).cursor_pointer().tooltip("Attach an image (or paste / drop one)")
            .on_click((_e, cx) => this.pickImage(cx)).child("+"))
          // Enter sends (submit); Cmd+Enter (and Shift+Enter) adds a line. The textarea fires no submit
          // for Cmd+Enter, so the wrapper catches the key (2026-11-01).
          .child(div().flex_1().min_w(0).text_size(14)
            .on_key_down((e, cx) => {
              // The "/" menu takes Up/Down, Enter/Tab (pick) and Esc before the textarea does.
              const items = this.slashMatches();
              if (items.length && ["up", "down", "enter", "tab", "escape"].includes(e.key) && !e.modifiers.shift && !e.modifiers.platform) {
                const sel = Math.min(this.slash.sel, items.length - 1);
                if (e.key === "up" || e.key === "down") {
                  // The highlighted command goes into the box as you move (2026-11-05). set_value fires no
                  // "change", so the menu keeps the list filtered by what was typed.
                  this.slash.sel = (sel + (e.key === "up" ? -1 : 1) + items.length) % items.length;
                  const v = `/${items[this.slash.sel].name}`;
                  this.input.set_value(v);
                  try { this.input.set_selected_range({ start: v.length, end: v.length }); } catch (_) {}
                  if (this.inputTab) this.saveDraft(this.inputTab, v);
                }
                else if (e.key === "escape") this.slash = null;
                else this.pickCommand(items[sel]);
                cx.stop_propagation();
                cx.notify();
                return;
              }
              if (e.key === "enter" && e.modifiers.platform && !e.modifiers.shift) { this.input.replace("\n"); cx.stop_propagation(); }
            })
            .child(Textarea.new(this.input).w_full().bg(t.surface).border(0).p(0)))
          // Stop, as in the Claude desktop app: while Claude works, Esc to the session interrupts it.
          .when(status === "working", (el) => el.child(div().id("stop").size(28).flex_none().flex().items_center().justify_center()
            .rounded(8).cursor_pointer().hover((st) => st.bg(t.hover)).tooltip("Stop Claude (Esc)")
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => this.stop(s, address, cx))
            .child(div().size(14).rounded(3).bg(t.foreground))))))
      .child(h_flex().w_full().gap(6).justify_end().items_center().text_size(11.5).relative()
        .child(metaItem("model", model))
        .child(metaItem("effort", effort[0].toUpperCase() + effort.slice(1)))
        .child(metaItem("mode", mode.label))
        .when(pct !== null, (el) => el.child(div().px(5).text_color(t.dim).child(`${pct}% context`)))
        .when(status === "working", (el) => el.child(div().text_color(t.working).frames(["◐", "◓", "◑", "◒"], 150)))
        .when(options.length > 0, (el) => el.child(v_flex().id("meta-menu").absolute().bottom(24).right(0).w(200).p(4).rounded(8)
          .border(1).border_color(t.border).bg(t.popover).shadow_md()
          .on_mouse_down_out((_e, cx) => { this.menu = null; cx.notify(); })
          .children(options.map((o, i) => h_flex().id(`menu-${i}`).px(8).py(5).rounded(5).text_size(12.5).cursor_pointer()
            .text_color(t.foreground).hover((st) => st.bg(t.hover))
            .on_click((_e, cx) => this.pick(this.menu, o.pick, address, cx))
            .child(div().w(16).text_color(t.accent).child(o.on ? "✓" : ""))
            .child(div().child(o.label)))))));
  }

  // Applies a meta-line choice to the real session. /model and /effort also save themselves as
  // Claude's defaults for new sessions; that's put back, so a pick here only changes this one.
  pick(kind, opt, address, cx) {
    this.menu = null;
    if (this.picking) return; // one at a time: overlapping picks restored each other's settings
    this.picking = true;
    const s = this.session(shownTab()?.id);
    cx.notify();
    cx.spawn(async (cx) => { try {
      if (kind === "mode") {
        let reached = false;
        for (let i = 0; i < MODES.length + 1 && !reached; i++) {     // shift+tab cycles the modes
          const screen = (await hc(["read", address])).stdout;
          this.readFooter(s, screen);
          reached = screen.includes(opt.screen);
          if (!reached) { await hc(["keys", address, "shift+tab"]); await cx.sleep(400); }
        }
        // Bypass is only in the cycle when Claude started with it allowed.
        if (!reached) notify({ title: `This session can't switch to ${opt.label}`, body: "Claude Code only offers it when started with it (e.g. --dangerously-skip-permissions).", level: "warning" });
      } else {
        // /model and /effort also save themselves as the global default: put those keys back once
        // Claude has written them. Only while idle (a queued command could land after the restore),
        // and the file is watched for up to 5 s instead of a fixed wait (review 2026-11-01).
        const path = `${home()}/.claude/settings.json`;
        const before = await readTextFile(path);
        const cmd = kind === "model" ? `/model ${opt.arg}` : `/effort ${opt}`;
        const r = await exec("env", ["-u", "HC_TERMINAL_ID", "hc", "send", "--if", "idle", address, "--", cmd]);
        if (r.code !== 0) { notify({ title: `Couldn't change the ${kind}`, body: (r.stderr || r.stdout || "Claude is busy: try again when it's idle.").trim().slice(0, 300), level: "error" }); return; }
        if (kind === "model") s.model = opt.label; else s.effort = opt;
        let now = before;
        for (let i = 0; i < 17 && now === before; i++) { await cx.sleep(300); now = await readTextFile(path); }
        if (before && now && now !== before) {
          try {
            const old = JSON.parse(before), next = JSON.parse(now);
            for (const k of ["model", "effortLevel", "modelSettings"]) { if (k in old) next[k] = old[k]; else delete next[k]; }
            await writeTextFile(path, `${JSON.stringify(next, null, 2)}\n`, now);
          } catch (_) { /* not JSON, or changed meanwhile: leave it */ }
        }
      }
    } finally { this.picking = false; cx.notify(); } });
  }

  render(cx) {
    const t = theme();
    const tab = shownTab();
    const pane = tab && claudePane(tab.id);
    const root = v_flex().id("chat-root").size_full().bg(t.background).text_color(t.foreground)
      .on_drop((e, cx) => this.dropFiles(e.paths, cx))
      // A click anywhere sends the keyboard to the composer, except on text: a code block's editor
      // needs the focus to select, and ⌘C copies a selection only from where the focus is
      // (2026-11-02). Inner handlers run first and set keepFocus.
      .on_mouse_down("left", () => { if (this.keepFocus) this.keepFocus = false; else this.input.focus(); });
    if (!tab || !pane) {
      return root.items_center().justify_center().gap(10).text_size(14).text_color(t.muted)
        .child("No Claude Code session in this tab.")
        .when(Boolean(tab), (el) => el.child(div().id("go-terminal").px(12).py(5).rounded(7).border(1).border_color(t.input)
          .cursor_pointer().on_click(() => this.toTerminal(tab, null)).child("Show Terminal")));
    }
    const s = this.session(tab.id), status = statusOf(pane, s);
    const switched = this.renderTab !== tab.id;
    if (switched) { this.renderTab = tab.id; this.shown = ROWS; }
    // A tab just shown is brought up to date now, not at the next tick (up to 0.7 s later).
    if ((switched || !s.loaded) && !this.busy) cx.spawn(async (cx) => this.tick(cx));
    // While Claude works its latest text may still be followed by a tool call: drawn as interim.
    const rows = [...(status === "working" ? s.blocks.filter((b) => !b.live).map((b) => b.role === "live" ? { ...b, role: "interim" } : b) : s.blocks), ...s.pending.filter((p) => !p.queued).map((p, i) => ({ key: `p:${i}:${p.text.slice(0, 20)}`, kind: "user", text: p.text, imgs: p.imgs, pending: true, waiting: p.waiting }))];
    // Restore this tab's draft once per tab switch, cursor at its end (left at 0, typing went in
    // front of the old text), out of render: set_selected_range throws inside
    // render/layout (also in a task spawned from render, which starts at once). It used to throw
    // before inputTab was set, so every render restored the stale draft again and wiped what the user
    // was typing every few seconds, and typing was never saved (2026-11-01). Now: wait a tick, set
    // inputTab first, and guard against renders scheduling more restores meanwhile.
    if (this.inputTab !== tab.id && this.restoring !== tab.id) {
      const id = tab.id;
      this.restoring = id;
      cx.spawn(async (cx) => {
        await cx.sleep(0);
        this.restoring = null;
        if (shownTab()?.id !== id) return;
        const draft = this.drafts[id] ?? "";
        this.inputTab = null;            // the value below is the draft itself, not typing
        this.input.set_value(draft);
        this.inputTab = id;
        try { this.input.set_selected_range({ start: draft.length, end: draft.length }); } catch (_) {}
      });
    }
    // The keyboard goes to the composer whenever the chat shows (else it stays with the hidden
    // terminal, and typing would go there): on a tab switch, on showing, and on any click in it.
    const shown = this.visible(tab);
    if (shown && (this.focusedTab !== tab.id || !this.wasShown)) { this.focusedTab = tab.id; this.input.focus(); }
    this.wasShown = shown;

    // Our own viewport, newest at the bottom (2026-11-01). A column-reverse scroll area put the
    // overflow above the top edge, where GPUI can't scroll: the bar sat at the top and scrolling
    // showed blank space. No scroll area here can be moved from code (a list ignores track_scroll),
    // so, as gpui-kit's docs advise for a custom viewport, the content hangs from the bottom of a
    // clipped box and the wheel moves it: scrollY = pixels scrolled up from the newest message.
    // Only the last `this.shown` rows are built; "Show earlier" adds more at the top.
    const recent = rows.slice(-this.shown);
    const lastKey = recent.length ? recent[recent.length - 1].key : null;
    if (switched || this.scrollTab !== tab.id) { this.scrollTab = tab.id; this.scrollY = 0; }
    const maxY = Math.max(0, (this.contentH ?? 0) - (this.viewH ?? 0));
    if (this.scrollY > maxY) this.scrollY = maxY;
    const body = rows.length
      ? v_flex().id("chat-body").relative().flex_1().min_h(0).w_full().overflow_hidden()
        .on_size_change((size) => { this.viewH = size.height; this.viewW = size.width; })
        .on_scroll_wheel((e, cx) => {
          const max = Math.max(0, (this.contentH ?? 0) - (this.viewH ?? 0));
          const y = Math.min(max, Math.max(0, (this.scrollY ?? 0) + e.delta.y));
          if (y !== this.scrollY) { this.scrollY = y; cx.notify(); }
          // Scrolling up near the top loads older messages, no button press (asked 2026-11-04).
          // The content hangs from the bottom, so rows added above leave the reader's place alone.
          if (e.delta.y > 0 && max - y < 600 && (rows.length > this.shown || s.head > 0)) this.showEarlier(s, rows.length, cx);
        })
        .child(v_flex().id("chat-content").absolute().left(0).right(0).bottom(-(this.scrollY ?? 0))
          .on_size_change((size, cx) => {
            // New messages at the bottom while reading older ones: keep the reader's place.
            const grew = size.height - (this.contentH ?? size.height);
            if (grew > 0 && this.scrollY > 0 && lastKey !== this.lastKey) this.scrollY += grew;
            this.lastKey = lastKey; this.contentH = size.height; cx.notify();
          })
          .when(rows.length > this.shown || s.head > 0, (el) => el.child(h_flex().w_full().justify_center().py(12).flex_none()
            .child(div().id("earlier").px(12).py(4).rounded(7).text_size(12.5).text_color(t.muted).hover((st) => st.bg(t.hover))
              .cursor_pointer().on_click((_e, cx) => this.showEarlier(s, rows.length, cx))
              .child(s.loadingEarlier ? "Loading earlier messages…" : "Show earlier messages"))))
          .children(recent.map((b) => this.clickable(t, b)))
          .child(div().flex_none().h(16)))
        // A thin bar showing where the view is; the wheel scrolls.
        .when(maxY > 0, (el) => {
          const h = this.viewH, total = this.contentH, thumb = Math.max(24, (h * h) / total);
          const top = ((total - h - this.scrollY) / Math.max(1, total - h)) * (h - thumb);
          // A full-width row pinned to the right, like the ↓ button (a lone right(2) box wasn't drawn).
          return el.child(h_flex().absolute().top(top).left(0).right(0).justify_end().pr(2)
            .child(div().id("chat-thumb").w(6).h(thumb).rounded(3).bg(t.muted)));
        })
        .when((this.scrollY ?? 0) > 200, (el) => el.child(h_flex().absolute().bottom(12).left(0).right(0).justify_center()
          .child(div().id("to-latest").size(30).rounded(15).flex().items_center().justify_center().bg(t.raised).border(1).border_color(t.border)
            .cursor_pointer().tooltip("Latest messages").on_click((_e, cx) => { this.scrollY = 0; cx.notify(); }).child("↓"))))
      : v_flex().flex_1().items_center().justify_center().text_size(15).text_color(t.muted)
        .child(s.loaded ? "What can Claude help with?" : "Loading conversation…");

    const el = root
      // A background job session saves almost none of the replies written between tool calls,
      // so Chat can't show them: say so, and send the tab to Terminal unless the user picked Chat.
      .when(Boolean(s.bg), (el) => el.child(h_flex().w_full().justify_center().pt(8)
        .child(h_flex().max_w(COLUMN).mx(28).px(12).py(6).gap(10).items_center().rounded(8).border(1).border_color(t.border)
          .text_size(12.5).text_color(t.muted)
          .child(div().flex_1().child("Background job session: Claude Code doesn't save the messages it writes between tool calls, so some replies are missing here."))
          .child(div().id("bg-terminal").px(10).py(3).rounded(6).border(1).border_color(t.input).cursor_pointer()
            .hover((st) => st.bg(t.hover)).on_click(() => this.toTerminal(tab, null)).child("Show Terminal")))))
      .child(body)
      .child(v_flex().w_full().items_center().gap(8).pt(6)
        .when(status === "blocked", (el) => el.child(div().w_full().max_w(COLUMN).px(28).child(this.promptCard(t, tab, pane.terminal, s))))
        // The Claude Code logo and Claude Code's own spinner words (readFooter), like the terminal.
        .when(status === "working", (el) => el.child(h_flex().w_full().max_w(COLUMN).px(28).gap(8).items_center().text_size(13)
          .child(image("icons/claude.svg").size(16).flex_none().loop("opacity", { from: 0.55, to: 1, period: 1400 }))
          .child(div().text_color("#d97757").child(s.spin?.verb ?? "Working…"))
          .when(Boolean(s.spin?.info), (r) => r.child(div().text_color(t.dim).truncate().child(`(${s.spin.info})`)))))
        .children([this.tasksCard(t, s, status)].filter(Boolean))
        .when(s.pending.some((p) => p.queued), (el) => el.child(this.queued(t, s, pane.terminal)))
        .child(this.composer(t, tab, s, status, pane.terminal)));
    return el;
  }
}
