// Copy Selected Text to Clipboard: when you let go of the mouse after dragging a selection
// (or after a double/triple-click) in a terminal, copy it, like the Herdr TUI.
//
// Mods only see presses (on_mouse_down_out), not releases. So on each left
// press this asks macOS when the button comes back up (one short osascript
// that exits on release), and copies then, once. terminal.copy does nothing
// when nothing is selected. Hold Cmd, Ctrl or Option while pressing to skip it.
// After a copy, Herdr's own notification (the toast mod) says "Copied".
// Off by default (2026-11-01): shared "copy-on-select.on" turns it on, from the activity bar's
// "Copy on select" toggle (vs-chrome) or the key command "copy-on-select.toggle".

import { View, div } from "gpui-kit";
import { focused, run, notify, exec, shared, setShared, nextCommand } from "herdr";

const KEY = "copy-on-select.on";
export function toggleCopyOnSelect() {
  const on = !shared(KEY);
  setShared(KEY, on);
  notify({ title: `Copy on select: ${on ? "on" : "off"}`, level: "info", timeout: 1500 });
}

const DRAG_PX = 4; // movement that counts as a drag, not a click

// Waits until the left button is up (at most ~60 s), then exits.
const WAIT_FOR_RELEASE =
  'ObjC.import("AppKit"); var t = 0;' +
  " while (($.NSEvent.pressedMouseButtons & 1) && t < 3000) { delay(0.02); t++; }" +
  ' "up"';

export default class CopyOnSelect extends View {
  init(_props, cx) {
    this.press = 0; // bumps on every press, so an older wait is ignored
    cx.spawn(async () => { for (;;) { if ((await nextCommand()) === "toggle") toggleCopyOnSelect(); } });
  }

  start(event, cx) {
    if (event.button !== "left" || !shared(KEY)) return;
    const m = event.modifiers;
    if (m.platform || m.control || m.alt) return;

    const press = ++this.press;
    const down = event.position;
    const multiClick = event.click_count >= 2; // word/line selection
    let dragged = false;

    // Watch for movement while the button is held.
    const watch = cx.timer.every(40, () => {
      const p = window.mouse_position();
      if (Math.abs(p.x - down.x) > DRAG_PX || Math.abs(p.y - down.y) > DRAG_PX) dragged = true;
    });

    cx.spawn(async () => {
      try {
        await exec("osascript", ["-l", "JavaScript", "-e", WAIT_FOR_RELEASE]);
      } catch (_) {
        // Fall through: treat as released.
      }
      watch.cancel();
      if (press !== this.press) return; // a newer press took over
      const p = window.mouse_position();
      if (Math.abs(p.x - down.x) > DRAG_PX || Math.abs(p.y - down.y) > DRAG_PX) dragged = true;
      if (!(dragged || multiClick)) return;
      if (!focused()?.terminal) return;
      run("terminal.copy");
      notify({ title: "Copied", level: "success", timeout: 1500 });
    });
  }

  render(_cx) {
    return div()
      .id("copy-on-select")
      .size_full()
      .on_mouse_down_out((event, cx) => this.start(event, cx));
  }
}
