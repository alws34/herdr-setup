// VSCode-style window chrome for the `vscode` layout. Two roles (props.role):
// - "title": the title bar: room for the macOS window buttons, and a command-center box in
//   the middle that opens the side bar's Search section. The box centers on the window, not
//   on this block (sysmon and quota sit right of it): mods can't read other blocks' bounds, so
//   the block's place comes from the window width and its row's px sizes; when the window is
//   too narrow it slides left and shrinks instead of overlapping them.
// - "clock": HH:mm, for the title row's `title-clock` block at the far right. See CLOCK below.
// - "activity": the activity bar: one icon per side bar section (Spaces, Files, Search,
//   Changes, Graph, Agents, Utilization, Extensions, Markdown, Blueprint), then ClickUp, Insights and Customize. A click shows or hides that section (showing opens the side
//   bar); a lit icon is a section that shows. Settings at the bottom. The whole side bar
//   hides with the title bar's panel button or ⌘B, as in VSCode.
// The side bar itself is the vsections mod; this one asks it through shared "vsections.open".
// Explorer and Search aren't sections: they are their own full-height panels left of the side
// bar (`files-panel`, `search-panel`), toggled here.
// layout() changes don't redraw mods, so the activity bar looks at the layout on a timer.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { layout, spaces, run, theme, props, setShared, shared, notify, settings, exec, readTextFile, appHome } from "herdr";

const ITEMS = [
  ["spaces", "Spaces", "mods/workspace-chrome/layers.svg"],
  ["files", "Explorer", "mods/workspace-chrome/files.svg"],
  ["search", "Search", "mods/workspace-chrome/search.svg"],
  ["changes", "Source Control", "mods/workspace-chrome/git-compare.svg"],
  ["graph", "Graph", "mods/git-graph/icons/graph.svg"],
  ["agents", "Agents", "mods/workspace-chrome/terminal.svg"],
  ["utilization", "Utilization", "mods/workspace-chrome/monitor.svg"],
  ["extensions", "Extensions: plugins, skills, MCP, agents", "mods/extensions/icon.svg"],
  ["markdown", "Markdown files", "mods/markdown-browser/markdown.svg"],
  ["blueprint", "Blueprint", "mods/blueprint/icon.svg"],
];
// Not sections: a click opens them.
const ACTIONS = [
  ["clickup", "ClickUp board (⌃⇧U)", "mods/clickup-board/icon.svg", () => run("mod.open", { name: "clickup-board" })],
  ["insights", "Insights: Claude Code usage", "mods/insights/icon.svg", () => {
    const space = spaces().find((s) => s.active);
    run("tab.new", { ...(space ? { space: space.id } : {}), name: "Insights", mod: "insights" });
  }],
  // The Claude desktop app's Customize page (skills, connectors, plugins), as a whole tab.
  ["customize", "Customize: skills, connectors, plugins", "mods/customize/icon.svg", () => {
    const space = spaces().find((s) => s.active);
    run("tab.new", { ...(space ? { space: space.id } : {}), name: "Customize", mod: "customize" });
  }],
  // Copy on select is opt-in (copy-on-select reads shared "copy-on-select.on"); lit while on.
  ["copy", () => `Copy on select: ${shared("copy-on-select.on") ? "on" : "off"}`, "mods/copy-on-select/copy.svg", () => {
    const on = !shared("copy-on-select.on");
    setShared("copy-on-select.on", on);
    notify({ title: `Copy on select: ${on ? "on" : "off"}`, level: "info", timeout: 1500 });
  }, () => Boolean(shared("copy-on-select.on"))],
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}

// Slide-out panels, not side bar sections. Markdown joined them 2026-11-01 ("like the explorer").
const PANELS = { files: "files-panel", search: "search-panel", markdown: "md-panel" };

// toggle: the activity bar (show or hide); otherwise always show.
function open(id, toggle, cx) {
  const panel = PANELS[id] && find(layout(), PANELS[id]);
  if (panel) run(toggle ? "layout.toggle" : "layout.show", { id: PANELS[id] });
  else setShared("vsections.open", { id, toggle, at: Date.now() });
  // A panel's mod starts when first shown: ask for focus once it has.
  if (id === "search") cx.spawn(async (cx) => { await cx.sleep(150); setShared("term-search.focus", Date.now()); });
}

