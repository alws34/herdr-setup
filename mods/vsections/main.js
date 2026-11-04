// VSCode-style side bar sections: Search, Files, Changes, Graph, Agents, ... in the
// `sections` column. Each section is a header block (this mod) `sec-<id>-head` and a body
// block `sec-<id>-body`.
//
// Herdr's dividers resize only the two siblings beside them, so a collapsed header between
// two open sections would take the drag. As VSCode does, collapsed (and hidden) sections ride
// along in the nearest open section's group, `grp-<id>`, and only groups sit side by side
// in `sections-body`: every divider is between two open sections.
//
// Roles (props):
// - { role: "bar" }: the "EXPLORER" row with a ⋯ menu. It keeps each layout's state (shared
//   "vsections.spaces", keyed "<layout>|global": which sections show, which are collapsed, their
//   sizes), records drags, and rebuilds the tree from the saved state when it starts.
// - { section, title }: a header; a click collapses or expands its section. Dragged out of the
//   side bar to the right (into the main area) or its hover ⤢ button, it opens that section's
//   mod as a full tab in the shown space, like the Insights button (asked for 2026-11-01).
//   While dragged out, Windows-snap style (asked for 2026-11-01): a ghost of the header follows
//   the pointer and a translucent box shows where it lands. The middle of the main area opens a
//   tab; its edges (and only there) split the section's mod beside the shown pane on that side.
//   Escape or a release back over the side bar cancels.
// - { role: "menu" }: the ⋯ popup.
// - { role: "drag" }: that ghost and box, a frameless full-window popup opened only once the
//   pointer leaves the side bar (so a click or a reorder inside it never meets the popup). It
//   polls the pointer itself; the header that opened it decides the drop, from the same zoneAt().
//
// layout() changes don't redraw mods, so copies look at the layout on a short timer.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { layout, spaces, panes, focused, settings, run, theme, props, shared, setShared, openOverlay, closeOverlay, exec } from "herdr";

// Waits until the left button is up (at most ~28 s, under exec's 30 s limit), then prints "up". Mods hear presses, not a
// release over another block (the main area is a terminal), so as copy-on-select does, a
// header press asks macOS when the button comes back up, then looks where the pointer is.
const WAIT_FOR_RELEASE =
  'ObjC.import("AppKit"); var t = 0;' +
  " while (($.NSEvent.pressedMouseButtons & 1) && t < 1400) { delay(0.02); t++; }" +
  ' ($.NSEvent.pressedMouseButtons & 1) ? "held" : "up"';
// How far right of the side bar the release must land to count as a drop on the main area.
const DROP_PX = 24;
// The share of the main area, from each edge, that splits instead of opening a tab.
const EDGE = 0.22;
const ZONE_LABEL = { center: "Open as tab", left: "Split left", right: "Split right", top: "Split up", bottom: "Split down" };

// Where a release at window point `p` lands: null (cancel), "center" or an edge of `area`
// (window coordinates). Right of the side bar but outside the main area (tab bars, status bar)
// is the center: a tab.
function zoneAt(p, area, right) {
  const view = window.viewport_size();
  if (p.x < right + DROP_PX || p.x >= view.width || p.y <= 0 || p.y >= view.height) return null;
  if (p.x < area.x || p.x > area.x + area.w || p.y < area.y || p.y > area.y + area.h) return "center";
  const fx = (p.x - area.x) / area.w, fy = (p.y - area.y) / area.h;
  const [side, dist] = Object.entries({ left: fx, right: 1 - fx, top: fy, bottom: 1 - fy }).sort((a, b) => a[1] - b[1])[0];
  return dist < EDGE ? side : "center";
}

// The box a zone fills: all of the main area for a tab, the half on that side for a split.
function zoneBox(zone, a) {
  switch (zone) {
    case "left": return { ...a, w: a.w / 2 };
    case "right": return { ...a, x: a.x + a.w / 2, w: a.w / 2 };
    case "top": return { ...a, h: a.h / 2 };
    case "bottom": return { ...a, y: a.y + a.h / 2, h: a.h / 2 };
    default: return a;
  }
}

