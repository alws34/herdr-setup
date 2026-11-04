# Architecture: the `vscode` layout

How Alon's Herdr window is put together. For the app's own model (spaces, tabs, panes,
commands, mod API), see `AGENTS.md`. This file covers only what was built here.

## Two programs

- **herdr-core (`hc`)** runs every terminal and agent and keeps them alive across window
  restarts.
- **herdr-app** is the window. It draws `layouts/<name>.json`, whose blocks hold mods
  (`mods/<name>/main.js`), the active tab's terminals (`{ "tab": "active" }`), or a
  single terminal.

## The window (`layouts/vscode.json`)

```
r0f…  row ─────────────────────────────────────────────────────────────────────────────
├─ root  column  (theme vscode/graphite, own title bar: titlebar "none")
│  ├─ title  row 35px ─ title-bar: vs-chrome{role:title} │ sysmon-bar: sysmon{bar} │ usage: quota
│  │                    │ title-clock: vs-chrome{role:clock} (optional mods/vs-chrome/config.json)
│  ├─ body  row
│  │  ├─ activity      vs-chrome{role:activity}   48px   the icon column
│  │  ├─ files-panel   files-plus{session}        300px  hidden: full-height Explorer
│  │  ├─ search-panel  term-search                300px  hidden: full-height Search
│  │  ├─ md-panel      markdown-browser{session}  300px  hidden: Markdown list (from tabs-vs)
│  │  ├─ sections      column 284px               the "vertical tabs" side bar
│  │  │  ├─ sections-bar   vsections{role:bar}     "EXPLORER  ⋯"
│  │  │  └─ sections-body  groups of sec-<id>-head (vsections) + sec-<id>-body (a mod)
│  │  │      Spaces · Spaces Status · Changes · Graph · Agents · Blueprint · Servers ·
│  │  │      Utilization · Extensions
│  │  ├─ editor  column
│  │  │  ├─ tabs        tabs-vs        32px   row 1: sessions (Herdr tabs) + top-right buttons
│  │  │  ├─ file-tabs   session-files  32px   row 2: the shown session's open files
│  │  │  ├─ work  stack: main (the tab's terminals, pane header mod "pane")
│  │  │  │              │ file-view (editor{session}) │ chat (chat: the session as a chat)
│  │  │  └─ work-tool  column, only while a tool is moved to the main area (⤢ or a header
│  │  │                drag): that tool's head + body; `work` is hidden meanwhile
│  │  └─ tools  column 615px hidden: right-hand tools, each a tool-header head + body:
│  │            side-chat · browser (Electron shell) · terminal · canvases: the list, or
│  │            the open canvas it shows (browser{tab, session, url, marker: 1}, page only)
│  ├─ status          usage-bar                24px
│  └─ copy-on-select  copy-on-select           0px (behavior only)
```

## Who toggles what

| Control | Does |
|---|---|
| Activity bar Explorer / Search icons (`vs-chrome`) | `layout.toggle` `files-panel` / `search-panel`; the icon is lit while shown |
| Other activity icons | shared `vsections.open {id, toggle}`: `vsections`' bar shows/hides that section |
| Title bar command box, tab bar "Search", ⌘⇧F (`tabs-vs.search`) | show `search-panel`, then focus its box (`term-search.focus`, after 150 ms so a first-time mod has started) |
| Tab bar "Files", ⌘⇧E | toggle `files-panel` |
| Tab bar "Markdown" | toggle `md-panel` |
| Tab bar "Explorer", ⌘B, title bar panel icon | toggle `sections` |

`tabs-vs` falls back to the Search *section* when a layout has no `search-panel`
(`glass-code`). `vs-chrome` does the same for any item without a panel.

## Files in the main window

1. A click in Explorer (`files-plus{session}`) or the Markdown list
   (`markdown-browser{session}`) adds the file to shared `session-files[<tab id>]` and
   makes it active.
2. `session-files` draws that session's files as row 2 and points the `work` stack at
   `file-view` (a file is active) or `main` (Terminal). Switching sessions switches files.
3. `editor{session}` shows the active file: a code editor that follows the disk while clean,
   saves with ⌘S as a compare-and-swap, and reports unsaved files in `session-files.dirty`.
   Markdown gets **Code / Split / Preview**, VS Code style (default Split, ⌘⇧V toggles
   Preview).
4. The Markdown list's right-click "Preview in new pane" still opens a rendered-only
   `markdown-browser{file}` pane.

## Tab animation

Session tabs (`tabs-vs`) and file tabs (`session-files`) unroll open instead of popping:
each sits in a wrapper that starts at width 0 and opacity 0, measures its content
(`on_size_change`), then `transition("width", 260ms ease-out)` slides it to that width.
Only the first appearance animates; closing is instant. The two copies of `unroll()` must
stay in step, because mods can't import each other's code.

## The side bar sections (`vsections`)

- Each section is a header block and a body block. Herdr's dividers resize only adjacent
  siblings, so open sections each get a group `grp-<id>`, and collapsed or hidden ones ride
  inside the nearest open group. `vsections` rebuilds `sections-body` with `layout.set`
  whenever that shape changes.
- State is per layout in shared `vsections.spaces` (shown, collapsed, size), keyed
  `<layout>|global`; older per-space entries there are no longer read. Drag order lives in `vsections.order`.
- A section whose head isn't in the layout is skipped, so removing a section from the
  layout is enough to retire it.

## Shared-state keys (the contract between mods)

