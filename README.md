# herdr-setup

Alon's setup of the [Herdr](https://herdr.dev) desktop app (herdr-app 0.1.12): a VS Code-style
window for running many Claude Code sessions side by side, each also readable as a chat.
This repo is the app's home folder, `~/.config/herdr-app`. Herdr redraws itself live from these files.

The main layout is `vscode`, in the Ember theme (amber, light and dark):

- **Sidebar:** spaces and their sessions. A session asking you something has a breathing dot,
  Claude tabs name themselves after their session, and sessions can be dragged to reorder.
- **Main area:** a session as its terminal or as a chat, plus file tabs with an editor.
- **Right-hand tools, per session:** side chat, a browser, a terminal, and Canvases (the
  claude.ai pages the session published, opened in place).
- **Title and status bars:** system load, Claude usage and quota.

## What's here

| Path | What |
|---|---|
| `layouts/` | Window layouts. `vscode.json` is the main one; `cmd-shift-l` cycles through them |
| `themes/` | Ember (dark and light) and the other themes the layouts use |
| `mods/` | The window's parts, in JavaScript on gpui-kit (drawn natively, no DOM). Herdr ships some; the rest are made here |
| `keys.json` | Keyboard shortcuts |
| `settings.json` | Zoom, font size, sounds |
| `backgrounds/`, `icons/` | Images the layouts and mods use |
| `CLAUDE.md` | Rules for Claude sessions editing this folder |
| `ARCHITECTURE.md` | How the `vscode` layout fits together, and the shared-state keys mods talk through |
| `AGENTS.md`, `*.d.ts`, `frame/` | Herdr's own manual and API types. The app rewrites them; don't edit |

The main mods made here:

| Mods | Do |
|---|---|
| `vs-chrome`, `vsections`, `tabs-vs`, `session-files`, `tool-header` | Title bar, activity bar, side bar sections, session and file tabs, tool headers |
| `spaces-tree`, `session-menu` | Spaces with their sessions; right-click menu |
| `chat`, `side-chat` | A Claude Code session as a chat, read from its transcript |
| `canvases`, `browser` | Published claude.ai pages, and the Electron browser that shows them |
| `files-plus`, `editor`, `markdown-browser`, `term-search` | Explorer, code editor, Markdown list and preview, search |
| `changes-vs`, `git-graph`, `blueprint`, `servers`, `sysmon`, `quota`, `usage-bar` | Git changes and graph, an agent's flow, servers, system load, Claude usage |
| `clickup-board`, `linear-board`, `forge-*` | ClickUp, Linear, GitLab and GitHub panels |
| `insights`, `extensions`, `customize` | Claude Code usage, plugins and skills |

## Set up on a new Mac

1. Install Herdr, start it once, then quit it.
2. Put this repo in its place:
   ```sh
   mv ~/.config/herdr-app ~/.config/herdr-app.orig
   git clone git@github.com:alws34/herdr-setup.git ~/.config/herdr-app
   ```
3. Install the browser's Electron, used by the Chrome tool and Canvases:
   ```sh
   cd ~/.config/herdr-app/mods/browser/shell && npm install
   ```
4. For the ClickUp board, put a personal API token in `~/.config/herdr-app/clickup-board.json`
   as `{"token": "pk_..."}`.
5. Start Herdr and pick the `vscode` layout (`cmd-shift-l`).

The first canvas sign-in asks macOS for the "Claude Safe Storage" keychain item, to reuse the
Claude desktop app's claude.ai login; Always Allow avoids repeats.

## Not in git

`.gitignore` keeps these out:

- `data/`: chat screenshots, browser profiles and cookies.
- `clickup-board.json`: holds the ClickUp token.
- State the app rewrites: `shared.json`, `view.json`, `layouts/.state/` and others.
- `node_modules/`.

Never commit tokens, cookies or keys.

## Changing it

Read `CLAUDE.md` first. In short:

- Don't edit Herdr's shipped mods or layouts (the names in `installed.json`); clone them instead.
- After changing a mod, run `herdr-app check ~/.config/herdr-app/mods/<name>`.
- `herdr-app status` shows errors; `herdr-app shot x.png` saves the window's last frame.
- If a layout breaks the window, `ctrl-alt-shift-escape` gets you out.