// Window px Herdr keeps above a `titlebar: "none"` layout on macOS (the hidden title bar's
// height, unscaled; measured 2026-11-01: everything sat 28 px below the layout's px sums).
// ponytail: a constant; if zoom or another macOS changes it, the preview's top edge drifts.
const TOP_INSET = 28;

// The tab block's box in window coordinates: from the side bar's right edge to the window's,
// minus the fixed-px rows above and below it in the layout (tab bars, title, status), scaled
// by `scale` (window px per layout px: zoom). Mods can't read other blocks' bounds.
function mainArea(left, scale) {
  const path = [];
  const walk = (n) => {
    path.push(n);
    if (n.content?.tab === "active") return true;
    for (const c of n.children ?? []) if (!c.hidden && walk(c)) return true;
    path.pop();
    return false;
  };
  const view = window.viewport_size();
  let above = 0, below = 0;
  if (walk(layout())) {
    for (let i = 0; i + 1 < path.length; i++) {
      if (path[i].type !== "column") continue;
      const kids = path[i].children.filter((k) => !k.hidden), at = kids.indexOf(path[i + 1]);
      kids.forEach((k, j) => { if (j < at) above += k.size?.px ?? 0; else if (j > at) below += k.size?.px ?? 0; });
    }
  }
  const top = TOP_INSET + above * scale;
  return { x: left, y: top, w: view.width - left, h: view.height - top - below * scale };
}

const KEY = "vsections.spaces";
const HEAD = 26;
const SECTIONS = [
  ["spaces", "Spaces", { mod: "spaces-tree" }],
  ["status", "Spaces Status", { mod: "spaces-glow" }],
  ["search", "Search", { mod: "term-search" }],
  ["files", "Explorer", { mod: "files-plus", props: { editor: true } }],
  ["changes", "Changes", { mod: "changes-vs" }],
  ["graph", "Graph", { mod: "git-graph" }],
  ["agents", "Agents", { mod: "agents" }],
  ["blueprint", "Blueprint", { mod: "blueprint", props: { panel: true } }],
  ["servers", "Servers", { mod: "servers" }],
  ["utilization", "Utilization", { mod: "sysmon" }],
  ["extensions", "Extensions", { mod: "extensions" }],
  // Markdown is a slide-out panel now (vscode layout's `md-panel`, opened from the activity bar).
];

// The sections in the order dragged into (shared "vsections.order", for every space).
function ordered() {
  const saved = (shared("vsections.order") ?? []).filter((id) => SECTIONS.some(([s]) => s === id));
  return [...saved.map((id) => SECTIONS.find(([s]) => s === id)), ...SECTIONS.filter(([s]) => !saved.includes(s))];
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}

// The state the layout shows now; `prev` keeps the sizes of sections that are closed.
function current(tree, prev) {
  const sec = {};
  for (const [id] of SECTIONS) {
    const head = find(tree, `sec-${id}-head`), body = find(tree, `sec-${id}-body`);
    if (!head) continue;
    const hidden = Boolean(head.hidden), collapsed = !hidden && Boolean(body?.hidden);
    const open = !hidden && !collapsed;
    sec[id] = { hidden, collapsed, size: open ? find(tree, `grp-${id}`)?.size ?? prev?.sec?.[id]?.size ?? null : prev?.sec?.[id]?.size ?? null };
  }
  return { panel: Boolean(find(tree, "sections")?.hidden), sec };
}

