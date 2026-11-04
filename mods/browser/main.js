import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { exec, theme, spaces, panes, props, appHome, settings, shared, window as herdrWindow } from "herdr";

// A browser pane: the real Chromium window (./shell, one per Herdr tab, i.e. per Claude
// Code session) floats exactly over this pane. Herdr can't embed a web view, so the pane
// only draws a placeholder with two marker squares in its corners (the shell finds them
// in Herdr's frame to learn where the pane is) and tells the shell, ~20 times a second,
// whether the pane is on screen, whether Herdr is the active app, Herdr's window frame
// and the pane's size. The same browser is what that session's `browser` MCP drives.
// Props: { tab } (the session) for a pane in a tab. Without it, as the vscode layout's
// tools-panel block (`tool-browser`, shown by tabs-vs' "Chrome" button), it follows the
// shown tab: each tab keeps its own browser (started the first time the tab opens it) and
// only the shown tab's is over the block.
// Props { tab, session, url, marker } (tabs-vs, an open canvas in the tools panel): its own
// browser, session "<tab>.cv-<id>", opened at url, on screen while tab is the shown one. Each
// browser block that can be on screen at once paints its own marker color (index `marker`).
// Hiding the block or pane hides the browser and leaves it running for Claude; it quits
// when its tab is gone.
const NAME = "browser";
// shell/marker.cjs looks for exactly this color (index 0), or the one it's sent (others).
const markerRgb = (i) => [254, 1, 253 - 8 * (i % 30)];
const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const INSET = 16; // markers sit this far in, so the window's rounded corners don't show them
const TICK_MS = 50;

const shownTab = () => spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id ?? null;

async function launch(session, url) {
  const r = await exec("node", [`${appHome()}/mods/${NAME}/chrome.mjs`, "ensure", session, ...(url ? [url] : [])]);
  const out = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
  if (!out.ok) throw new Error(out.error ?? (r.stderr.trim() || "could not start the browser"));
  return out.shell;
}

export default class Browser extends View {
  init(_p, cx) {
    this.follow = !props()?.tab;
    this.session = props()?.session ?? props()?.tab ?? shownTab() ?? "default";
    this.marker = markerRgb(props()?.marker ?? 0);
    this.ports = {}; // session -> its shell's port, so switching tabs back needs no relaunch
    this.shell = null; this.error = null; this.size = null; this.starting = false;
    this.sent = ""; this.sentAt = 0; this.sending = false;
    if (!this.follow) this.start(cx);
    exec("node", [`${appHome()}/mods/${NAME}/chrome.mjs`, "gc"]).catch(() => {});
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
  }

  start(cx) {
    const session = this.session;
    this.error = null; this.starting = true;
    cx.spawn(async (cx) => {
      try {
        this.ports[session] = await launch(session, props()?.url);
        if (this.session === session) this.shell = this.ports[session];
      } catch (e) { this.error = String(e?.message ?? e); }
      this.starting = false;
      cx.notify();
    });
  }

  async close() {
    if (this.shell) await this.post({ visible: false }).catch(() => {});
  }

  post(state) {
    return fetch(`http://127.0.0.1:${this.shell}/place`, { method: "POST", body: JSON.stringify(state) });
  }

  // On screen. A pane: its tab is the shown one and no other pane of that tab is zoomed.
  // The tools-panel block: the panel and the block aren't hidden (tabs-vs shows them for the
  // shown tab when it has its browser open).
  shown() {
    if (!this.size?.width) return false;
    // tabs-vs shows the block exactly while the shown tab has its browser open (its state, not
    // layout(): shown/hidden is click state that layout() doesn't report).
    if (this.follow) return Boolean((shared("tools.open") ?? {})[this.session]?.browser);
    const tab = props().tab;
    if (shownTab() !== tab) return false;
    // A canvas: a hidden block keeps its size, so ask tabs-vs' state whether Canvases is open on
    // this canvas (closing Canvases used to leave the canvas window floating).
    const cv = props().session?.split(".cv-")[1];
    if (cv) { const st = (shared("tools.open") ?? {})[tab]; if (!st?.canvases || st.view !== cv) return false; }
    return !panes().some((p) => p.tab === tab && p.zoomed && p.mod !== NAME);
  }

  state() {
    const t = theme();
    let frame = null;
    try { const b = window.bounds(); frame = { x: b.x, y: b.y, width: b.width, height: b.height }; } catch {}
    return {
      visible: this.shown() && Boolean(frame), marker: this.marker, active: Boolean(herdrWindow()?.active), win: frame, size: this.size,
      inset: INSET * (settings().zoom || 1), // style lengths are zoomed; sizes and frames are not
      colors: { bg: t.background, chrome: t.chrome, fg: t.foreground, muted: t.muted, border: t.border, raised: t.raised, hover: t.hover, accent: t.accent },
    };
  }

  // Sends on any change, and at least once a second as a heartbeat (the shell hides
  // the browser when the pane stops talking: Herdr quit, pane gone, mod reloaded).
  tick(cx) {
    if (this.follow) {
      const session = shownTab() ?? "default";
      if (session !== this.session) {
        // Another tab is shown: hide this one's browser now, then show that tab's own.
        if (this.shell) this.post({ visible: false }).catch(() => {});
        this.session = session; this.shell = this.ports[session] ?? null; this.sent = ""; this.error = null;
        cx.notify();
      }
      if (!this.shell && !this.starting && !this.error && this.shown()) this.start(cx);
    }
    // A send that never answers (a browser that hangs or dies mid-reply) would stop this copy
    // for good: after 3 s, start over.
    if (this.sending && Date.now() - this.sendingAt > 3000) { this.sending = false; this.shell = null; this.start(cx); }
    if (!this.shell || this.sending) return;
    const state = this.state(), json = JSON.stringify(state);
    if (json === this.sent && Date.now() - this.sentAt < 1000) return;
    if (!state.visible && json === this.sent && Date.now() - this.sentAt < 5000) return;
    this.sending = true; this.sendingAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        await this.post(state);
        this.sent = json; this.sentAt = Date.now();
      } catch {
        // The browser was quit (⌘Q, crash): start it again.
        this.shell = null; this.start(cx);
      }
      this.sending = false;
    });
  }

  render() {
    const t = theme();
    // Markers only while this copy is on screen, so a hidden copy never confuses the shell.
    const mark = () => div().absolute().size(4).bg(this.shown() ? hex(this.marker) : t.background);
    return div().id("root").relative().size_full().bg(t.background)
      .on_size_change((size, cx) => {
        const next = { width: Math.round(size.width), height: Math.round(size.height) };
        if (next.width === this.size?.width && next.height === this.size?.height) return;
        this.size = next;
        cx.notify(); // the markers depend on it
      })
      .child(v_flex().size_full().items_center().justify_center().gap(8).text_size(12.5).text_color(this.error ? t.blocked : t.dim)
        .child(this.error ? `Browser: ${this.error}` : "Browser — loading…")
        .when(Boolean(this.error), (el) => el.child(div().id("br-retry").px(10).py(3).rounded(6).border_1().border_color(t.border).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.start(cx)).child("Try again"))))
      .child(mark().top(INSET).left(INSET))
      .child(mark().bottom(INSET).right(INSET));
  }
}
