// Editor: a VSCode-style editor pane. Files open here from the Explorer (shared
// "editor.open", aimed at this pane's tab: props.tab), each as a tab along the top with ●
// while it has unsaved changes. ⌘S saves (keys.json "mod:editor"), ⌘W closes the tab.
// Markdown files get Edit / Split / Preview, the preview following the text as you type.
//
// Files change under the editor (an agent edits them): while a file has no unsaved changes
// it is reread every 2 s and follows the disk. A save is a compare-and-swap against what was
// last read, so it never overwrites someone else's change: the editor says so instead.
// Files on another machine open read-only (writeTextFile writes here only).
import { View, div, image } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState, TextView } from "gpui-base";
import { readTextFile, writeTextFile, theme, settings, props, shared, setShared, spaces, nextCommand, notify, run, exec, appHome } from "herdr";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", py: "python", sh: "bash", zsh: "bash", md: "markdown" };
const MAX = 2_000_000;
const isMarkdown = (path) => /\.(md|markdown|mdx)$/i.test(path);
// Images open as a picture (2026-11-02: a PNG said "stream did not contain valid UTF-8"), through
// a copy under the app folder (preview.sh says why).
const isImage = (path) => /\.(png|jpe?g|gif|webp|bmp|ico|svg|heic|heif|tiff?|psd|avif|jp2|tga|icns)$/i.test(path);
const PREVIEWS = "data/editor-preview";
const base = (path) => path.split("/").pop();