// The `sections-body` children for a state: one group per open section, closed ones attached
// to the open section before them (or the first one, when they come first).
function groups(state, tree) {
  const member = ([id, title, content]) => {
    const s = state.sec[id] ?? {};
    return [
      { id: `sec-${id}-head`, type: "block", size: { px: HEAD }, hidden: Boolean(s.hidden), content: { mod: "vsections", props: { section: id, title } } },
      { id: `sec-${id}-body`, type: "block", hidden: Boolean(s.hidden || s.collapsed), content },
    ];
  };
  const out = [];
  let lead = [];
  for (const sec of ordered().filter(([id]) => find(tree, `sec-${id}-head`))) {
    const s = state.sec[sec[0]] ?? {};
    if (s.hidden || s.collapsed) {
      if (out.length) out[out.length - 1].children.push(...member(sec)); else lead.push(...member(sec));
      continue;
    }
    out.push({ id: `grp-${sec[0]}`, type: "column", resizable: false, size: s.size ?? { weight: 1 }, children: [...lead, ...member(sec)] });
    lead = [];
  }
  if (lead.length) out.push({ id: "grp-closed", type: "column", resizable: false, size: { weight: 1 }, children: lead });
  // Nothing open: the headers sit at the top, the rest stays empty.
  return out;
}

const shape = (nodes) => JSON.stringify(nodes, (k, v) => (k === "size" ? undefined : v));

function apply(state) {
  const tree = layout(), sections = find(tree, "sections");
  if (!sections) return;
  // Herdr folds a one-child column into its parent, so `sections-body` can be gone, the groups
  // sitting right under `sections` after the bar. apply() used to stop there, so collapse, hide,
  // reorder and the activity bar did nothing (review 2026-11-01). Read the groups from wherever
  // they are and always write the wrapper back.
  const body = find(tree, "sections-body");
  const now = body ? body.children : sections.children.filter((c) => c.id !== "sections-bar");
  const next = groups(state, tree);
  const sizes = (nodes) => JSON.stringify(nodes.map((n) => [n.id, n.size]));
  if (!body || shape(now) !== shape(next) || sizes(now) !== sizes(next) || Boolean(sections.hidden) !== Boolean(state.panel)) {
    const bar = find(tree, "sections-bar");
    sections.children = [...(bar ? [bar] : []), { ...(body ?? { id: "sections-body", type: "column" }), children: next }];
    sections.hidden = Boolean(state.panel);
    run("layout.set", { layout: tree });
  }
}

// Saved per layout only: one side bar for every space, so switching spaces never changes it
// (asked for 2026-11-01). Layouts hold different sections, so each keeps its own.
const activeSpace = () => `${shared("layout") ?? ""}|global`;

// A change to the shown space's state: save it and lay it out.
function change(fn) {
  const space = activeSpace(), all = shared(KEY) ?? {};
  // From the live layout, not the saved copy (saved once a second): a click right after a divider
  // drag used to snap the sizes back.
  const state = current(layout(), all[space]);
  fn(state);
  if (space) setShared(KEY, { ...all, [space]: state });
  apply(state);
}

function toggleCollapsed(id) {
  change((state) => {
    const s = state.sec[id] ??= {};
    s.collapsed = !s.collapsed;
    if (!s.collapsed && s.size?.px === HEAD) s.size = null;
  });
}

// The section's mod as its own tab in the shown space, with the props its body has.
function openAsTab(id) {
  const [, title, content] = SECTIONS.find(([s]) => s === id) ?? [];
  if (!content) return;
  const space = spaces().find((s) => s.active);
  run("tab.new", { ...(space ? { space: space.id } : {}), name: title, mod: content.mod, ...(content.props ? { props: content.props } : {}) });
}

