import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, setShared, layout, settings, nextCommand, terminals, hc, notify, machines, exec, appHome, readTextFile } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The node whose child has this id.
function parentOf(node, id) {
  for (const child of node?.children ?? []) {
    if (child.id === id) return node;
    const found = parentOf(child, id);
    if (found) return found;
  }
  return null;
}

// Shows Search and focuses its box: the vscode layout's `search-panel`, else the side bar's
// Search section (glass-code's `sections`).
function openSearch(cx) {
  if (find(layout(), "search-panel")) run("layout.show", { id: "search-panel" });
  else setShared("vsections.open", { id: "search", at: Date.now() }); // vsections' bar opens it
  // The panel's mod starts when first shown: ask for focus once it has.
  cx.spawn(async (cx) => { await cx.sleep(150); setShared("term-search.focus", Date.now()); });
}

// The right-hand tools panel, like the Claude desktop app's side panel (asked 2026-11-01): the
// vscode layout's `tools` column stacks Side chat (mods/side-chat), Browser (mods/browser) and a
// Terminal, each under a tool-header. What's open is per tab, in shared "tools.open":
// { [tabId]: { sideChat, browser, terminal: address | "starting" | null } }, and the column shows
// the SHOWN tab's tools. It sits outside the `work` stack, so it shows in both the Chat and the
// Terminal view (tool panes split into the tab hid behind the Chat view). tabs-vs is its only
// controller (syncTools, on a timer); other mods only ask, through shared "tools.close",
// "tools.move" and "tools.canvas".
// The terminal is a core terminal with no herdr labels, so it stays out of the tab's panes; it
// runs on the space's own machine (an ssh space gets one there), in the Claude pane's folder.
// Canvases (asked 2026-11-03): the "Canvases" tool shows one thing at a time (asked again the same
// day, three stacked sections confused): the list of claude.ai pages the space's sessions published
// (mods/canvases), or one open canvas in its place, a browser block (mods/browser) with a browser
// of its own, session "<tab>.cv-<id>". "tools.canvas" opens one, switches between the open ones or
// back to the list, and closes one (quitting its browser); tool-header draws that. The tab's state
// also has `canvas: [{id, url, title}]` (open ones), `view` (the one shown, null: the list) and
// `main`: the tool moved to the main area (tool-header's ⤢ or a header drag: "tools.move"),
// which goes, header and all, into a `work-tool` column beside the hidden `work` stack. syncTools
// lays both columns out from this state with layout.set whenever their shape changes.
const TOOL_KEYS = ["sideChat", "browser", "terminal", "canvases"];
const TOOL_BODY = { sideChat: { mod: "side-chat" }, browser: { mod: "browser" }, canvases: { mod: "canvases" } };
const TERMINAL_PLACEHOLDER = { mod: "tool-header", props: { tool: "terminal", empty: true } };
const toolsOpen = () => shared("tools.open") ?? {};
const liveTerminal = (a) => (a && a !== "starting" ? a : null);
const stopCanvas = (tabId, id) => exec("node", [`${appHome()}/mods/browser/chrome.mjs`, "stop", `${tabId}.cv-${id}`]).catch(() => {});

function setTool(tabId, key, value) {
  const all = { ...toolsOpen() };
  all[tabId] = { ...(all[tabId] ?? {}), [key]: value };
  setShared("tools.open", all);
}

function closeTool(tabId, key) {
  if (toolsOpen()[tabId]?.main === key) setTool(tabId, "main", null);
  if (key !== "terminal") return setTool(tabId, key, false);
  const a = liveTerminal(toolsOpen()[tabId]?.terminal);
  if (a) hc(["kill", a]).catch(() => {});
  setTool(tabId, "terminal", null);
}

// A "tools.canvas" ask: { url, title } opens that canvas (only claude.ai pages: a canvas browser has
// the claude.ai login, see browser/shell/main.cjs), { view: id | null } shows an open one or the
// list, { close: id } closes one.
function askCanvas(tabId, { url, title, view, close }) {
  const list = toolsOpen()[tabId]?.canvas ?? [];
  if (close) {
    stopCanvas(tabId, close);
    setTool(tabId, "canvas", list.filter((c) => c.id !== close));
    if (toolsOpen()[tabId]?.view === close) setTool(tabId, "view", null);
  } else if (url) {
    const id = String(url).split("/").pop();
    if (!/^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9-]+$/.test(url)) return;
    if (!list.some((c) => c.id === id)) setTool(tabId, "canvas", [...list, { id, url, title: String(title ?? id) }]);
    setTool(tabId, "view", id);
  } else if (view === null || list.some((c) => c.id === view)) setTool(tabId, "view", view);
}

