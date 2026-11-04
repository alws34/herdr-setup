// Search every terminal (all spaces, tabs, sub-agents, machines) while you type, after
// ~/Desktop/herdr-find-tab. Space, tab and folder names match from the first character;
// from 3 characters search.sh also searches content: a Claude Code terminal's whole
// transcript (your prompts, Claude's replies, tool output), other terminals' screen and last
// 2000 lines. Results group by terminal, names first, then by the best hit: your prompt,
// Claude's reply, tool or terminal output. Each group shows what the conversation started
// with. A click shows that space, tab and pane (Herdr can't scroll a terminal to a line, so a
// terminal hit says how far up it is); a terminal without a pane (a sub-agent) opens as a peek.
// Shared "term-search.focus", set by the search buttons, focuses the box.
import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { terminals, panes, spaces, run, exec, theme, shared, appHome } from "herdr";

const DEBOUNCE = 200, MAX_GROUPS = 60, SHOW = 6, MIN_CONTENT = 3;
const ROLE = { you: "you", claude: "claude", tool: "tool", term: "" };

// Where a terminal lives: its pane's tab and space, else its parent's (sub-agents).
function place(address, all, ps, ss) {
  const seen = new Set();
  let t = all.find((x) => x.address === address);
  while (t && !seen.has(t.address)) {
    seen.add(t.address);
    const pane = ps.find((p) => p.terminal === t.address);
    if (pane) {
      const space = ss.find((s) => s.tabs.some((tab) => tab.id === pane.tab));
      return { pane, space, tab: space?.tabs.find((tab) => tab.id === pane.tab), own: t.address === address };
    }
    t = all.find((x) => x.address === t.parent);
  }
  return null;
}

export default class Search extends View {
  init(_props, cx) {
    this.query = ""; this.groups = []; this.searched = ""; this.asked = shared("term-search.focus") ?? 0;
    this.input = InputState.new({ placeholder: "Search spaces, tabs and conversations" });
    // Debounced: only the last change within DEBOUNCE searches.
    this.input.on("change", (_e, cx) => {
      const query = (this.query = this.input.value());
      cx.notify();
      cx.spawn(async (cx) => { await cx.sleep(DEBOUNCE); if (this.query === query) this.search(cx, false); });
    });
    this.input.on("submit", (_e, cx) => this.search(cx, true));
  }

