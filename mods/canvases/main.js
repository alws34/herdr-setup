// Canvases: the claude.ai pages (artifacts) Claude Code published in the shown space's sessions, as
// a tool in the vscode layout's right-hand tools panel (tabs-vs' "Canvases" button; asked
// 2026-11-03). The shown session's come first, then each other session of the space that has any.
// A click asks tabs-vs (shared "tools.canvas") to open that canvas as its own section of the panel.
// Finding them: a tab's Claude pane -> its process -> ~/.claude/sessions/<pid>.json and the
// terminal's title -> the transcript (find.sh, the chat mod's, re-run only when those change) ->
// scan.sh (the publishes, cached until the transcript changes). Only while the list is open for
// the shown tab, every 3 s.
// shortcut: this computer's sessions only; an ssh space's would need exec/readTextFile { on }.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, terminals, theme, shared, setShared, exec, appHome, home, readTextFile } from "herdr";

const here = () => `${appHome()}/mods/canvases`;
const isClaude = (p) => p.terminal && (p.program?.key === "claude" || p.app === "claude-code");
const tabName = (t) => (/^tb\d+$/.test(t.name) ? "Claude" : t.name);
const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return !(m >= 1) ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

export default class Canvases extends View {
  init(_p, cx) {
    this.found = {}; // tab id -> { key, file }: its transcript, and what it was found from
    this.lists = {}; // transcript -> its canvases, newest first
    this.titles = {}; // published html file -> its <title>, for canvases published without a title
    this.loaded = false;
    cx.timer.every(3000, (cx) => this.poll(cx));
    this.poll(cx);
  }

  poll(cx) {
    const space = spaces().find((s) => s.active), tab = space?.tabs.find((t) => t.active);
    if (!tab || !(shared("tools.open") ?? {})[tab.id]?.canvases || this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      let changed = !this.loaded;
      try {
        const files = [];
        for (const t of space.tabs) { const f = await this.transcript(t.id); if (f) files.push(f); }
        const out = files.length ? (await exec("sh", [`${here()}/scan.sh`, ...files])).stdout : "";
        for (const line of out.split("\n").filter(Boolean)) {
          const { file, canvases } = JSON.parse(line);
          for (const c of canvases) {
            if (c.title || !/\.html?$/i.test(c.file ?? "") || c.file in this.titles) continue;
            // perl, not readTextFile: mod reads stop at home, and Claude's scratchpads are in /private/tmp.
            const r = await exec("perl", ["-0ne", "print $1 if /<title>([^<]*)/i", c.file]).catch(() => null);
            this.titles[c.file] = r?.stdout.trim() || null;
          }
          if (JSON.stringify(this.lists[file]) !== JSON.stringify(canvases)) { this.lists[file] = canvases; changed = true; }
        }
      } catch (e) { console.log(`canvases: ${e?.message ?? e}`); }
      // Even after an error: show what was found rather than "Looking for canvases…" forever.
      this.loaded = true;
      if (changed) cx.notify();
      this.busy = false;
    });
  }

  // The transcript the tab's Claude is writing (as the chat mod finds it). A tab whose Claude has
  // ended keeps the last one found, so its canvases stay listed.
  async transcript(tabId) {
    const pane = panes().find((p) => p.tab === tabId && isClaude(p));
    const term = pane && terminals().find((x) => x.address === pane.terminal);
    const pid = term?.foreground?.pid;
    if (!pid) return this.found[tabId]?.file ?? null;
    const info = JSON.parse((await readTextFile(`${home()}/.claude/sessions/${pid}.json`)) ?? "null");
    const title = String(term?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    const key = `${pid}|${info?.sessionId}|${title}`;
    if (this.found[tabId]?.key !== key) {
      const cwd = info?.cwd ?? term?.foreground?.cwd ?? term?.cwd ?? "";
      const file = (await exec("sh", [`${here()}/find.sh`, cwd, title, info?.sessionId ?? ""])).stdout.trim() || null;
      this.found[tabId] = { key, file };
    }
    return this.found[tabId].file;
  }

  render() {
    const t = theme(), space = spaces().find((s) => s.active), tab = space?.tabs.find((x) => x.active);
    const open = new Set(((shared("tools.open") ?? {})[tab?.id]?.canvas ?? []).map((c) => c.url));
    const listOf = (id) => this.lists[this.found[id]?.file] ?? [];
    const mine = tab ? listOf(tab.id) : [];
    const others = (space?.tabs ?? []).filter((o) => o.id !== tab?.id && listOf(o.id).length);
    const label = (text) => div().px(12).pt(12).pb(4).text_size(10.5).font_semibold().text_color(t.dim).child(text.toUpperCase());
    const row = (c) => {
      const on = open.has(c.url);
      const title = c.title || this.titles[c.file] || c.file?.split("/").pop().replace(/\.[^.]+$/, "") || c.url.split("/").pop();
      return h_flex().id(`cv-${c.url}`).h(30).mx(6).px(8).gap(8).items_center().rounded(6).cursor_pointer().text_size(12.5)
        .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(c.url)
        .on_click(() => setShared("tools.canvas", { tab: tab.id, url: c.url, title, at: Date.now() }))
        .child(div().flex_none().text_color(on ? t.accent : t.dim).child("▦"))
        .child(div().flex_1().min_w(0).truncate().child(title))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.at)));
    };
    const body = v_flex().id("cv-list").size_full().pb(8).overflow_y_scrollbar().bg(t.background);
    if (!this.loaded) return body.child(div().p(16).text_size(12.5).text_color(t.dim).child("Looking for canvases…"));
    if (!mine.length && !others.length) {
      return body.items_center().justify_center().gap(6).px(24)
        .child(div().text_size(13).text_color(t.muted).child("No canvases yet"))
        .child(div().text_size(12).text_color(t.dim).child("When Claude publishes an artifact in this space, it shows up here."));
    }
    return body
      .child(label("This session"))
      .when(!mine.length, (el) => el.child(div().px(14).py(4).text_size(12).text_color(t.dim).child("None yet")))
      .children(mine.map(row))
      .when(others.length > 0, (el) => el.child(label(`Other sessions in ${space.name}`)))
      .children(others.flatMap((o) => [
        div().px(14).pt(6).pb(2).text_size(11.5).text_color(t.muted).truncate().child(tabName(o)),
        ...listOf(o.id).map(row),
      ]));
  }
}