// To the main area, or back to the panel when it's there.
function moveTool(tabId, key) {
  const st = toolsOpen()[tabId] ?? {};
  if (st[key]) setTool(tabId, "main", st.main === key ? null : key);
}

// The tools column and the main area's `work-tool` column as the shown tab's tools want them: a
// head and a body block per tool (existing blocks keep their fields), the one in the main area
// (`main`) in `work-tool`, right after the `work` stack. Null when the layout already is that.
function arrangeTools(root, tabId, st, terminal, keys, main) {
  const next = JSON.parse(JSON.stringify(root));
  const node = (id, def) => find(next, id) ?? { id, type: "block", hidden: true, ...def };
  const shown = (st.canvas ?? []).find((c) => c.id === st.view);
  const pairs = Object.fromEntries(keys.map((k) => {
    const head = { ...node(`tool-${k}-head`, { size: { px: 28 } }), content: { mod: "tool-header", props: { tool: k } } };
    const body = { ...node(`tool-${k}`, { content: TOOL_BODY[k] }) };
    if (k === "terminal") body.content = terminal;
    // Marker 1: the Browser tool's block (marker 0) can be on screen at the same time.
    if (k === "canvases") body.content = shown ? { mod: "browser", props: { tab: tabId, session: `${tabId}.cv-${shown.id}`, url: shown.url, marker: 1 } } : TOOL_BODY.canvases;
    return [k, [head, body]];
  }));
  find(next, "tools").children = keys.filter((k) => k !== main).flatMap((k) => pairs[k]);
  const holder = parentOf(next, "work");
  if (holder) {
    holder.children = holder.children.filter((c) => c.id !== "work-tool");
    if (main) holder.children.splice(holder.children.findIndex((c) => c.id === "work") + 1, 0, { ...(find(root, "work-tool") ?? { id: "work-tool", type: "column" }), children: pairs[main] });
  }
  // Compared by ids and contents only: other fields (hidden, sizes) are click state.
  const shape = (tree) => JSON.stringify([find(tree, "tools").children, find(tree, "work-tool")?.children ?? []].map((list) => list.map((c) => [c.id, c.content])));
  return shape(next) === shape(root) ? null : next;
}

async function startTerminal(space, tab) {
  const claude = panes().find(p => p.tab === tab.id && p.program?.agent && p.terminal) ?? panes().find(p => p.tab === tab.id && p.terminal);
  const args = ["run", "--bg", "--json", "--keep", "--no-parent", "--label", `herdr-tool=${tab.id}`];
  if (claude?.cwd) args.push("--cwd", claude.cwd);
  if (space.machine) args.push("--on", space.machine);
  const r = await hc(args);
  let address = null;
  try { address = JSON.parse(r.stdout.trim().split("\n").pop()).address; } catch {}
  if (!address) throw new Error(r.stderr.trim() || "could not start a terminal");
  // A terminal on another machine is addressed "machine/t7" from here.
  return space.machine && !address.includes("/") ? `${space.machine}/${address}` : address;
}

function toggleTool(space, key, cx) {
  const tab = space?.tabs.find(c => c.active);
  if (!tab) return;
  const now = toolsOpen()[tab.id] ?? {};
  if (now[key]) return closeTool(tab.id, key);
  if (key !== "terminal") return setTool(tab.id, key, true);
  setTool(tab.id, "terminal", "starting");
  cx.spawn(async () => {
    try {
      const address = await startTerminal(space, tab);
      // Closed (or clicked again) while it started: it isn't wanted any more.
      if (toolsOpen()[tab.id]?.terminal !== "starting") hc(["kill", address]).catch(() => {});
      else setTool(tab.id, "terminal", address);
    } catch (e) {
      if (toolsOpen()[tab.id]?.terminal === "starting") setTool(tab.id, "terminal", null);
      notify({ title: "Terminal", body: String(e?.message ?? e), level: "error" });
    }
  });
}