| Key | Writer → reader | Shape / meaning |
|---|---|---|
| `session-files` | files-plus, markdown-browser, session-files, editor | `{ [tabId]: { files: [{path, on}], active: path\|null } }` |
| `session-files.dirty` | editor → session-files | paths with unsaved changes |
| `editor.open` | files-plus{editor} → editor (pane mode) | `{path, on, tab, at}` |
| `vsections.open` | vs-chrome, tabs-vs → vsections bar | `{id, toggle, at}` |
| `vsections.spaces` / `.order` / `.drag` | vsections | per-layout section state / order / header drag |
| `term-search.focus` | vs-chrome, tabs-vs → term-search | timestamp; a change focuses the box |
| `markdown-browser.slots` / `.show` / `.last` / `.menu` | markdown-browser | rendered preview panes |
| `quota.data` / `.error` / `.refresh` / `.options` | quota | Claude usage windows |
| `usage-bar.snapshot` / `.providers` / `.countdowns` | usage-bar | status-bar usage chips |
| `chat.view` | chat, session-files, session-menu | `{ [tabId]: "chat"\|"terminal" }` |
| `tools.open` | tabs-vs | `{ [tabId]: {sideChat, browser, terminal, canvases, canvas: [{id, url, title}], view, main} }`: the right-hand tools per tab; `canvas` the open canvases, `view` the one Canvases shows (null: the list), `main` the tool moved to the main area |
| `tools.close` | tool-header → tabs-vs | `{tab, tool, at}` |
| `tools.move` | tool-header → tabs-vs | `{tab, tool, at}`: move that tool to the main area, or back |
| `tools.canvas` | canvases, tool-header → tabs-vs | `{tab, at}` plus `{url, title}` (open and show that claude.ai canvas), `{view: id\|null}` (show an open one, or the list) or `{close: id}` |
| `agents.sort` | agents | agent list order |
| `sidebar.width` / `.collapsed` | bercail-agents | bercail side bar |
| `git-graph.changed` | git-graph | graph refresh |
| `spaces-tree.open` / `.pinned` / `.unread` | spaces-tree, session-menu | expanded space ids / pinned tab ids (listed first) / tab ids marked unread (cleared when shown again) |
| `clickup-board.view` / `.project` | clickup-board | `{source: "mine"\|listId, mode: "board"\|"list", open: {id: bool}}` / My-tasks list chip |
| `linear-board.snapshot` / `.project` | linear-board | issues / project chip |
| `clickup-board-agent.last` / `.models`, `linear-board-agent.last` / `.models` | *-board-agent | remembered agent choices |

## Claude sessions: chat, canvases, sidebar

- **Which transcript a tab's Claude writes:** its pane's process → `~/.claude/sessions/<pid>.json`
  (session id) plus the terminal's title (the session title) → `find.sh`. Two copies,
  `mods/chat/find.sh` and `mods/canvases/find.sh`, kept in step. A fresh session has an id but
  no transcript until its first message: `find.sh` returns nothing then, and the chat looks
  again until it has the session's own file. Without that, a new tab latched onto the folder's
  newest transcript and showed another session (2026-11-04).
- **Chat history:** only the newest rows are built; scrolling up near the top loads more
  (the "Show earlier messages" button does the same).
- **Waiting for you:** the status dot of a `done`/`blocked` session breathes (`.loop("opacity")`)
  in `spaces-tree` and `tabs-vs`.
- **Tab names:** `spaces-tree` renames a Claude tab still under a default name ("Claude Code",
  a number) to its terminal title, Claude's session title, once it has one. Names the person
  gave are left alone.
- **Right-hand tools:** `tabs-vs` rebuilds the tools column with `layout.set`, merging the
  click state from `layouts/.state/vscode.json` first so dragged sizes stay. An open canvas is
  an Electron window over its pane (`mods/browser/shell`); it keeps the pane's fixed edge when
  a divider moves, leaves a 4 px grip for the divider, and hides when Canvases is closed or
  another canvas is shown.

## Other layouts

`cmd-shift-l` cycles through them. `glass-code` (Explorer section: the `explorer` mod) is the predecessor of `vscode` and
shares `tabs-vs`, `vsections` and `term-search`. `glass`, `bercail` and `main-symbols`
come from herdr.dev layouts or mods. `main`, `terminals` and `win98` are shipped and
read-only.

## Other mods worth knowing

`canvases` (the claude.ai artifacts the shown space's Claude sessions published, from their
transcripts; a click shows that canvas in place of the list, page only, in its own browser whose
claude.ai login all canvas browsers share through `~/.local/state/herdr-browser/claude-login.bin`,
keychain-encrypted, Cloudflare's cookies left out, and taken from the Claude desktop app's cookie
store when it has no claude.ai session (macOS asks once to allow reading "Claude Safe Storage");
no DevTools port, which Cloudflare's check refused.
A Claude session sees a canvas through its shell's control port instead:
`curl -s "localhost:$(cat ~/.local/state/herdr-browser/<tab>.cv-<id>/shell.port)/shot?out=/tmp/canvas.png"`,
or `/text` for its title, URL and text),
`blueprint` (an agent's Mermaid flow), `insights` (Claude Code usage dashboard, opened as a
tab), `extensions` (Claude plugins, skills, MCP), `customize` (the Claude desktop app's Customize page as a
tab, from vs-chrome's activity bar: skills, connectors, plugins, Yours and Discover; real data from Claude Code's CLI
and its catalog caches, CLI helpers copied from `extensions`, whose `scan.sh` it runs), `clickup-board` (ClickUp managed in place: spaces/lists sidebar, Board and List views,
drag a card to change status, task panel editing everything over the REST API; only ↗ opens the
browser) / `linear-board` (+ `*-agent`: start an agent on a task), `forge-*` (GitLab/GitHub panels), `html-viewer`
(headless-Chrome page view), `sysmon`, `servers`, `git-graph`, `spaces-tree` /
`spaces-glow` (clones of `spaces`; `session-menu` is spaces-tree's right-click menu for spaces and sessions), `copy-on-select`.
