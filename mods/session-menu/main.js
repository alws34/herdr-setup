// Right-click menus for spaces-tree's rows, in the look of the shipped `menu` (which has fixed
// items and can't be edited). spaces-tree opens it as a popup with props
// { kind: "session", space, tab } for a session (tab) row, or { kind: "space", space } for a space.
// ↑/↓ move, Enter or → runs (or opens a submenu), ← goes back, Esc closes, a letter runs its item.
// A submenu (›) replaces the list in place with a "Back" row: a popup can't open a flyout beside it.
// What spaces-tree draws from here is shared state: spaces-tree.pinned / spaces-tree.unread
// (tab ids) and spaces-tree.open (expanded space ids).
// A Claude tab's session id: its terminal's foreground pid -> ~/.claude/sessions/<pid>.json,
// which Claude Code writes for every running process. Fork and "Open in › Claude" need it.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, spaces, panes, layout, shared, setShared, exec, hc } from "herdr";

const PINNED = "spaces-tree.pinned", UNREAD = "spaces-tree.unread", OPEN = "spaces-tree.open";
const CLAUDE = ["claude"];
const SEP = { sep: true };
const isClaude = (p) => p.program?.key === "claude" || p.app === "claude-code";
const toggleIn = (key, id) => {
  const list = shared(key) ?? [];
  setShared(key, list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
};
const icon = (name) => `mods/workspace-chrome/${name}.svg`;

// Same as spaces-tree's find() (mods can't share code).
function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Where a space is now, and its git checkout: copied from the shipped `menu`.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

async function claudeSession(address, on) {
  const r = await hc(["get", address, "--json"]);
  const pid = r.code === 0 ? Number(JSON.parse(r.stdout).foreground?.pid) : 0;
  if (!pid) return null;
  const s = await exec("sh", ["-c", `cat ~/.claude/sessions/${pid}.json`], { on });
  return s.code === 0 ? JSON.parse(s.stdout).sessionId ?? null : null;
}

export default class SessionMenu extends View {
  init(_props, cx) {
    this.at = -1;
    this.sub = null; // label of the open submenu
    this.git = null;
    this.session = null; // the Claude session id of a session row
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props() ?? {};
    const sp = spaces().find((s) => s.id === p.space);
    if (!sp) return;
    if (p.kind === "space") {
      cx.spawn(async (cx) => {
        this.git = await checkout(place(sp), sp.machine).catch(() => null);
        cx.notify();
      });
    } else {
      const claude = panes().find((x) => x.tab === p.tab && x.terminal && isClaude(x));
      if (claude) cx.spawn(async (cx) => {
        this.session = await claudeSession(claude.terminal, sp.machine).catch(() => null);
        cx.notify();
      });
    }
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  confirm(title, detail, name, args) {
    this.close();
    openOverlay({ mod: "confirm", kind: "dialog", width: 400, height: 170, props: { title, detail, command: { name, args } } });
  }

  sessionItems() {
    const p = props() ?? {};
    const sp = spaces().find((s) => s.id === p.space);
    const tab = sp?.tabs.find((x) => x.id === p.tab);
    if (!tab) return [];
    const mine = panes().filter((x) => x.tab === tab.id);
    const claude = mine.find((x) => x.terminal && isClaude(x));
    const cwd = (claude ?? mine.find((x) => x.cwd))?.cwd || sp.folder;
    const local = !sp.machine;
    const hasChat = Boolean(claude) && Boolean(find(layout(), "work")?.children?.some((c) => c.id === "chat"));
    const id = this.session;
    // session-files (vscode layout) points the "work" stack at the tab's chat or terminal from
    // shared "chat.view", unless a file of that tab is active.
    const show = (view) => {
      setShared("chat.view", { ...(shared("chat.view") ?? {}), [tab.id]: view });
      const files = shared("session-files") ?? {};
      if (files[tab.id]?.active) setShared("session-files", { ...files, [tab.id]: { ...files[tab.id], active: null } });
      run("space.select", { id: sp.id });
      run("tab.select", { id: tab.id });
    };
    const pinned = (shared(PINNED) ?? []).includes(tab.id);
    const unread = (shared(UNREAD) ?? []).includes(tab.id);
    return [
      { label: "Open in", icon: icon("panel-right"), sub: () => [
        { label: "Chat", icon: icon("file-text"), disabled: !hasChat, run: () => show("chat") },
        { label: "Terminal", icon: icon("terminal"), run: () => show("terminal") },
        { label: "Finder", icon: icon("folder"), disabled: !local, run: () => exec("open", [cwd]) },
        { label: "Claude desktop app", image: "icons/claude.svg", disabled: !local || !id, run: () => exec("open", [`claude://resume?session=${id}`]) },
      ] },
      { label: pinned ? "Unpin" : "Pin", icon: icon(pinned ? "pin-off" : "pin"), key: "P", run: () => toggleIn(PINNED, tab.id) },
      { label: unread ? "Mark as read" : "Mark as unread", icon: icon("circle-check"), key: "U", run: () => toggleIn(UNREAD, tab.id) },
      { label: "Rename", icon: icon("square-pen"), key: "R", run: () => run("tab.rename", { id: tab.id }) },
      { label: "Fork", icon: icon("git-branch"), key: "F", disabled: !id,
        run: () => run("tab.new", { space: sp.id, folder: cwd, argv: ["claude", "--resume", id, "--fork-session"] }) },
      // Herdr has no command that moves a tab to another space (tab.move stays in its space).
      { label: "Move to section", icon: icon("folder"), sub: () => [], disabled: true },
      SEP,
      { label: "Archive", icon: icon("archive"), key: "A", run: () => run("tab.settle", { id: tab.id }) },
      { label: "Delete", icon: icon("x"), key: "D", danger: true,
        confirm: () => this.confirm(`Delete "${tab.name}"?`, "Ends its terminals. A Claude transcript stays on disk (claude --resume).", "tab.close", { id: tab.id, confirmed: true }) },
    ];
  }

  spaceItems() {
    const sp = spaces().find((s) => s.id === props()?.space);
    if (!sp) return [];
    const id = sp.id;
    const all = spaces();
    const same = all.filter((s) => (s.machine ?? null) === (sp.machine ?? null));
    const k = same.findIndex((s) => s.id === id);
    const prev = same[k - 1], next = same[k + 1];
    const open = new Set(shared(OPEN) ?? []);
    const live = sp.tabs.filter((t) => !t.settled);
    const settled = sp.tabs.filter((t) => t.settled);
    const worktree = (action) => () => {
      this.close();
      openOverlay({ mod: "worktree", kind: "dialog", ...(action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: { space: id, action } });
    };
    return [
      { label: "New session", icon: icon("plus"), run: () => run("tab.new", { space: id, argv: CLAUDE }) },
      { label: "Rename", icon: icon("square-pen"), run: () => run("space.rename", { id }) },
      ...(this.git ? [{ label: "New worktree", icon: icon("git-branch"), confirm: worktree("new") }, { label: "Open worktree", icon: icon("git-branch"), confirm: worktree("open") }] : []),
      ...(this.git === "linked" ? [{ label: "Remove worktree", icon: icon("git-branch"), confirm: worktree("remove") }] : []),
      // No Herdr equivalent of the Claude app's environments.
      { label: "Save as environment", icon: icon("layers"), disabled: true },
      ...(prev ? [{ label: "Move up", icon: icon("chevron-left"), run: () => run("space.move", { id, index: prev.index }) }] : []),
      ...(next ? [{ label: "Move down", icon: icon("chevron-right"), run: () => run("space.move", { id, index: next.index }) }] : []),
      SEP,
      // spaces-tree has no multi-select.
      { label: "Select all", icon: icon("check"), disabled: true },
      SEP,
      { label: "Collapse all", icon: icon("minus"), disabled: !all.some((s) => open.has(s.id)), run: () => setShared(OPEN, []) },
      { label: "Expand all", icon: icon("plus"), disabled: all.every((s) => open.has(s.id)), run: () => setShared(OPEN, all.map((s) => s.id)) },
      SEP,
      { label: `Archive all (${live.length})`, icon: icon("archive"), disabled: !live.length, run: () => live.forEach((t) => run("tab.settle", { id: t.id })) },
      ...(settled.length ? [{ label: `Restore archived (${settled.length})`, icon: icon("archive"), run: () => settled.forEach((t) => run("tab.unsettle", { id: t.id })) }] : []),
      // A space closes with its last tab, so deleting every session is closing the space.
      { label: `Delete all sessions (${sp.tabs.length})`, icon: icon("x"), danger: true,
        confirm: () => this.confirm(`Delete all ${sp.tabs.length} sessions in "${sp.name}"?`, "Ends every terminal in it and closes the space. Claude transcripts stay on disk.", "space.close", { id, confirmed: true }) },
      { label: "Close space", icon: icon("x"), run: () => run("space.close", { id }) },
    ];
  }

  list() {
    const top = props()?.kind === "space" ? this.spaceItems() : this.sessionItems();
    const parent = this.sub && top.find((it) => it.label === this.sub);
    return parent ? [{ label: "Back", icon: icon("chevron-left"), back: true }, SEP, ...parent.sub()] : top;
  }

  choose(it) {
    if (!it || it.sep || it.disabled) return;
    if (it.back) { this.sub = null; this.at = -1; return; }
    if (it.sub) { this.sub = it.label; this.at = -1; return; }
    if (it.confirm) return it.confirm();
    this.close();
    it.run();
  }

  // The next item that can run, from `at` in direction `d`.
  step(list, d) {
    for (let n = 1; n <= list.length; n++) {
      const i = (((this.at < 0 && d < 0 ? 0 : this.at) + d * n) % list.length + list.length) % list.length;
      if (!list[i].sep && !list[i].disabled) return i;
    }
    return this.at;
  }

  render(cx) {
    const t = theme();
    const list = this.list();
    return v_flex()
      .id("session-menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        const letter = e.key.length === 1 && list.find((it) => it.key === e.key.toUpperCase() && !it.disabled);
        if (e.key === "down") this.at = this.step(list, 1);
        else if (e.key === "up") this.at = this.step(list, -1);
        else if (e.key === "enter" || e.key === "right") this.choose(list[this.at]);
        else if (e.key === "left" && this.sub) { this.sub = null; this.at = -1; }
        else if (e.key === "escape") this.close();
        else if (letter) this.choose(letter);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) => {
          if (it.sep) return div().mx(7).my(4).h(1).bg(t.border);
          const color = it.disabled ? t.dim : it.danger ? t.ansi1 : t.foreground;
          return h_flex()
            .id(`smi-${i}`)
            .h(29)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .text_color(color)
            .when(!it.disabled && i === this.at, (el) => el.bg(t.selected))
            .when(!it.disabled, (el) => el.hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.choose(it); cx.notify(); }))
            .child(it.image ? image(it.image).size(14).flex_none().when(Boolean(it.disabled), (el) => el.opacity(0.4))
              : it.icon ? svg(it.icon).size(14).flex_none().text_color(it.disabled ? t.dim : it.danger ? t.ansi1 : t.muted)
              : div().size(14).flex_none())
            .child(div().flex_1().child(it.label))
            .child(div().text_size(11).text_color(t.dim).child(it.sub ? "›" : it.key ?? ""));
        }),
      );
  }
}