// Which sections show in the side bar now (collapsed ones too).
function shown() {
  const tree = layout();
  const bar = !find(tree, "sections")?.hidden;
  return ITEMS.map(([id]) => id).filter((id) => {
    if (PANELS[id] && find(tree, PANELS[id])) return !find(tree, PANELS[id]).hidden;
    const head = find(tree, `sec-${id}-head`);
    return bar && head && !head.hidden;
  });
}

// CLOCK. Side and hour cycle follow macOS. The mod runtime has no Intl and toLocaleTimeString is
// always en-US (checked 2026-11-03), so Foundation is asked once, through osascript: the first
// preferred language's direction (right-to-left: the clock goes on the left, after the window
// buttons, and the `title-clock` block hides; else that block shows it on the right) and the
// locale's hour pattern ("j": "H" is 24h, "h a" 12h), AppleICUForce24HourTime/12HourTime winning.
// Overrides go in mods/vs-chrome/config.json, not settings.json: settings() returns only the
// app's own keys (checked 2026-11-03). { "clock": { "show": true, "side": "auto" | "left" |
// "right", "format": "auto" | "24h" | "12h" } }, read when the mod loads.
const LOCALE_JS = `ObjC.import("Foundation");
const l = $.NSLocale.currentLocale, d = $.NSUserDefaults.standardUserDefaults, lang = $.NSLocale.preferredLanguages.objectAtIndex(0);
const force = (k) => { const v = d.objectForKey(k); return v.isNil() ? null : Boolean(v.boolValue); };
JSON.stringify({ hour: ObjC.unwrap($.NSDateFormatter.dateFormatFromTemplateOptionsLocale("j", 0, l)),
  rtl: $.NSLocale.characterDirectionForLanguage(lang) == 2,
  force24: force("AppleICUForce24HourTime"), force12: force("AppleICUForce12HourTime") })`;
const CLOCK_W = 60;
let clockPrefs = null;

function loadClock() {
  clockPrefs ??= Promise.all([
    exec("osascript", ["-l", "JavaScript", "-e", LOCALE_JS]).then((r) => JSON.parse(r.stdout)).catch(() => ({})),
    readTextFile(`${appHome()}/mods/vs-chrome/config.json`).then((s) => JSON.parse(s ?? "{}").clock ?? {}).catch(() => ({})),
  ]).then(([sys, cfg]) => ({
    show: cfg.show !== false,
    side: ["left", "right"].includes(cfg.side) ? cfg.side : sys.rtl ? "left" : "right",
    h12: cfg.format === "12h" || (cfg.format !== "24h" && !sys.force24 && (sys.force12 || /[hK]/.test(sys.hour ?? ""))),
  }));
  return clockPrefs;
}

function clockText(h12) {
  const d = new Date(), h = d.getHours(), m = String(d.getMinutes()).padStart(2, "0");
  return h12 ? `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}` : `${String(h).padStart(2, "0")}:${m}`;
}

// px of the shown blocks left and right of the title block in its row (layout px are zoom-1
// px, like mod px).
function besideTitle() {
  const me = (n) => n.id === "title-bar" || (n.content?.mod === "vs-chrome" && n.content?.props?.role === "title");
  const row = (function walk(n) {
    if (n?.children?.some(me)) return n;
    for (const k of n?.children ?? []) { const hit = walk(k); if (hit) return hit; }
    return null;
  })(layout());
  let before = 0, after = 0, past = false;
  for (const k of row?.type === "row" ? row.children : []) {
    if (me(k)) past = true;
    else if (!k.hidden) { if (past) after += k.size?.px ?? 0; else before += k.size?.px ?? 0; }
  }
  return { before, after };
}

function viewWidth() {
  return window.viewport_size().width / (Number(settings().zoom) || 1);
}