// The section's mod as a pane beside the shown tab's focused pane (else its terminal). Herdr
// splits only right or down, so left/up split that way, then swap the new pane across, as
// markdown-browser does when it replaces a preview.
async function openAsPane(id, side, cx) {
  const [, , content] = SECTIONS.find(([s]) => s === id) ?? [];
  const tab = spaces().find((s) => s.active)?.tabs.find((t) => t.active);
  if (!content || !tab) return;
  const tabPanes = panes().filter((p) => p.tab === tab.id);
  const from = tabPanes.find((p) => p.pane === focused()?.pane) ?? tabPanes.find((p) => p.terminal) ?? tabPanes[0];
  const before = new Set(panes().map((p) => p.pane));
  const across = side === "left" || side === "right";
  run("pane.split", { direction: across ? "right" : "down", ...(from ? { pane: from.pane } : {}), mod: content.mod, ...(content.props ? { props: content.props } : {}) });
  if (side === "right" || side === "bottom") return;
  const until = async (test) => { for (let i = 0; i < 40; i++) { if (test()) return true; await cx.sleep(25); } return false; };
  let fresh;
  if (!await until(() => (fresh = panes().find((p) => !before.has(p.pane) && p.tab === tab.id)))) return;
  run("pane.focus", { pane: fresh.pane });
  if (await until(() => focused()?.pane === fresh.pane)) run("pane.swap", { direction: across ? "left" : "up" });
}

function toggleHidden(id) {
  change((state) => { const s = state.sec[id] ??= {}; s.hidden = !s.hidden; if (!s.hidden) s.collapsed = false; });
}

