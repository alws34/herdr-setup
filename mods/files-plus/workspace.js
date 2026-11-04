// Lazy tree and read-only preview adapted from Herdr files and Multi-Roots.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, settings, theme, props, shared, setShared, run, openOverlay } from "herdr";
import { workspaceOf, describeRoots, reloadWorkspace, dirname, joinPath, label, shortPath, rootOf, relativePath, contains, READ } from "./roots.js";
import { captureTarget, REVISION } from "./actions.js";

const PER_FOLDER = 500, TOTAL = 5000;
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", md: "markdown" };

// Local patch (props.editor): a file click opens it in the `editor` pane of the shown tab,
// split off the terminal when the tab has none, as the `explorer` mod does.
function openInEditor(path, on) {
  const space = spaces().find((s) => s.active), tab = space?.tabs.find((x) => x.active);
  if (!tab) return;
  setShared("editor.open", { path, on: on ?? null, tab: tab.id, at: Date.now() });
  const tabPanes = panes().filter((p) => p.tab === tab.id);
  if (tabPanes.some((p) => p.mod === "editor")) return;
  const from = tabPanes.find((p) => p.pane === focused()?.pane && p.terminal) ?? tabPanes.find((p) => p.terminal) ?? tabPanes[0];
  run("pane.split", { direction: "right", ...(from ? { pane: from.pane } : {}), mod: "editor", props: { tab: tab.id } });
}

// Local patch (props.session): a file click opens it as a file tab of the shown Herdr tab, in
// the main window (shared "session-files", drawn by the session-files mod). Closed tabs' lists go.
function openInSession(path, on) {
  const space = spaces().find((s) => s.active), tab = space?.tabs.find((x) => x.active);
  if (!tab) return;
  const live = new Set(spaces().flatMap((s) => s.tabs.map((x) => x.id)));
  const all = Object.fromEntries(Object.entries(shared("session-files") ?? {}).filter(([id]) => live.has(id)));
  const files = all[tab.id]?.files ?? [];
  all[tab.id] = { files: files.some((f) => f.path === path) ? files : [...files, { path, on: on ?? null }], active: path };
  setShared("session-files", all);
}

export function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const cwd = (f?.space === space?.id ? pane?.cwd || f?.cwd : null) || space?.folder;
  const on = f && space && f.space === space.id && f.pane === null && f.terminal ? (f.terminal.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const entry = workspaceOf(space?.id);
  return { space: space?.id, cwd, on, entry, key: entry ? JSON.stringify([space.id, entry.folders]) : JSON.stringify([space?.id, cwd, on]) };
}