export default class Chrome extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "title";
    this.seen = "";
    // The clock draws nothing from the layout: no poll.
    if (this.role !== "clock") cx.timer.every(400, (cx) => {
      // The title also redraws when the window's width changes (the box's place depends on it).
      let width = "";
      try { if (this.role === "title") width = `|${viewWidth()}`; } catch { /* no window here: resizes still redraw */ }
      const now = shown().join() + width;
      if (now !== this.seen) { this.seen = now; cx.notify(); }
    });
    if (this.role === "activity") return;
    cx.spawn(async (cx) => {
      const c = this.clock = await loadClock();
      if (this.role === "title") {
        const block = find(layout(), "title-clock"), want = c.show && c.side === "right";
        if (block && Boolean(block.hidden) === want) run(want ? "layout.show" : "layout.hide", { id: "title-clock" });
      }
      cx.notify();
      if (!c.show || (c.side === "left") !== (this.role === "title")) return;
      // Redraw on each minute boundary (+50 ms so the new minute has begun).
      for (;;) { await cx.sleep(60000 - (Date.now() % 60000) + 50); cx.notify(); }
    });
  }

  render() {
    const t = theme();
    if (this.role === "activity") {
      const on = shown();
      const button = (id, label, icon, active, click) => div().id(`act-${id}`).w_full().h(46).flex().items_center().justify_center().relative().cursor_pointer()
        .text_color(active ? t.foreground : t.dim).hover((s) => s.text_color(t.foreground)).tooltip(label).on_click(click)
        .when(active, (el) => el.child(div().absolute().left(0).top(10).w(2).h(26).bg(t.accent)))
        .child(svg(icon).size(22));
      return v_flex().size_full().items_center()
        .children(ITEMS.map(([id, label, icon]) => button(id, label, icon, on.includes(id), (_e, cx) => { open(id, true, cx); this.seen = ""; cx.notify(); })))
        // Actions sit at the bottom, by Settings: right under the section icons, a click meant
        // for Blueprint kept opening the ClickUp board (2026-11-01).
        .child(div().flex_1())
        .child(div().w(24).h(1).my(4).bg(t.border))
        .children(ACTIONS.map(([id, label, icon, go, lit]) => button(id, typeof label === "function" ? label() : label, icon, Boolean(lit?.()), () => go())))
        .child(button("settings", "Settings", "mods/workspace-chrome/settings.svg", false, () => run("app.settings")));
    }
    const c = this.clock;
    const clock = (el) => el.whitespace_nowrap().text_size(11).text_color(t.muted).child(clockText(c.h12));
    if (this.role === "clock") {
      return div().size_full().flex().items_center().justify_center()
        .when(Boolean(c?.show && c.side === "right"), clock);
    }
    const space = spaces().find((s) => s.active), barShown = !find(layout(), "sections")?.hidden;
    const leftClock = Boolean(c?.show && c.side === "left");
    // The box stays between lo (window buttons, a left clock) and hi (the side bar button). It
    // centers on the window (`mid`, in this block's px), shrinking to fit; below 240 px wide it
    // can't, so it keeps 240 and slides left instead.
    const win = viewWidth(), { before, after } = besideTitle(), mid = win / 2 - before;
    const lo = 84 + (leftClock ? CLOCK_W : 0), hi = win - before - after - 40;
    let w = Math.min(460, 2 * Math.min(mid - lo, hi - mid));
    if (w < 240) w = Math.min(240, hi - lo);
    const x = Math.max(lo, Math.min(mid - w / 2, hi - w));
    return h_flex().size_full().pl(84).pr(10).items_center().relative()
      .when(leftClock, clock)
      .child(div().id("toggle-sidebar").absolute().right(8).top(5).size(24).flex().items_center().justify_center().rounded(5)
        .text_color(barShown ? t.foreground : t.dim).hover((s) => s.bg(t.hover)).tooltip("Toggle Primary Side Bar (⌘B)")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { run("layout.toggle", { id: "sections" }); this.seen = ""; cx.notify(); })
        .child(svg("mods/workspace-chrome/panel-left.svg").size(16)))
      .when(w >= 80, (el) => el.child(h_flex().id("command-center").absolute().left(x).top(5).w(w).h(24).px(10).gap(8).items_center().justify_center().rounded(6)
        .bg(t.surface).border_1().border_color(t.input).text_size(12).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip("Search all terminals (⌘⇧F)")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => open("search", false, cx))
        .child(svg("mods/workspace-chrome/search.svg").size(13))
        .child(div().truncate().child(space?.name ?? "Search"))));
  }
}