export default class Sections extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "header";
    if (this.role === "drag") return this.initDrag(cx);
    this.seen = "";
    this.press = 0; // bumps on every header press, so an older release wait is ignored
    cx.timer.every(this.role === "bar" ? 250 : 400, (cx) => this.tick(cx)); // the bar syncs here, not in render
  }

  tick(cx) {
    const tree = layout();
    if (this.role === "bar") this.record(tree);
    const look = JSON.stringify(current(tree, null));
    if (look !== this.seen) { this.seen = look; cx.notify(); }
  }

  // Bar only: handles "vsections.open" and reorders, and lays out the saved state on start.
  sync() {
    // The tab bar's Search button (shared "vsections.open"): show and expand that section.
    const ask = shared("vsections.open");
    if (ask && ask.at !== this.opened) {
      const fresh = this.opened !== undefined;
      this.opened = ask.at;
      if (fresh) change((state) => {
        const s = state.sec[ask.id] ??= {};
        // toggle (the activity bar): show or hide just that section; showing it opens the side bar.
        if (ask.toggle && !state.panel && !s.hidden) { s.hidden = true; return; }
        state.panel = false; s.hidden = false; s.collapsed = false;
      });
    }
    const order = ordered().map(([id]) => id).join();
    if (order !== this.order) {
      const fresh = this.order !== undefined;
      this.order = order;
      if (fresh) change(() => {});
    }
    const space = activeSpace();
    if (!space || space === this.space) return;
    const first = this.space === undefined;
    const want = (shared(KEY) ?? {})[space];
    this.space = space;
    if (want) { apply(want); this.pendingUntil = Date.now() + 1500; }
    else if (!first) this.pendingUntil = 0;
  }

  // Bar only: drags change group sizes and the Explorer button the panel; save them.
  record(tree) {
    this.sync();
    if (!this.space || Date.now() < (this.pendingUntil ?? 0)) return;
    const all = shared(KEY) ?? {}, now = current(tree, all[this.space]);
    if (JSON.stringify(all[this.space]) !== JSON.stringify(now)) setShared(KEY, { ...all, [this.space]: now });
  }

  // Header only: when the button comes up, zoneAt() says what the drop does: nothing (a click
  // or a reorder inside the side bar, a cancel), a tab, or a split. Meanwhile, once the pointer
  // leaves the side bar, the "drag" popup shows the ghost and the landing box. The popup is
  // closed in `finally`, and closes itself on a release or a stale drag, so it never lingers.
  watchDragOut(event, cx, id, title) {
    const at = Date.now();
    setShared("vsections.drag", { id, at });
    if (!event.local_position || !event.bounds) return;
    const press = ++this.press, b = event.bounds;
    const right = event.position.x - event.local_position.x + b.width;
    // Window px per layout/mod px. (Not the header's own height: dividers trim it.)
    const scale = Number(settings().zoom) || 1, area = mainArea(right, scale);
    let released = false, overlay = null;
    cx.spawn(async (cx) => {
      while (!released && press === this.press) {
        if (window.mouse_position().x >= right + DROP_PX) {
          // A popup is as tall as its content, so the popup and its root both get the window's
          // size, in mod px (window px / zoom).
          const view = window.viewport_size(), width = view.width / scale, height = view.height / scale;
          overlay = openOverlay({ mod: "vsections", kind: "popup", frame: "none", at: { x: 0, y: 0 }, width, height,
            props: { role: "drag", at, title, right, area, scale, width, height, grab: event.local_position, size: { w: b.width, h: b.height } } });
          return;
        }
        await cx.sleep(30);
      }
    });
    cx.spawn(async (cx) => {
      try {
        const r = await exec("osascript", ["-l", "JavaScript", "-e", WAIT_FOR_RELEASE]);
        if (r.stdout.trim() !== "up") return; // still held after ~28 s, or exec gave up: no drop
        if (press !== this.press) return;
        const drag = shared("vsections.drag");
        if (drag?.at === at && drag.cancelled) return; // Escape closed the popup
        const zone = zoneAt(window.mouse_position(), area, right);
        if (zone === "center") openAsTab(id);
        else if (zone) await openAsPane(id, zone, cx);
      } catch (_) {
        // osascript missing or killed: no drop.
      } finally {
        released = true;
        if (overlay) closeOverlay(overlay);
        // A release outside the headers leaves the reorder marker set; clear this press's.
        if (shared("vsections.drag")?.at === at) setShared("vsections.drag", null);
      }
    });
  }

  // Drag popup only: follow the pointer (~40 fps, redrawing only when it moved) until the button
  // comes up over it or the drag goes stale (its header reloaded mid-drag).
  initDrag(cx) {
    this.p = window.mouse_position();
    cx.spawn(async (cx) => {
      for (;;) {
        const drag = shared("vsections.drag");
        if (drag?.at !== props().at || Date.now() - drag.at > 65000) return this.endDrag();
        const p = window.mouse_position();
        if (p.x !== this.p.x || p.y !== this.p.y) { this.p = p; cx.notify(); }
        await cx.sleep(25);
      }
    });
  }

  endDrag() {
    if (this.ended) return;
    this.ended = true;
    closeOverlay(props().overlay);
  }

  // Closed while the button is still down (Escape): tell the header not to drop.
  async close() {
    const drag = shared("vsections.drag");
    if (this.role === "drag" && !this.ended && drag?.at === props().at) setShared("vsections.drag", { ...drag, cancelled: true });
  }

  renderDrag() {
    const t = theme(), { title, right, area, scale, width, height, grab, size } = props();
    // Window px to mod px. Herdr keeps a popup a few px inside the window, so draw relative to
    // where it really is: learned from the first pointer move over it (else Herdr's 8 px).
    const k = 1 / scale, o = this.origin ?? { x: 8, y: 8 };
    const zone = zoneAt(this.p, area, right), box = zone && zoneBox(zone, area);
    const inset = 12;
    return div().id("vs-drag").w(width).h(height).relative()
      .on_mouse_move((e, cx) => {
        if (this.origin || !e.local_position) return;
        this.origin = { x: (e.position.x - e.local_position.x) * k, y: (e.position.y - e.local_position.y) * k };
        cx.notify();
      })
      .on_mouse_up("left", () => this.endDrag())
      .when(Boolean(box), (el) => el.child(div().absolute()
        .left((box.x + inset) * k - o.x).top((box.y + inset) * k - o.y).w((box.w - 2 * inset) * k).h((box.h - 2 * inset) * k)
        .transition("left", 120).transition("top", 120).transition("width", 120).transition("height", 120)
        .child(div().absolute().size_full().rounded(10).bg(t.accent).opacity(0.18))
        .child(div().absolute().size_full().rounded(10).border(2).border_color(t.accent).opacity(0.7))
        .child(div().size_full().flex().items_center().justify_center()
          .child(div().px(12).py(6).rounded(8).bg(t.popover).border(1).border_color(t.accent)
            .text_size(12).font_semibold().text_color(t.foreground).child(ZONE_LABEL[zone])))))
      .child(h_flex().absolute().left((this.p.x - grab.x) * k - o.x).top((this.p.y - grab.y) * k - o.y).w(size.w * k).h(size.h * k)
        .px(6).gap(4).items_center().rounded(6).bg(t.raised).border(1).border_color(t.accent).opacity(0.75)
        .child(svg("mods/files/chevron-down.svg").size(12).text_color(t.muted))
        .child(div().flex_1().text_size(11).font_semibold().text_color(t.foreground).child(String(title).toUpperCase())));
  }

  render() {
    if (this.role === "drag") return this.renderDrag();
    const t = theme(), tree = layout();
    if (this.role === "bar") {
      return h_flex().size_full().px(12).items_center().gap(8).border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child("EXPLORER"))
        .child(div().id("vs-menu").size(22).flex().items_center().justify_center().rounded(5).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Choose sections")
          .on_click(() => openOverlay({ mod: "vsections", kind: "popup", width: 200, height: SECTIONS.length * 28 + 44, props: { role: "menu" } }))
          .child("⋯"));
    }
    if (this.role === "menu") {
      return v_flex().id("vs-menu-list").w_full().p(5).bg(t.popover).text_size(12.5)
        .child(div().px(8).pt(4).pb(6).text_size(10.5).text_color(t.dim).child("Show sections"))
        .children(ordered().filter(([id]) => find(tree, `sec-${id}-head`)).map(([id, title]) => {
          const on = !find(tree, `sec-${id}-head`).hidden;
          return h_flex().id(`vs-${id}`).h(28).px(8).gap(9).rounded(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { toggleHidden(id); this.seen = ""; cx.notify(); })
            .child(div().w(14).text_color(t.accent).child(on ? "✓" : ""))
            .child(div().text_color(t.foreground).child(title));
        }));
    }
    const id = props()?.section ?? "", title = props()?.title ?? id;
    const collapsed = Boolean(find(tree, `sec-${id}-body`)?.hidden);
    const first = ordered().find(([s]) => find(tree, `sec-${s}-head`) && !find(tree, `sec-${s}-head`).hidden)?.[0] === id;
    // Drag a header onto another to move its section there (each header is its own block,
    // so the drag goes through shared "vsections.drag"; a stale one expires).
    const drag = shared("vsections.drag"), dragging = drag && drag.id !== id && Date.now() - drag.at < 15000;
    return h_flex().id(`vs-head-${id}`).size_full().px(6).gap(4).items_center().cursor_pointer().relative()
      .when(!first, (el) => el.border_t(1).border_color(t.border))
      .hover((s) => s.bg(t.hover))
      .when(Boolean(dragging && this.over), (el) => el.child(div().absolute().left(0).right(0).top(0).h(2).bg(t.accent)))
      .on_hover((over, cx) => { if (this.over !== over) { this.over = over; cx.notify(); } })
      .on_mouse_down("left", (e, cx) => this.watchDragOut(e, cx, id, title))
      .on_mouse_up("left", () => {
        if (dragging) {
          const ids = ordered().map(([s]) => s).filter((s) => s !== drag.id);
          ids.splice(ids.indexOf(id), 0, drag.id);
          setShared("vsections.order", ids);
        }
        if (drag) setShared("vsections.drag", null);
      })
      .on_click((_e, cx) => { toggleCollapsed(id); this.seen = ""; cx.notify(); })
      .child(svg(`mods/files/chevron-${collapsed ? "right" : "down"}.svg`).size(12).text_color(t.muted))
      .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child(title.toUpperCase()))
      .when(Boolean(this.over && !dragging), (el) => el.child(div().id(`vs-tab-${id}`).size(20).flex().items_center().justify_center()
        .rounded(4).text_size(12).text_color(t.muted).hover((s) => s.bg(t.selected).text_color(t.foreground)).tooltip("Open as tab")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); openAsTab(id); })
        .child("⤢")));
  }
}