  search(cx, again) {
    const q = this.query.trim();
    if (!q) { this.groups = []; this.searched = ""; this.error = null; cx.notify(); return; }
    if (this.busy) return; // the search running now looks again when it's back
    if (q === this.searched && !again) return;
    const live = terminals().filter((t) => t.state === "live").map((t) => t.address);
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", [`${appHome()}/mods/term-search/search.sh`, q, ...live]);
        this.groups = this.build(q, r.stdout);
        this.searched = q; this.error = r.code > 1 ? r.stderr.trim() : null;
      } catch (e) { this.error = String(e.message ?? e); }
      finally {
        this.busy = false; cx.notify();
        if (this.query.trim() !== q) this.search(cx, false);
      }
    });
    cx.notify();
  }

  // One group per terminal that matched by name or content, best first.
  build(q, out) {
    const all = terminals(), ps = panes(), ss = spaces(), lq = q.toLowerCase(), by = {};
    const group = (address) => (by[address] ??= { address, where: place(address, all, ps, ss), first: "", hits: [], rank: 9 });
    for (const line of out.split("\n")) {
      const [address, role, rank, up, ...rest] = line.split("\t");
      if (!address || rest.length === 0) continue;
      const g = group(address), text = rest.join(" ");
      if (role === "first") { g.first = text; continue; }
      g.hits.push({ role, up: Number(up), text });
      g.rank = Math.min(g.rank, Number(rank));
    }
    for (const t of all.filter((x) => x.state === "live")) {
      const g = group(t.address), w = g.where;
      const names = [w?.space?.name, w?.tab?.name, t.cwd, t.name].filter(Boolean).join(" ").toLowerCase();
      if (names.includes(lq)) { g.named = true; g.rank = 0; }
    }
    return Object.values(by).filter((g) => g.named || g.hits.length).sort((a, b) => a.rank - b.rank || b.hits.length - a.hits.length).slice(0, MAX_GROUPS);
  }

  open(g) {
    const w = g.where;
    if (w?.own && w.space && w.tab) {
      run("space.select", { id: w.space.id });
      run("tab.select", { id: w.tab.id });
      run("pane.focus", { terminal: g.address });
    } else run("terminal.peek", { terminal: g.address });
  }

  // The text with the query lit, trimmed so the match shows in a narrow panel.
  line(text, q, t) {
    const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
    const trimmed = at > 24 ? "…" + text.slice(at - 18) : text, i = at > 24 ? 19 : at;
    if (i < 0) return div().flex_1().min_w(0).truncate().child(trimmed);
    return h_flex().flex_1().min_w(0).overflow_hidden()
      .child(div().flex_none().child(trimmed.slice(0, i)))
      .child(div().flex_none().rounded(3).bg(t.selected).text_color(t.foreground).child(trimmed.slice(i, i + q.length)))
      .child(div().flex_1().min_w(0).truncate().child(trimmed.slice(i + q.length)));
  }

  render() {
    const t = theme();
    const ask = shared("term-search.focus") ?? 0;
    if (ask !== this.asked) { this.asked = ask; this.input.focus(); }
    const q = this.searched, hits = this.groups.reduce((n, g) => n + g.hits.length, 0);
    const roleColor = { you: t.accent, claude: t.done, tool: t.dim };
    return v_flex().id("term-search").size_full().min_h(0).text_size(12.5).text_color(t.foreground)
      .child(div().flex_none().px(10).pt(8).pb(6)
        .child(div().id("search-box").w_full().h(28).px(9).flex().items_center().rounded(7).bg(t.surface).border_1().border_color(t.border)
          .cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground))))
      .child(div().flex_none().px(12).pb(4).text_size(10.5).text_color(this.error ? t.ansi1 : t.dim)
        .child(this.error ? this.error : this.busy ? "Searching…"
          : q ? `${this.groups.length} terminals · ${hits} hits${q.length < MIN_CONTENT ? " · type 3+ characters to search conversations" : ""}`
          : "Names from 1 character, conversations from 3"))
      .child(v_flex().id("search-results").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(6).children(this.groups.map((g) => {
        const w = g.where, name = w?.space ? `${w.space.name} › ${w.tab?.name ?? ""}` : g.address;
        return v_flex().flex_none().pb(4)
          .child(h_flex().id(`g-${g.address}`).h(22).px(6).gap(6).items_center().text_size(11.5).rounded(5).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click(() => this.open(g))
            .child(div().font_semibold().truncate().child(name))
            .child(div().text_size(10.5).text_color(t.dim).child(`${g.address}${w && !w.own ? " · sub-agent" : ""}`))
            .child(div().flex_1())
            .when(g.hits.length > 0, (el) => el.child(div().px(5).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${g.hits.length}${g.hits.length >= 40 ? "+" : ""}`))))
          .when(Boolean(g.first), (el) => el.child(div().pl(18).pr(6).h(18).text_size(11).text_color(t.dim).truncate().child(`↳ ${g.first}`)))
          .children(g.hits.slice(0, SHOW).map((h, i) => h_flex().id(`r-${g.address}-${i}`).h(22).pl(18).pr(6).gap(6).items_center().rounded(5).cursor_pointer()
            .text_size(11.5).text_color(t.muted).hover((s) => s.bg(t.hover))
            .on_click(() => this.open(g))
            .when(Boolean(ROLE[h.role]), (el) => el.child(div().w(38).flex_none().text_size(10).text_color(roleColor[h.role] ?? t.dim).child(ROLE[h.role])))
            .child(this.line(h.text, q, t))
            .when(h.up >= 0, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(h.up === 0 ? "on screen" : `↑${h.up}`)))))
          .when(g.hits.length > SHOW, (el) => el.child(div().pl(18).h(18).text_size(10.5).text_color(t.dim).child(`… ${g.hits.length - SHOW} more`)));
      })));
  }
}