export async function directory(path, on) {
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files-plus", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export class FilesPanel extends View {
  initPanel(cx) {
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.watches = new Map(); this.marks = {};
    this.revision = shared(REVISION);
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }
  watch(path, cx) {
    if (this.on || this.watches.has(path)) return;
    const token = {};
    this.watches.set(path, token);
    cx.spawn(async cx => {
      try {
        while (this.watches.get(path) === token) {
          await watchFolder(path);
          if (this.watches.get(path) === token) this.refresh(cx);
        }
      } catch { if (this.watches.get(path) === token) this.watches.delete(path); }
    });
  }
  watchConfig(id, file, cx) {
    const token = file ? `${id}:${file}` : null;
    if (this.configWatch === token) return;
    this.configWatch = token;
    if (!file) return;
    cx.spawn(async cx => {
      try {
        await reloadWorkspace(id).catch(() => null);
        cx.notify();
        while (this.configWatch === token) {
          const paths = await watchFolder(dirname(file));
          if (this.configWatch !== token) return;
          if (paths.includes(file)) { await reloadWorkspace(id).catch(() => null); this.refresh(cx); cx.notify(); }
        }
      } catch { if (this.configWatch === token) this.configWatch = null; }
    });
  }
  current(context) { return this.context === context && location().key === context; }
  async loadFolder(path, context) {
    if (!this.current(context)) return;
    const list = await directory(path, this.on);
    if (!this.current(context) || !this.folders.has(path)) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, list.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (list.length > PER_FOLDER || used + list.length > TOTAL) this.limited = true;
  }
  refresh(cx) {
    const loc = location(), context = loc.key;
    if (context !== this.context) {
      this.context = context; this.spaceId = loc.space; this.root = loc.cwd; this.on = loc.on; this.workspace = loc.entry;
      this.entries = new Map(); this.folders = new Set(loc.entry ? loc.entry.folders.map(f => f.path) : loc.cwd ? [loc.cwd] : []);
      this.pending = new Set(); this.marks = {}; this.rootInfo = null; this.watches.clear(); this.show(null); this.error = null; this.loading = null;
    }
    this.watchConfig(loc.space, loc.entry?.file, cx);
    if (this.loading === context) { this.refreshAgain = true; return; }
    if (!loc.cwd && !loc.entry) return;
    this.loading = context; this.limited = false; this.refreshAgain = false;
    cx.spawn(async cx => {
      try {
        const roots = loc.entry ? await describeRoots(loc.entry.folders) : [{ path: loc.cwd, exists: true }];
        if (!this.current(context)) return;
        this.rootInfo = roots;
        // Drop entries for folders removed on disk so their budget can be reused.
        for (const path of [...this.folders]) {
          const root = rootOf(path, roots);
          if (!root || root.exists === false) { this.entries.delete(path); continue; }
          try { await this.loadFolder(path, context); }
          catch (error) { this.entries.delete(path); if (path === root.path) throw error; this.folders.delete(path); }
        }
        const marks = {};
        const tops = loc.entry ? [...new Set(roots.map(f => f.top).filter(Boolean))] : [loc.cwd];
        for (const cwd of tops) {
          const top = await exec("git", [...READ, "rev-parse", "--show-toplevel"], { cwd, on: loc.on }).catch(() => null);
          if (top?.code !== 0) continue;
          const status = await exec("git", [...READ, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"], { cwd, on: loc.on }).catch(() => null);
          if (status?.code !== 0) continue;
          for (const item of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = item.slice(0, 2), absolute = joinPath(top.stdout.trim(), item.slice(3));
            const mark = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
            for (const root of roots) {
              const base = root.physical || root.path;
              if (contains(base, absolute)) marks[root.path + absolute.slice(base.length)] = mark;
            }
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null;
        for (const root of roots) if (root.exists) this.watch(root.path, cx);
        if (this.file) this.show(this.file, cx);
      } catch (error) { if (this.current(context)) this.error = error.message || String(error); }
      finally {
        if (this.loading === context) {
          this.loading = null;
          if (this.refreshAgain && this.current(context)) this.refresh(cx);
        }
        cx.notify();
      }
    });
  }
  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (contains(path, folder)) { this.folders.delete(folder); this.entries.delete(folder); }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context, pending = this.pending;
        pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (error) { if (this.current(context)) this.error = error.message || String(error); }
          finally { pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }
  openFile(path, cx) {
    if (props()?.session) openInSession(path, this.on);
    else if (props()?.editor) openInEditor(path, this.on);
    else this.show(path, cx);
  }
  show(path, cx) {
    const same = path && this.file === path;
    if (!same) { this.code?.release(); this.code = null; this.previewText = null; }
    this.file = path; this.fileError = null;
    const request = this.previewRequest = {};
    if (!path || !cx) return;
    const context = this.context, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(path, { on });
        if (this.previewRequest !== request || !this.current(context)) return;
        if (text === null || text.includes("\0")) {
          this.code?.release(); this.code = null;
          this.fileError = text === null ? "This file is no longer available" : "Binary file, no text preview"; return;
        }
        const value = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        if (this.code && this.previewText === value) return;
        this.code?.release(); this.previewText = value;
        const t = theme(), ext = path.split(".").pop().toLowerCase();
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true, value,
          font_family: settings().font_family, font_size: 12, syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.muted, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi4 } });
      } catch { if (this.previewRequest === request && this.current(context)) { this.code?.release(); this.code = null; this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; } }
      finally { cx.notify(); }
    });
  }
  target(path, kind, root) { return captureTarget(this.spaceId, path, kind, root, this.on, this.rootInfo?.find(folder => folder.path === root)?.physical || root); }
  menu(path, kind, root, event, cx) {
    cx.stop_propagation();
    openOverlay({ mod: "files-plus", kind: "popup", width: 272, height: kind === "root" ? 428 : 360, at: event.position, props: { role: "menu", target: this.target(path, kind, root) } });
  }
  rows(prefix, root, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = joinPath(prefix, entry.name), open = this.folders.has(path), mark = this.marks[path];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(4).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_event, cx) => entry.dir ? this.toggle(path, cx) : this.openFile(path, cx))
        .on_mouse_down("right", (event, cx) => this.menu(path, entry.dir ? "dir" : "file", root, event, cx))
        .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.muted) : div().w(12).flex_none())
        .child(svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(12).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.ansi3).child(mark))));
      if (entry.dir && open) this.rows(path, root, depth + 1, out, t);
    }
    return out;
  }
  renderPanel(cx) {
    const loc = location();
    if (loc.key !== this.context || this.revision !== shared(REVISION)) { this.revision = shared(REVISION); this.refresh(cx); }
    const entry = workspaceOf(this.spaceId), t = theme(), roots = this.rootInfo || entry?.folders || [];
    const active = rootOf(focused()?.cwd, roots), fileRoot = this.file ? rootOf(this.file, roots) : null;
    const add = Boolean(this.root || entry?.folders.length) && this.on === null;
    const title = this.file ? fileRoot ? `${label(fileRoot)}/${relativePath(fileRoot.path, this.file)}` : relativePath(this.root, this.file) : entry?.name || (this.root ? label({ path: this.root }) : "");
    return v_flex().id("files-plus").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(0.5).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").size(24).cursor_pointer().role("button").accessibility_label("Back to files").tooltip("Back to files").text_color(t.muted)
          .on_click((_event, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().id("add-folder").size(24).text_color(t.muted).role("button").accessibility_label("Add folder").tooltip("Add folder…").disabled(!add)
          .when(add, el => el.cursor_pointer().hover(s => s.bg(t.hover))).on_click((_event, cx) => {
            if (!add) return;
            const root = entry?.folders[0]?.path || this.root;
            openOverlay({ mod: "files-plus", kind: "dialog", modal: true, width: 440, height: 220, props: { role: "dialog", action: "add-root", target: this.target(root, "root", root) } });
            cx.stop_propagation();
          }).child("+"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.muted).child(title)))
      .when(Boolean(entry?.error), el => el.child(div().px(12).py(8).text_size(12).text_color(t.ansi1).child(entry.error)))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .when(Boolean(entry), tree => tree.children(roots.map(folder => {
          const open = this.folders.has(folder.path), missing = folder.exists === false;
          return v_flex().child(h_flex().id(`root-${folder.path}`).h(30).flex_none().px(8).gap(7).items_center().rounded(4)
            .when(active?.path === folder.path, row => row.bg(t.selected)).hover(s => s.bg(t.hover)).cursor_pointer()
            .on_click((_event, cx) => { if (!missing) this.toggle(folder.path, cx); })
            .on_mouse_down("right", (event, cx) => this.menu(folder.path, "root", folder.path, event, cx))
            .child(svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.muted))
            .child(svg("mods/files/folder.svg").size(14).flex_none().text_color(t.muted))
            .child(div().font_medium().child(label(folder)))
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(missing ? "Not found" : shortPath(folder.path))))
            .when(open && !missing, group => group.children(this.rows(folder.path, folder.path, 1, [], t))
              .when(!this.entries.get(folder.path)?.length, group => group.child(div().pl(44).py(6).text_size(12).text_color(t.muted).child(this.entries.has(folder.path) ? "No files" : "Loading files…"))));
        })))
        .when(!entry, tree => tree.on_mouse_down("right", (event, cx) => { if (this.root) this.menu(this.root, "dir", this.root, event, cx); }).children(this.root ? this.rows(this.root, this.root, 0, [], t) : [])
          .when(!this.entries.get(this.root)?.length, el => el.child(div().p(8).text_size(12).text_color(t.muted).child(this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(Boolean(this.error), el => el.child(div().p(8).text_size(12).text_color(t.ansi1).child(this.error)))
        .when(this.limited, el => el.child(div().p(8).text_size(12).text_color(t.muted).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.muted).child(this.fileError || "Loading file…")));
  }
  close() { this.watches?.clear(); this.configWatch = null; this.code?.release(); }
}