export default class EditorPane extends View {
  init(_props, cx) {
    this.files = []; // { path, on, state, disk, text, dirty, error, conflict, view }
    this.active = null;
    // props.session: the vscode layout's file view. It shows the shown session's active file
    // from shared "session-files" (the session-files mod draws the tabs), so no strip of its own.
    this.session = Boolean(props()?.session);
    if (!this.session) {
      // Reopen what this pane had (per pane copy), then whatever was just asked of it.
      for (const f of JSON.parse(localStorage.getItem("files") ?? "[]")) this.open(f.path, f.on, cx, false);
      this.active = localStorage.getItem("active") ?? this.files[0]?.path ?? null;
      const ask = shared("editor.open");
      this.asked = ask?.at;
      if (ask && ask.tab === props()?.tab && Date.now() - ask.at < 10000) this.open(ask.path, ask.on, cx, true);
      // As Herdr's viewers: pane.split {mod: "editor", props: {file, on?}} opens that file.
      if (props()?.file) this.open(props().file, props().on, cx, true);
    }
    cx.timer.every(2000, (cx) => this.follow(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const f = this.current();
        if (c === "save" && f) this.save(f, cx);
        if (c === "close" && f) { if (this.session) this.closeInSession(f); else this.close(f.path, cx); }
        if (c === "preview" && f && isMarkdown(f.path)) { f.view = f.view === "preview" ? "edit" : "preview"; cx.notify(); }
      }
    });
  }

  current() { return this.files.find((f) => f.path === this.active) ?? null; }

  // Session mode: follow the shown session's active file; forget files no session has open
  // (an unsaved one stays until saved); tell the session-files row which are unsaved.
  syncSession(cx) {
    const tab = spaces().find((s) => s.active)?.tabs.find((x) => x.active);
    const all = shared("session-files") ?? {}, entry = tab && all[tab.id];
    const want = entry?.active ? entry.files.find((x) => x.path === entry.active) : null;
    const open = new Set(Object.values(all).flatMap((e) => e.files.map((x) => x.path)));
    for (const f of [...this.files]) {
      if (open.has(f.path) || f.dirty) continue;
      f.state?.release();
      this.files.splice(this.files.indexOf(f), 1);
    }
    if (want && !this.files.some((x) => x.path === want.path)) this.open(want.path, want.on, cx, true);
    this.active = want?.path ?? null;
    const dirty = this.files.filter((x) => x.dirty).map((x) => x.path);
    if (JSON.stringify(dirty) !== JSON.stringify(shared("session-files.dirty") ?? [])) setShared("session-files.dirty", dirty);
  }

  closeInSession(f) {
    if (f.dirty) { notify({ title: `Unsaved changes: ${base(f.path)}`, body: "Save it (⌘S) before closing.", level: "warning" }); return; }
    const tab = spaces().find((s) => s.active)?.tabs.find((x) => x.active), all = shared("session-files") ?? {}, entry = tab && all[tab.id];
    if (!entry) return;
    const i = entry.files.findIndex((x) => x.path === f.path), files = entry.files.filter((x) => x.path !== f.path);
    setShared("session-files", { ...all, [tab.id]: { files, active: (files[i] ?? files[i - 1])?.path ?? null } });
  }

  remember() {
    if (this.session) return;
    localStorage.setItem("files", JSON.stringify(this.files.map(({ path, on }) => ({ path, on }))));
    localStorage.setItem("active", this.active ?? "");
  }

  open(path, on, cx, show) {
    let f = this.files.find((x) => x.path === path);
    if (!f) {
      f = { path, on: on ?? null, state: null, disk: null, dirty: false, view: isMarkdown(path) ? "split" : "edit" };
      this.files.push(f);
      this.load(f, cx);
    }
    if (show || !this.active) this.active = path;
    this.remember();
    cx.notify();
  }

  load(f, cx) {
    if (isImage(f.path)) return this.loadImage(f, cx);
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(f.path, { on: f.on });
        if (text === null) { f.error = "This file is no longer available"; return; }
        if (text.includes("\0")) { f.error = "Binary file"; return; }
        if (text.length > MAX) { f.error = "File too large to edit here"; return; }
        const t = theme(), ext = f.path.includes(".") ? f.path.split(".").pop().toLowerCase() : "txt";
        f.disk = text; f.text = text;
        f.state = EditorState.new({ language: LANG[ext] ?? ext, value: text, readonly: Boolean(f.on),
          font_family: settings().font_family, font_size: 13, soft_wrap: isMarkdown(f.path),
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        f.state.on("change", (_e, cx) => {
          const text = f.state.value();
          if (text === f.text) return;
          f.text = text;
          const dirty = text !== f.disk;
          if (dirty !== f.dirty || f.view !== "edit") { f.dirty = dirty; cx.notify(); }
        });
      } catch (e) { f.error = `Cannot open: ${e.message ?? e}`; }
      finally { cx.notify(); }
    });
  }

  // A picture: its copy under the app folder and its size (on open and every follow tick).
  loadImage(f, cx) {
    if (f.on) { f.error = "Pictures preview only for files on this computer"; cx.notify(); return; }
    if (f.reading) return;
    f.reading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", [`${appHome()}/mods/editor/preview.sh`, f.path, `${appHome()}/${PREVIEWS}`]);
        const was = f.error;
        if (r.code === 3) f.error = "This file is no longer available";
        else if (r.code !== 0) f.error = "Can't show this picture";
        else {
          const [name, w, h] = r.stdout.trim().split(" ");
          f.error = null;
          if (`${PREVIEWS}/${name}` !== f.img?.src) { f.img = { src: `${PREVIEWS}/${name}`, w: Number(w) || 0, h: Number(h) || 0 }; cx.notify(); }
        }
        if (f.error !== was) cx.notify();
      } catch (e) { f.error = `Cannot open: ${e.message ?? e}`; cx.notify(); }
      finally { f.reading = false; }
    });
  }

  // Clean files follow the disk; a dirty one changed on disk is marked as a conflict.
  follow(cx) {
    for (const f of this.files) {
      // A picture costs a few processes per check (preview.sh): only the one on screen follows.
      if (isImage(f.path)) { if (f.img && f.path === this.active) this.loadImage(f, cx); continue; }
      if (!f.state || f.reading) continue;
      f.reading = true;
      cx.spawn(async (cx) => {
        try {
          const text = await readTextFile(f.path, { on: f.on });
          if (text === null || text === f.disk) return;
          if (!f.dirty) { f.disk = text; f.text = text; f.state.set_value(text); f.conflict = false; }
          else f.conflict = true;
          cx.notify();
        } catch { /* gone or unreadable: keep what we have */ }
        finally { f.reading = false; }
      });
    }
  }

  save(f, cx) {
    if (!f.state || f.on) return;
    const text = f.state.value();
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(f.path, text, f.disk);
        f.disk = text; f.dirty = f.state.value() !== text; f.conflict = false;
      } catch (e) {
        f.conflict = true;
        notify({ title: `Not saved: ${base(f.path)}`, body: "It changed on disk since it was opened. Reload it or copy your changes.", level: "warning" });
      }
      cx.notify();
    });
  }

  reload(f, cx) {
    f.dirty = false; f.conflict = false; f.disk = null;
    f.state?.release(); f.state = null;
    this.load(f, cx);
  }

  close(path, cx) {
    const i = this.files.findIndex((f) => f.path === path);
    if (i < 0) return;
    this.files[i].state?.release();
    this.files.splice(i, 1);
    if (this.active === path) this.active = (this.files[i] ?? this.files[i - 1])?.path ?? null;
    this.remember();
    cx.notify();
  }

  tab(f, t) {
    const on = f.path === this.active;
    return h_flex().id(`tab-${f.path}`).h_full().flex_none().pl(12).pr(6).gap(6).items_center().cursor_pointer().text_size(12.5)
      .bg(on ? t.background : t.chrome).text_color(on ? t.foreground : t.muted).border_r(1).border_color(t.border)
      .when(on, (el) => el.border_t(1).border_color(t.accent))
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.active = f.path; this.remember(); cx.notify(); })
      .on_mouse_down("middle", (_e, cx) => this.close(f.path, cx))
      .child(div().max_w(180).truncate().child(base(f.path)))
      .child(div().id(`close-${f.path}`).size(16).flex().items_center().justify_center().rounded(4).text_color(f.dirty ? t.foreground : t.dim)
        .hover((s) => s.bg(t.hover)).tooltip(f.dirty ? "Unsaved changes" : "Close (⌘W)")
        .on_click((_e, cx) => { cx.stop_propagation(); this.close(f.path, cx); })
        .child(f.dirty ? "●" : "×"));
  }

  render(cx) {
    if (this.session) this.syncSession(cx);
    const ask = this.session ? null : shared("editor.open");
    if (ask && ask.at !== this.asked) {
      this.asked = ask.at;
      if (ask.tab === props()?.tab) this.open(ask.path, ask.on, cx, true);
    }
    const t = theme(), f = this.current();
    const toggle = (view, label) => div().id(`view-${view}`).px(8).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(11.5)
      .bg(f?.view === view ? t.selected : t.chrome).text_color(f?.view === view ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { f.view = view; cx.notify(); }).child(label);
    const body = () => {
      if (!f) return div().size_full().flex().items_center().justify_center().text_color(t.dim).child("Open a file from the Explorer");
      if (f.error) return div().p(16).text_color(t.dim).child(f.error);
      if (isImage(f.path)) {
        if (!f.img) return div().p(16).text_color(t.dim).child("Loading…");
        // Fit inside the pane, never enlarged, keeping its shape (the kit has no object-fit).
        const box = this.box ?? { width: 800, height: 600 }, pad = 48;
        const { w, h } = f.img, k = w && h ? Math.min(1, (box.width - pad) / w, (box.height - pad) / h) : 0;
        return v_flex().id("img-view").size_full().items_center().justify_center().gap(8).bg(t.background)
          .on_size_change((size, cx) => { if (size.width !== this.box?.width || size.height !== this.box?.height) { this.box = size; cx.notify(); } })
          .child(k > 0 ? image(f.img.src).w(Math.max(1, Math.floor(w * k))).h(Math.max(1, Math.floor(h * k)))
            : image(f.img.src).size(Math.max(40, Math.min(box.width, box.height) - pad)))
          .when(Boolean(w && h), (el) => el.child(div().text_size(11).text_color(t.dim).child(`${w} × ${h}${k < 1 ? ` · ${Math.round(k * 100)}%` : ""}`)));
      }
      if (!f.state) return div().p(16).text_color(t.dim).child("Loading…");
      const editor = Editor.new(f.state).size_full();
      const preview = () => div().id("md-preview").size_full().min_w(0).overflow_y_scrollbar().px(24).py(16).bg(t.background)
        // Not .selectable(): Herdr 0.1.11 paints the selection opaque over the text, hiding it.
        // Copy from the Edit/Split source instead.
        .child(TextView.markdown(`md-${f.path}`, f.text ?? ""));
      if (!isMarkdown(f.path) || f.view === "edit") return editor;
      if (f.view === "preview") return preview();
      return h_flex().size_full().min_h(0)
        .child(div().flex_1().min_w(0).h_full().border_r(1).border_color(t.border).child(editor))
        .child(div().flex_1().min_w(0).h_full().child(preview()));
    };
    return v_flex().id("editor").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .when(!this.session || Boolean(f && isMarkdown(f.path)), (el) => el.child(h_flex().id("editor-tabs").h(34).flex_none().bg(t.chrome).border_b(1).border_color(t.border).overflow_x_scrollbar()
        .children(this.session ? [] : this.files.map((x) => this.tab(x, t)))
        .child(div().flex_1())
        .when(Boolean(f && isMarkdown(f.path)), (el) => el.child(h_flex().flex_none().px(6).gap(2).items_center()
          .child(toggle("edit", "Code")).child(toggle("split", "Split")).child(toggle("preview", "Preview"))))))
      .when(Boolean(f), (el) => el.child(h_flex().h(22).flex_none().px(12).gap(8).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(`${f.on ? `${f.on}:` : ""}${f.path}`))
        .when(Boolean(f.on), (el) => el.child(div().child("read-only (remote)")))
        // HTML and Markdown also open as a real page (JS, Mermaid) in the html-viewer mod.
        .when(/\.(html?|md|markdown)$/i.test(f.path), (el) => el.child(div().id("as-page").px(6).rounded(4).cursor_pointer().text_color(t.foreground).bg(t.raised)
          .hover((s) => s.bg(t.hover)).tooltip("Open as a page in html-viewer (headless Chrome)")
          .on_click(() => { const sp = spaces().find((x) => x.active); run("tab.new", { ...(sp ? { space: sp.id } : {}), name: base(f.path), mod: "html-viewer", props: { space: sp?.id, file: f.path, ...(f.on ? { machine: f.on } : {}) } }); })
          .child("Page ↗")))
        .when(Boolean(f.conflict), (el) => el.child(div().text_color(t.blocked).child("changed on disk"))
          .child(div().id("reload").px(6).rounded(4).cursor_pointer().text_color(t.foreground).bg(t.raised).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.reload(f, cx)).child("Reload")))
        .when(f.dirty && !f.on, (el) => el.child(div().id("save").px(6).rounded(4).cursor_pointer().text_color(t.foreground).bg(t.raised)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.save(f, cx)).child("Save ⌘S")))))
      .child(div().flex_1().min_h(0).child(body()));
  }
}
