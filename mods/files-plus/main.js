import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, setShared, run, openOverlay, closeOverlay, pickFolder, theme } from "herdr";
import { FilesPanel } from "./workspace.js";
import { prune, basename, relativePath } from "./roots.js";
import { workspaceSnapshot, changeRoots } from "./config.js";
import { CLIPBOARD, menuItems, ensureTarget, insertReference, paste, createEntry, renameEntry, trashEntry, reveal, changed } from "./actions.js";

const TITLES = { "new-file": "New file", "new-folder": "New folder", rename: "Rename", trash: "Move to Trash", "add-root": "Add folder to workspace", "remove-root": "Remove from workspace" };
const NAME_ACTIONS = new Set(["new-file", "new-folder", "rename"]);

export default class FilesPlus extends FilesPanel {
  init(_props, cx) {
    const p = props() || {};
    this.role = p.role; this.targetEntry = p.target; this.action = p.action; this.busy = false; this.at = 0;
    if (!this.role) { this.initPanel(cx); return; }
    this.handle = cx.focus_handle();
    if (this.role === "menu") {
      this.at = menuItems(this.targetEntry).findIndex(item => item.enabled);
      this.handle.focus();
    } else if (this.role === "dialog") {
      if (NAME_ACTIONS.has(this.action)) {
        const value = this.action === "rename" ? basename(this.targetEntry.path) : "";
        this.input = InputState.new({ value, placeholder: "Name" });
        if (value) this.input.set_selected_range({ start: 0, end: value.length });
        this.input.on("change", (_event, cx) => { this.error = null; cx.notify(); });
        this.input.on("submit", (_event, cx) => this.submit(cx));
        this.input.focus();
      } else this.handle.focus();
      if (this.action === "add-root" || this.action === "remove-root") {
        this.preparing = true;
        cx.spawn(async cx => {
          try { this.captured = await workspaceSnapshot(this.targetEntry); }
          catch (error) { this.error = error.message || String(error); }
          this.preparing = false; cx.notify();
        });
      }
    }
  }
  openDialog(action) {
    openOverlay({ mod: "files-plus", kind: "dialog", modal: true, width: 440, height: 240,
      props: { role: "dialog", action, target: this.targetEntry } });
    closeOverlay(props().overlay);
  }
  choose(index, cx) {
    if (this.busy) return;
    const item = menuItems(this.targetEntry)[index], target = this.targetEntry;
    if (!item?.enabled) return;
    if (TITLES[item.id]) { this.openDialog(item.id); return; }
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        ensureTarget(target);
        if (item.id === "agent") await insertReference(target, cx);
        else if (item.id === "copy") setShared(CLIPBOARD, { path: target.path, kind: target.kind, on: target.on });
        else if (item.id === "paste") await paste(target);
        else if (item.id === "path") cx.write_to_clipboard(target.path);
        else if (item.id === "relative") cx.write_to_clipboard(relativePath(target.root, target.path));
        else if (item.id === "reveal") await reveal(target);
        else if (item.id === "new-here") run("tab.new", { space: target.space, folder: target.root });
        // Keep this owner alive until its asynchronous operation has finished.
        closeOverlay(props().overlay);
      } catch (error) {
        this.error = error.message || String(error); this.busy = false; cx.notify();
      }
    });
  }
  submit(cx) {
    if (this.busy || this.preparing || ((this.action === "add-root" || this.action === "remove-root") && !this.captured)) return;
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const target = this.targetEntry, action = this.action, name = this.input?.value();
        if (action === "new-file" || action === "new-folder") await createEntry(target, action === "new-file" ? "file" : "dir", name);
        else if (action === "rename") await renameEntry(target, name);
        else if (action === "trash") await trashEntry(target);
        else if (action === "add-root") {
          const picked = await pickFolder({ prompt: "Add" });
          if (await changeRoots(target, action, picked, this.captured)) changed();
        } else if (action === "remove-root") { if (await changeRoots(target, action, null, this.captured)) changed(); }
        closeOverlay(props().overlay);
      } catch (error) { this.error = error.message || String(error); this.busy = false; cx.notify(); }
    });
  }
  renderMenu() {
    const t = theme(), list = menuItems(this.targetEntry);
    const height = list.length * 32 + list.filter(item => item.group).length * 8.5 + 10 + (this.busy || this.error ? 64 : 0);
    if (!list[this.at]?.enabled) this.at = list.findIndex(item => item.enabled);
    return v_flex().id("files-menu").track_focus(this.handle).w_full().h(height).max_h(600).min_h(0).overflow_y_scrollbar().p(5).bg(t.popover).text_size(13).text_color(t.foreground)
      .on_key_down((event, cx) => {
        if (this.busy) { cx.stop_propagation(); return; }
        if (event.key === "up" || event.key === "down") {
          const step = event.key === "down" ? 1 : -1;
          do { this.at = (this.at + list.length + step) % list.length; } while (!list[this.at].enabled);
        } else if (event.key === "enter") this.choose(this.at, cx);
        else if (event.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .children(list.map((item, index) => v_flex().flex_none()
        .when(item.group, el => el.child(div().mx(7).my(4).h(0.5).bg(t.border)))
        .child(h_flex().id(`action-${item.id}`).h(32).px(10).rounded(4).items_center().flex_none().disabled(!item.enabled || this.busy).role("button").accessibility_label(item.label)
          .text_color(!item.enabled || this.busy ? t.muted : item.danger ? t.ansi1 : t.foreground)
          .when(index === this.at && item.enabled, el => el.bg(t.selected))
          .when(item.enabled && !this.busy, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
          .on_hover((hovered, cx) => { if (hovered && item.enabled && !this.busy) { this.at = index; cx.notify(); } })
          .on_click((_event, cx) => this.choose(index, cx)).child(item.label))))
      .when(this.busy || Boolean(this.error), el => el.child(div().p(8).text_size(12).text_color(this.error ? t.ansi1 : t.muted).child(this.error || "Working…")));
  }
  renderDialog() {
    const t = theme(), action = this.action, target = this.targetEntry;
    const rootAction = action === "add-root" || action === "remove-root";
    const enabled = !this.busy && !this.preparing && (!this.input || Boolean(this.input.value().trim())) && (!rootAction || Boolean(this.captured));
    const button = (id, text, primary, active, fn) => h_flex().id(id).h(32).px(12).items_center().justify_center().rounded(4).role("button").accessibility_label(text).disabled(!active)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).when(!active, el => el.opacity(0.5))
      .when(active, el => el.cursor_pointer().hover(s => s.opacity(0.88))).on_click((_event, cx) => { if (active) fn(cx); }).child(text);
    return v_flex().id("files-dialog").track_focus(this.handle).w_full().h_full().min_h(0).p(18).gap(12).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((event, cx) => {
        if (event.key === "escape") { if (!this.busy) closeOverlay(props().overlay); cx.stop_propagation(); }
        else if (event.key === "enter" && !this.input) { this.submit(cx); cx.stop_propagation(); }
      })
      .child(div().text_size(14).font_semibold().child(TITLES[action] || "File action"))
      .child(div().text_size(12).text_color(t.muted).truncate().child(target.path))
      .when(Boolean(this.input), el => el.child(Input.new(this.input).h(34).px(10).rounded(4).border(0.5).border_color(t.input).bg(t.background).text_color(t.foreground).accessibility_label("Name")))
      .when(action === "trash", el => el.child(div().child(target.on === null ? `Move “${basename(target.path)}” to Trash?` : `Permanently delete “${basename(target.path)}”? This cannot be undone.`)))
      .when(action === "remove-root", el => el.child(div().child("Remove this folder from the workspace? Files on disk are kept.")))
      .when(Boolean(this.error) || this.preparing, el => el.child(div().text_size(12).text_color(this.error ? t.ansi1 : t.muted).child(this.error || "Loading workspace…")))
      .child(div().flex_1())
      .child(h_flex().justify_end().gap(8)
        .child(button("dialog-cancel", "Cancel", false, !this.busy, () => closeOverlay(props().overlay)))
        .child(button("dialog-submit", this.busy ? "Working…" : action === "add-root" ? "Choose folder…" : action === "trash" ? target.on === null ? "Move to Trash" : "Delete" : action === "remove-root" ? "Remove" : action === "rename" ? "Rename" : "Create", true, enabled, cx => this.submit(cx))));
  }
  render(cx) {
    if (this.role === "menu") return this.renderMenu();
    if (this.role === "dialog") return this.renderDialog();
    prune();
    return this.renderPanel(cx);
  }
  close() { this.input?.release(); super.close(); }
}
