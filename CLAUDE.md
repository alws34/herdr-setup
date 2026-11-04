# CLAUDE.md: Herdr app setup

This folder is Alon's personal setup of the **Herdr desktop app** (herdr-app 0.1.11). The
app redraws itself live from the files here. The whole window is layouts (JSON) plus mods
(JavaScript on gpui-kit, drawn natively, with no DOM). See `ARCHITECTURE.md` for how the
pieces fit together.

## Read first

- `AGENTS.md` is the app's manual. **The app rewrites it on every start**, so never edit
  it; put durable notes here or in `ARCHITECTURE.md`.
- `herdr.d.ts` and `gpui-kit.d.ts` are the API truth. The app also rewrites these, so
  don't edit them either.

## Never do these

- **Never edit Herdr's shipped layouts or mods** (every name in `installed.json`: `main`,
  `files`, `tabs`, `spaces`, `agents`, `changes`, `pane`, `workspace-chrome`, ...). On the
  next start the app moves an edited one aside as `<name>-edited`. Clone it first:
  `herdr-app do mod.clone '{"name":"files","as":"my-files"}'`.
- **Never edit `layouts/.state/`, `view.json`, `shared.json`, `installed.json` or `frame/`.**
  The app writes them.
- **Never call a mod change done without `herdr-app check ~/.config/herdr-app/mods/<name>`**
  passing. After a layout or `keys.json` edit, look for `<name>.error` and run
  `herdr-app status` (its `errors`).
- **Don't close overlays or windows you didn't open** (the ClickUp board and the like).
  The user is using them.

## Git

This folder is a git repo, pushed to the private `https://github.com/alws34/herdr-setup`
(branch `main`, HTTPS with the keychain's GitHub login; this Mac has no SSH key GitHub knows).

- `.gitignore` keeps out runtime data (`data/`: chat screenshots, browser profiles and
  cookies), secrets (`clickup-board.json` holds the ClickUp token), state the app rewrites
  (`shared.json`, `view.json`, `layouts/.state/`, ...) and `node_modules/`.
- Before every commit, check `git status` for new files that hold tokens, cookies or keys.
  Never commit them, and never print their values.
- Commit when a change is done and checked, with a message saying what and why. Push only
  when the user asks.

## Several sessions edit this folder at once

The user runs many Claude sessions on this setup in parallel, all started from other repos'
folders, so this file only loads when a session's working folder is here. Two sessions
writing the same file means the last write wins.

- Read a file right before editing it, and edit with exact replacements (Edit tool, or a
  script that asserts each old string occurs once), never by rewriting from memory.
- For `layouts/vscode.json`, transform it with `jq` and write it only if it hasn't changed
  since you read it (`cmp` against a copy).
- Back up what you touch to your job's tmp folder first.
- `vsections` rewrites the `sections-body` subtree itself through `layout.set`; edit
  outside that subtree, or change `vsections`'s SECTIONS list.

## Working agreements

- **Always use ponytail when writing code here** (the `ponytail:ponytail` skill, level
  full): the smallest change that fully works, reuse before writing, delete before adding.
  Subagents that write code here get the same instruction.
- **Mocks and UI design:** use the `design-taste-frontend` skill (taste-skill) for mockups, and
  `emil-design-eng` for UI polish and motion. Both are installed in `~/.claude/skills`.
- The main layout is **`vscode`**. Other layouts (`glass-code`, `glass`, `bercail`,
  `main-symbols`) share some mods, so a mod change must keep working where a node it
  looks for (`search-panel`, `files-panel`, `sections`) is missing.
- Mods can't import each other's code. Small helpers get copied, with a comment naming
  where the other copy lives (for example `unroll()` in `tabs-vs` and `session-files`).
- Mods talk through `shared(key)` / `setShared(key, value)`. When adding a key, add it to
  the table in `ARCHITECTURE.md`.
- `layout()` changes don't redraw mods, so the vscode mods poll `layout()` on a 400 ms to
  1 s timer. Keep that cheap. Animate with `.transition()` / `.frames()` / `.loop()`, never
  with timers.
- See a change with `herdr-app shot /path/x.png`; it captures the app even when covered, but
  it is the last frame drawn, so it can't show an animation. `screencapture -x` shows the
  real screen (only when Herdr is in front).
- Test, don't guess: the user prefers a change proven on screen. Sending keys or mouse
  events to the window needs their OK, and never while they are typing.
- `layout.set` on a personal layout deletes `layouts/.state/<layout>.json` (sizes and hidden
  flags from clicks); merge that file's `nodes` into the new tree first (`tabs-vs` syncTools).
- Known Herdr bug: `Textarea` and `Input` (the chat's box, the command palette) draw no
  selection highlight. A layout or theme `selection` color can't fix it; report it with
  `herdr-app feedback`.
- Escape hatch if a layout breaks the window: `ctrl-alt-shift-escape`.
- Style: one mod per idea. Start each `main.js` with a comment saying what it is and *why*
  any non-obvious mechanism exists (see `vsections/main.js`). Use theme colors (`theme()`),
  never hex, so light and dark both work.