// A tab unrolls open like a scroll instead of popping in: it starts 0 wide and slides out to
// the width it measures (`widths`, by key). Only its first appearance animates.
function unroll(widths, key, el) {
  const w = widths[key] ?? 0;
  return h_flex().flex_none().h_full().items_center().overflow_hidden().w(w).opacity(w ? 1 : 0)
    .transition("width", { duration: 260, easing: "ease-out" }).transition("opacity", 200)
    .child(el.on_size_change((size, cx) => {
      if (Math.abs((widths[key] ?? 0) - size.width) < 0.5) return;
      widths[key] = size.width;
      cx.notify();
    }));
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.widths = {};
    // A terminal still "starting" when the app (or this mod) stopped will never finish starting.
    if (Object.values(toolsOpen()).some((v) => v?.terminal === "starting")) setShared("tools.open", Object.fromEntries(Object.entries(toolsOpen()).map(([k, v]) => [k, v?.terminal === "starting" ? { ...v, terminal: null } : v])));
    // A ✕ pressed before this copy started was handled by the one before it.
    this.closedAt = shared("tools.close")?.at ?? null;
    this.movedAt = shared("tools.move")?.at ?? null;
    this.canvasAt = shared("tools.canvas")?.at ?? null;
    this.readded = new Set(); this.seenTerms = new Set();
    // The tools panel follows on a timer, not from render (it runs commands and kills terminals).
    cx.timer.every(250, () => this.syncTools(spaces().find(p => p.active), layout()));
    // Keys (keys.json "tabs-vs.tool-browser" etc.) toggle the shown tab's tools too.
    const TOGGLES = { "tool-side-chat": "sideChat", "tool-browser": "browser", "tool-terminal": "terminal" };
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        // A reloaded build's loop would still get commands; touching cx ends it here instead.
        cx.phase();
        if (c === "search") openSearch(cx);
        else if (TOGGLES[c]) toggleTool(spaces().find(p => p.active), TOGGLES[c], cx);
      }
    });
  }

  // Lays the `tools` column (and `work-tool`) out for the shown tab: shows the open tools' blocks,
  // hides the rest, and points the terminal block at that tab's terminal. Only acts on a
  // difference (the timer re-reads everything each tick, so fast switching settles on the tab
  // shown now).
  syncTools(space, root) {
    const tab = space?.tabs.find(c => c.active);
    if (!find(root, "tools") || !tab) return;
    const ask = shared("tools.close"), move = shared("tools.move"), want = shared("tools.canvas");
    if (ask?.at && ask.at !== this.closedAt) {
      this.closedAt = ask.at;
      if (ask.tab && TOOL_KEYS.includes(ask.tool)) return closeTool(ask.tab, ask.tool);
    }
    if (move?.at && move.at !== this.movedAt) {
      this.movedAt = move.at;
      if (move.tab && move.tool) return moveTool(move.tab, move.tool);
    }
    if (want?.at && want.at !== this.canvasAt) {
      this.canvasAt = want.at;
      if (want.tab) return askCanvas(want.tab, want);
    }
    // Tabs that are gone: end their terminals and forget them. Only while the tab's machine's
    // layout is loaded (this machine's too, e.g. right after a core restart): unloaded, its tabs
    // are missing, not gone.
    const live = new Set(spaces().flatMap(s => s.tabs.map(x => x.id)));
    const machineOf = (id) => (id.includes("/") ? id.split("/")[0] : null);
    const known = (id) => machines().find(m => m.name === machineOf(id))?.layout === "ready";
    const gone = Object.keys(toolsOpen()).filter(id => !live.has(id) && known(id));
    if (gone.length) {
      const all = { ...toolsOpen() };
      for (const id of gone) {
        const a = liveTerminal(all[id]?.terminal);
        if (a) hc(["kill", a]).catch(() => {});
        for (const c of all[id]?.canvas ?? []) stopCanvas(id, c.id);
        delete all[id];
      }
      return setShared("tools.open", all); // re-renders
    }
    const st = toolsOpen()[tab.id] ?? {}, term = liveTerminal(st.terminal);
    // Its program ended (exit): close it. Only this machine's terminals are listed here, and a
    // new one shows up a moment after it starts, so only one seen before can have ended.
    if (term && !term.includes("/")) {
      if (terminals().some(x => x.address === term)) this.seenTerms.add(term);
      else if (this.seenTerms.has(term)) return setTool(tab.id, "terminal", null);
    }
    const keys = TOOL_KEYS;
    const open = Object.fromEntries(keys.map((k) => [k, Boolean(st[k])]));
    const work = Boolean(find(root, "work")), main = work && open[st.main] ? st.main : null;
    const content = term ? { terminal: term } : TERMINAL_PLACEHOLDER;
    // The terminal block points at the shown tab's terminal. Herdr drops a terminal block whose
    // terminal ends (like a pane), so a missing one is put back under its header.
    if (!find(root, "tool-terminal") && term) {
      // Gone again after being put back for this terminal: it ended (remote ones aren't listed).
      if (this.readded.has(term)) return setTool(tab.id, "terminal", null);
      this.readded.add(term);
    }
    const next = arrangeTools(root, tab.id, st, content, keys, main);
    if (next) {
      // layout() is the file, without the clicks (sizes, shown, stack picks) kept in layouts/.state,
      // and layout.set counts as a deliberate edit that beats them: carry them over, or every
      // panel change snapped resized panes back (asked 2026-11-03).
      if (this.setting) return;
      this.setting = true;
      readTextFile(`${appHome()}/layouts/.state/${shared("layout")}.json`).catch(() => null).then((s) => {
        try {
          for (const [id, clicks] of Object.entries(JSON.parse(s ?? "null")?.nodes ?? {})) {
            const n = find(next, id);
            if (n) Object.assign(n, clicks);
          }
        } catch {}
        run("layout.set", { layout: next });
        this.toolsSig = null; // shown/hidden goes again on the new tree, next tick
        this.setting = false;
      });
      return;
    }
    // Shown/hidden is click state that layout() doesn't report, so it's sent whenever what should
    // show changes (the commands are idempotent), not compared.
    const sig = JSON.stringify([tab.id, open, main, content]);
    if (sig === this.toolsSig) return;
    this.toolsSig = sig;
    const show = (id, on) => run(on ? "layout.show" : "layout.hide", { id });
    for (const k of keys) { show(`tool-${k}-head`, open[k]); show(`tool-${k}`, open[k]); }
    show("tools", keys.some((k) => open[k] && k !== main));
    if (work) show("work", !main);
    if (main) show("work-tool", true);
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        // Middle click closes the tab, as in browsers (asked 2026-11-01).
        .on_mouse_down("middle", (_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])
          .loop("opacity", { from: 0.25, to: 1, period: 2400 }))) // breathes while it waits for the person
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    const hasTools = Boolean(find(root, "tools"));
    const mine = toolsOpen()[space?.tabs.find(c => c.active)?.id] ?? {};
    const toolButton = (id, key, glyph, label, tip) => h_flex().id(id).h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
      .bg(mine[key] ? t.selected : t.chrome).text_color(mine[key] ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", stop).tooltip(tip)
      .on_click((_e, cx) => toggleTool(space, key, cx)).child(glyph).child(label);
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = !find(root, "title") && w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      // No wheel handler: it switched sessions on every scroll event (a trackpad swipe raced through
      // tabs). The tab strip scrolls sideways on its own (2026-11-01).
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map((c, i) => unroll(this.widths, c.id, item(c, i)))))
      // New session: the Claude mascot with a + (shared with spaces-tree; full color, so image()).
      .child(button("tab-new", image("mods/spaces-tree/claude-plus.svg").w(21).h(14.35), () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      // Search, Files, Markdown and Explorer buttons removed 2026-11-01: the activity bar and the
      // title bar's search box have them (⌘⇧F still opens Search).
      // The tools panel's buttons (see syncTools): lit while the shown tab has that tool open; only
      // in layouts that have the panel.
      .when(hasTools, el => el
        .child(toolButton("vs-side-chat", "sideChat", "◌", "Side chat", "Side chat: ask Claude on the side (/btw)"))
        .child(toolButton("vs-chrome-browser", "browser", "◎", "Chrome", "This session's browser (Claude controls it)"))
        .child(toolButton("vs-side-terminal", "terminal", ">_", "Terminal", "Terminal on this space's machine, in the side panel"))
        .child(toolButton("vs-canvases", "canvases", "▦", "Canvases", "Canvases (claude.ai artifacts) this space's sessions published")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-vs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-vs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-vs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
