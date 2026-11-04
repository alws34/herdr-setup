// Explorer: the focused pane's folder as a VSCode-style tree (a clone of Herdr's `files`,
// 0.1.11). A click on a file opens it in the `editor` pane of the shown tab, split off to the
// right of the terminal when the tab has none (shared "editor.open"); the file the editor
// shows is highlighted. Git status letters as in Files.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, shared, setShared, run } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  // An editor pane has no folder of its own: keep the tree on the tab's terminal.
  const cwd = pane?.cwd || f?.cwd || panes().find(p => p.tab === pane?.tab && p.cwd)?.cwd || space?.folder;
  return { cwd, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// Opens a file in the shown tab's editor pane, splitting one off the terminal if there's none.
function openInEditor(path, on) {
  const space = spaces().find((s) => s.active), tab = space?.tabs.find((x) => x.active);
  if (!tab) return;
  setShared("editor.open", { path, on: on ?? null, tab: tab.id, at: Date.now() });
  const tabPanes = panes().filter((p) => p.tab === tab.id);
  if (tabPanes.some((p) => p.mod === "editor")) return;
  const from = tabPanes.find((p) => p.pane === focused()?.pane && p.terminal) ?? tabPanes.find((p) => p.terminal) ?? tabPanes[0];
  run("pane.split", { direction: "right", ...(from ? { pane: from.pane } : {}), mod: "editor", props: { tab: tab.id } });
}

export default class Explorer extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" ? "U" : xy.includes("A") ? "A" : xy.includes("U") ? "!" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  rows(prefix, depth, out, t, opened) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      const abs = `${this.root}/${path}`, mark = this.marks[abs];
      const markColor = mark === "U" || mark === "A" ? t.ansi2 : mark === "D" || mark === "!" ? t.ansi1 : t.blocked;
      out.push(h_flex().id(`file-${path}`).h(22).flex_none().pl(6 + depth * 12).pr(8).gap(5).items_center().cursor_pointer()
        .when(opened === abs, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : openInEditor(abs, this.on))
        .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.muted) : div().w(12).flex_none())
        .child(svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`).size(13).flex_none().text_color(entry.dir ? t.muted : t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(mark ? markColor : t.foreground).child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(markColor).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t, opened);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), opened = shared("editor.open")?.path;
    const button = (id, label, tip, action) => div().id(id).size(20).flex().items_center().justify_center().rounded(4).text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(action).child(label);
    return v_flex().id("explorer").size_full().min_h(0).text_color(t.foreground).text_size(13)
      .child(h_flex().h(24).flex_none().pl(8).pr(4).gap(2).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).font_semibold().text_color(t.muted).child((this.root?.split("/").pop() ?? "").toUpperCase()))
        .child(button("explorer-refresh", "↻", "Refresh", (_e, cx) => this.refresh(cx)))
        .child(button("explorer-collapse", "⊟", "Collapse folders", (_e, cx) => { this.folders = new Set(); cx.notify(); })))
      .child(v_flex().id("explorer-tree").flex_1().min_h(0).overflow_y_scrollbar().pb(6).children(this.rows("", 0, [], t, opened))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }
}
