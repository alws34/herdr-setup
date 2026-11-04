// The slim header over each tool in the vscode layout's right-hand `tools` column (Side chat,
// Browser, Terminal, Canvases), like the Claude desktop app's side panel. Props: { tool }.
// Over Canvases it also switches what that tool shows (shared "tools.canvas"): ‹ back to the list,
// and a chip per open canvas (its title; × closes it). It only asks; tabs-vs, the panel's only controller, does: ✕ closes that
// tool for the shown tab (shared "tools.close"), ⤢ / ⤡ moves it to the main area, full size in
// place of the session, and back (shared "tools.move"). Dragging the header does the same (asked
// 2026-11-03): from the panel onto the main area (left of the panel), or from the main area onto
// its right quarter. Herdr has no drag between blocks and mods hear no release over another block,
// so, as vsections' header does, a press asks macOS when the button is up, then looks where the
// pointer is. With { empty: true } it stands in for the terminal block while the terminal starts.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, props, shared, setShared, spaces, exec } from "herdr";

const NAMES = { sideChat: "Side chat", browser: "Browser", terminal: "Terminal", canvases: "Canvases" };
// vsections' WAIT_FOR_RELEASE, plus "click" when the button was already up as it started: osascript
// takes a moment to start, and the pointer read after a quick click (then a move left) looked like a drop.
const WAIT_FOR_RELEASE =
  'ObjC.import("AppKit"); var t = 0;' +
  " while (($.NSEvent.pressedMouseButtons & 1) && t < 1400) { delay(0.02); t++; }" +
  ' ($.NSEvent.pressedMouseButtons & 1) ? "held" : t ? "up" : "click"';
const DRAG_PX = 40; // less than this from the press is a click, not a drag

export default class ToolHeader extends View {
  // Header press: when the button comes up, a drop on the other area moves the tool there.
  watchDrag(e, cx, tab, tool, inMain) {
    if (!e.local_position || !e.bounds) return;
    const left = e.position.x - e.local_position.x, width = e.bounds.width, from = e.position.x;
    cx.spawn(async () => {
      const r = await exec("osascript", ["-l", "JavaScript", "-e", WAIT_FOR_RELEASE]).catch(() => null);
      if (r?.stdout.trim() !== "up") return;
      const x = window.mouse_position().x;
      if (Math.abs(x - from) < DRAG_PX) return;
      if (inMain ? x > left + width * 0.75 : x < left) setShared("tools.move", { tab, tool, at: Date.now() });
    });
  }

  render() {
    const t = theme(), { tool, empty } = props() ?? {};
    if (empty) return div().size_full().bg(t.background).flex().items_center().justify_center().text_size(12.5).text_color(t.dim).child("Starting terminal…");
    const tab = spaces().find((s) => s.active)?.tabs.find((x) => x.active)?.id;
    const st = (shared("tools.open") ?? {})[tab] ?? {}, inMain = st.main === tool;
    const canvases = tool === "canvases" ? st.canvas ?? [] : [], viewing = canvases.some((c) => c.id === st.view);
    const canvas = (what) => setShared("tools.canvas", { tab, ...what, at: Date.now() });
    const chip = (c) => {
      const on = c.id === st.view;
      return h_flex().id(`cv-${c.id}`).h(22).max_w(200).min_w(0).pl(8).pr(3).gap(4).items_center().rounded(5).cursor_pointer()
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => canvas({ view: c.id }))
        .child(div().min_w(0).truncate().child(c.title))
        .child(div().id(`cv-x-${c.id}`).px(3).rounded(3).text_color(t.dim).hover((s) => s.bg(t.border).text_color(t.foreground)).tooltip("Close this canvas")
          // On the press, stopped there, so the chip's own click (show it) never starts.
          .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); canvas({ close: c.id }); }).child("×"));
    };
    const button = (id, glyph, tip, ask, act) => div().id(id).flex_none().px(5).rounded(4).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(act ?? (() => setShared(ask, { tab, tool, at: Date.now() }))).child(glyph);
    return h_flex().id(`head-${tool}`).size_full().px(10).gap(6).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .text_size(12).text_color(t.muted).cursor_grab()
      .on_mouse_down("left", (e, cx) => this.watchDrag(e, cx, tab, tool, inMain))
      .when(viewing, (el) => el.child(button("cv-back", "‹", "All canvases", null, () => canvas({ view: null }))))
      .when(!viewing, (el) => el.child(div().flex_none().font_medium().child(NAMES[tool] ?? String(tool ?? "Tool"))))
      .child(h_flex().flex_1().min_w(0).gap(3).overflow_hidden().children(canvases.map(chip)))
      .child(button(`move-${tool}`, inMain ? "⤡" : "⤢", inMain ? "Back to the side panel" : "Open in the main area", "tools.move"))
      .child(button(`close-${tool}`, "✕", "Close", "tools.close"));
  }
}
