// Customize: the Claude desktop app's Customize page (Skills | Connectors | Plugins, each with
// Yours | Discover), drawn natively for Herdr and opened as a whole tab from vs-chrome's activity
// bar. The extensions mod is the same data as a side bar list; this is the roomy, browsable view.
//
// Every item is real (see data.js): Yours is what Claude Code has installed; Discover is the
// marketplaces Claude Code knows, read from its CLI and its own catalog caches. Install counts
// show only where the marketplace publishes them (claude-plugins-official does, the Anthropic
// Directory doesn't). Connectors have no Discover catalog in Claude Code: claude.ai's connector
// directory lives on claude.ai only, so Discover lists the connectors plugins bring and says so.
//
// Loads run in tasks after the first frame (the CLI takes 1–10 s); derived lists are built once
// per load in rebuild(), never in render(), because Herdr re-renders on every agent status change.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, props } from "herdr";
import {
  DIRECTORY, OFFICIAL, loadPlugins, loadCatalogs, marketplaceFolders, scanSkills, readOverrides, cycleSkill,
  change, newSkill, cachedMcp, loadMcp, inTab, openInEditor, compact,
} from "./data.js";

const TABS = [["skills", "Skills"], ["connectors", "Connectors"], ["plugins", "Plugins"]];
const PREVIEW = 6;     // cards per Discover section before "Show all"
const PAGE = 40;       // cards per "Show all" page
const ICON = (n) => `mods/customize/icons/${n}.svg`;
const KIND_ICON = { skill: "skill", plugin: "box", connector: "plug" };
const SORTS = [["popular", "Most installed"], ["name", "Name"], ["recent", "Recently updated"]];
const SKILL_STATE = { "name-only": "Name only", off: "Off", "user-invocable-only": "/ only" };

const pluginName = (id) => id.split("@")[0];
const byDesc = (a, b) => (b ?? -1) - (a ?? -1);

export default class Customize extends View {
  // props (optional): {tab: "skills" | "connectors" | "plugins", mode: "yours" | "discover"}.
  init(_props, cx) {
    const p = props() ?? {};
    this.tab = TABS.some(([id]) => id === p.tab) ? p.tab : "skills";
    this.mode = p.mode === "yours" ? "yours" : "discover";
    this.query = ""; this.filter = "all"; this.sort = "popular";
    this.showAll = null; this.limit = PAGE; this.adding = false; this.banner = 0;
    this.busy = {}; this.confirm = null; this.width = 1000;
    this.input = InputState.new({ placeholder: "Search" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value().trim().toLowerCase(); this.limit = PAGE; cx.notify(); });
    // The "+ Add" panel's fields, one set per tab (an input's placeholder is fixed at creation).
    this.add = {
      plugins: [InputState.new({ placeholder: "GitHub owner/repo, a git URL, or a folder" })],
      skills: [InputState.new({ placeholder: "skill-name" })],
      connectors: [InputState.new({ placeholder: "name" }), InputState.new({ placeholder: "https://…/mcp  or  a command and its arguments" })],
    };
    for (const list of Object.values(this.add)) for (const f of list) f.on("submit", (_e, cx) => this.submitAdd(cx));
    // Loaded data; null = still loading.
    this.installed = null; this.available = []; this.catalogs = { official: {}, directory: {} };
    this.mySkills = null; this.marketSkills = []; this.overrides = {}; this.mcp = null; this.mcpLoading = false;
    this.errors = {};
    this.rebuild();
    this.load(cx);
  }

  // --- loading ---------------------------------------------------------------------------

  load(cx) {
    this.task(cx, "catalogs", async () => { this.catalogs = await loadCatalogs(); });
    this.task(cx, "overrides", async () => { this.overrides = await readOverrides(); });
    this.task(cx, "market skills", async () => { this.marketSkills = (await scanSkills(await marketplaceFolders())).filter((s) => s.source !== "user"); });
    this.loadPluginsAndSkills(cx);
    this.task(cx, "mcp cache", async () => { this.mcp = this.mcp ?? await cachedMcp(); });
    this.refreshMcp(cx);
  }

  // Runs one load in the background, then rebuilds the lists and redraws.
  task(cx, name, fn) {
    cx.spawn(async (cx) => {
      try { await fn(); delete this.errors[name]; } catch (e) { this.errors[name] = `${name}: ${e.message ?? e}`; }
      this.rebuild(); cx.notify();
    });
  }

  loadPluginsAndSkills(cx) {
    this.task(cx, "plugins", async () => {
      const d = await loadPlugins();
      this.installed = d.installed; this.available = d.available;
      this.mySkills = await scanSkills(this.installed.filter((p) => p.installPath).flatMap((p) => [p.id, p.installPath]));
    });
  }

  refreshMcp(cx) {
    if (this.mcpLoading) return;
    this.mcpLoading = true; cx.notify();
    this.task(cx, "mcp", async () => { try { this.mcp = await loadMcp(); } finally { this.mcpLoading = false; } });
  }

  // --- the lists -------------------------------------------------------------------------

  // Builds every section from the loaded data. Items: {key, kind, name, desc, meta, badge,
  // state (Discover: installed; Yours: on), target (plugin id to install), installs, updated, path}.
  rebuild() {
    const { official, directory } = this.catalogs;
    const ids = new Set((this.installed ?? []).map((p) => p.id));
    // The CLI's `available` leaves installed plugins out; put them back (with ✓) from the catalogs.
    const extra = (this.installed ?? []).filter((p) => !this.available.some((a) => a.pluginId === p.id)).map((p) => ({
      pluginId: p.id, name: pluginName(p.id), marketplaceName: p.id.split("@")[1],
      description: official[p.id]?.desc ?? directory[p.id]?.summary ?? p.desc ?? "", installCount: official[p.id]?.installs ?? null }));
    const catalog = [...this.available, ...extra];
    const avail = new Map(catalog.map((a) => [a.pluginId, a]));
    const local = new Map(this.marketSkills.map((s) => [`${s.source}:${s.name}`, s]));
    const meta = (...parts) => parts.filter(Boolean).join("  ·  ");
    const installs = (n) => (n != null ? `${compact(n)} installs` : null);

    // Plugins.
    const plugin = (a) => {
      const off = official[a.pluginId], dir = directory[a.pluginId], market = a.marketplaceName;
      const by = off?.author ?? dir?.by;
      return { key: `p:${a.pluginId}`, kind: "plugin", name: dir?.title ?? a.name, desc: a.description ?? dir?.summary ?? "",
        meta: meta(market === DIRECTORY ? "Anthropic Directory" : market === OFFICIAL ? null : market, by && `by ${by}`, installs(a.installCount ?? off?.installs)),
        badge: dir?.review === "anthropic" ? "Anthropic reviewed" : null,
        state: ids.has(a.pluginId), target: a.pluginId, installs: a.installCount ?? off?.installs ?? null, updated: off?.updated ?? null, order: dir?.order };
    };
    const plugins = catalog.map(plugin);
    const ofMarket = (m) => plugins.filter((p) => avail.get(p.target).marketplaceName === m);
    const directoryList = ofMarket(DIRECTORY).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
    // The banner: plugins Anthropic publishes itself (repository under github.com/anthropics).
    this.featured = directoryList.filter((p) => directory[p.target]?.fromAnthropic).sort((a, b) => Number(a.state) - Number(b.state));
    const pluginSections = [
      { key: "p-popular", title: "Most installed plugins", items: plugins.filter((p) => p.installs != null).sort((a, b) => byDesc(a.installs, b.installs)) },
      { key: "p-recent", title: "Recently updated plugins", items: plugins.filter((p) => p.updated).sort((a, b) => b.updated.localeCompare(a.updated)) },
      { key: "p-directory", title: "Anthropic Directory", items: directoryList },
      { key: "p-other", title: "From your other marketplaces", items: plugins.filter((p) => ![OFFICIAL, DIRECTORY].includes(avail.get(p.target).marketplaceName)) },
    ];

    // Skills: the official catalog lists each plugin's skills by name; a marketplace's local
    // copy of a plugin has the SKILL.md with its description. Installing one installs its plugin.
    const skills = [];
    for (const [id, off] of Object.entries(official)) {
      const a = avail.get(id), pname = a?.name ?? pluginName(id);
      for (const s of off.skills) {
        const l = local.get(`${id}:${s}`);
        skills.push({ key: `s:${id}:${s}`, kind: "skill", name: s, desc: l?.desc || `Comes with the ${pname} plugin${a?.description ? `: ${a.description}` : "."}`,
          meta: meta(`in ${pname}`, installs(off.installs)), state: ids.has(id), target: id, installs: off.installs, updated: off.updated, path: l?.path, plugin: id });
      }
    }
    const firstPerPlugin = (list) => { const seen = new Set(); return list.filter((s) => !seen.has(s.plugin) && seen.add(s.plugin)); };
    const popularSkills = [...skills].sort((a, b) => byDesc(a.installs, b.installs));
    const recentSkills = skills.filter((s) => s.updated).sort((a, b) => b.updated.localeCompare(a.updated));
    const otherSkills = this.marketSkills.filter((s) => !official[s.source]).map((s) => ({
      key: `s:${s.source}:${s.name}`, kind: "skill", name: s.name, desc: s.desc, meta: meta(`in ${pluginName(s.source)}`, s.source.split("@")[1]),
      state: ids.has(s.source), target: avail.has(s.source) ? s.source : null, path: s.path, plugin: s.source }));
    const skillSections = [
      { key: "s-popular", title: "Most installed skills", items: popularSkills, preview: firstPerPlugin(popularSkills) },
      { key: "s-recent", title: "Recently updated skills", items: recentSkills, preview: firstPerPlugin(recentSkills) },
      { key: "s-other", title: "From your other marketplaces", items: otherSkills },
    ];

    // Connectors that plugins bring (the only connector catalog Claude Code has).
    const connectorItems = plugins.filter((p) => official[p.target]?.mcp?.length).map((p) => ({
      ...p, key: `c:${p.target}`, kind: "connector",
      meta: meta(`MCP: ${official[p.target].mcp.join(", ")}`, official[p.target].author && `by ${official[p.target].author}`, installs(p.installs)) }))
      .sort((a, b) => byDesc(a.installs, b.installs));
    const connectorSections = [{ key: "c-plugins", title: "Connectors that come with plugins", items: connectorItems }];

    this.discover = { plugins: pluginSections, skills: skillSections, connectors: connectorSections };
    this.yours = { plugins: this.yourPlugins(avail, directory), skills: this.yourSkills(), connectors: this.yourConnectors() };
    this.memo = null;
  }

  yourPlugins(avail, directory) {
    if (!this.installed) return null;
    const items = this.installed.map((p) => {
      const a = avail.get(p.id), dir = directory[p.id], [name, market] = p.id.split("@"), failed = p.errors?.length || p.error;
      return { key: `yp:${p.id}`, kind: "plugin", name: dir?.title ?? name, desc: a?.description || dir?.summary || p.desc || "",
        meta: [market === DIRECTORY ? "Anthropic Directory" : market, `v${String(p.version).slice(0, 12)}`].join("  ·  "),
        badge: failed ? "failed to load" : null, state: Boolean(p.enabled), plugin: p, installs: a?.installCount ?? null };
    });
    return [{ key: "yp", title: "Installed plugins", items }];
  }

  yourSkills() {
    if (!this.mySkills) return null;
    const groups = new Map();
    for (const s of this.mySkills) {
      const key = s.source === "user" ? s.name : `${pluginName(s.source)}:${s.name}`;
      const o = this.overrides[key];
      if (!groups.has(s.source)) groups.set(s.source, []);
      groups.get(s.source).push({ key: `ys:${s.path}`, kind: "skill", name: s.name, desc: s.desc,
        meta: s.source === "user" ? "~/.claude/skills" : `in ${pluginName(s.source)}`, state: o !== "off", override: key, overrideState: o, path: s.path });
    }
    return [...groups].map(([source, items]) => ({ key: `ys-${source}`, title: source === "user" ? "Your skills" : `From ${pluginName(source)}`, items }));
  }

  yourConnectors() {
    if (!this.mcp) return null;
    const item = (m) => ({ key: `ym:${m.name}`, kind: "connector", name: m.label, desc: m.target || "No URL configured",
      meta: m.kind === "plugin" ? `from ${m.plugin}` : m.kind === "claude.ai" ? "claude.ai connector" : "added with claude mcp add",
      status: m.status, ok: m.ok, auth: m.auth, state: m.ok, mcp: m });
    return [
      ["claude.ai", "claude.ai connectors"], ["local", "Your servers"], ["plugin", "From plugins"],
    ].map(([kind, title]) => ({ key: `ym-${kind}`, title, items: this.mcp.filter((m) => m.kind === kind).map(item) })).filter((s) => s.items.length);
  }

  // The current tab's sections, or null while loading.
  sections() { return (this.mode === "yours" ? this.yours : this.discover)[this.tab]; }

  // Filter and sort, cached per view (render runs on every Herdr data change).
  shape(items) {
    const key = [this.tab, this.mode, this.showAll, this.query, this.filter, this.sort, items.length].join("|");
    if (this.memo?.key === key && this.memo.src === items) return this.memo.list;
    let list = items;
    if (this.query) list = list.filter((i) => `${i.name} ${i.desc} ${i.meta}`.toLowerCase().includes(this.query));
    if (this.filter !== "all") list = list.filter((i) => i.state === (this.filter === "yes"));
    if (this.sort === "name") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    else if (this.sort === "recent") list = [...list].sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
    else if (this.query || this.showAll) list = [...list].sort((a, b) => byDesc(a.installs, b.installs));
    this.memo = { key, src: items, list };
    return list;
  }

  // --- actions ---------------------------------------------------------------------------

  // Runs a CLI change with `key` busy, then reloads what it touched.
  act(key, args, cx, after = "plugins") {
    this.busy[key] = true; this.confirm = null; cx.notify();
    cx.spawn(async (cx) => {
      await change(args);
      delete this.busy[key];
      if (after === "plugins") this.loadPluginsAndSkills(cx); else this.refreshMcp(cx);
      cx.notify();
    });
  }

  install(item, cx) {
    if (item.state || !item.target || this.busy[item.target]) return;
    this.act(item.target, ["plugin", "install", item.target], cx);
  }

  toggleSkill(item, cx) {
    cx.spawn(async (cx) => {
      try { this.overrides = await cycleSkill(item.override); } catch (e) { this.errors.settings = `settings.json: ${e.message ?? e}`; }
      this.rebuild(); cx.notify();
    });
  }

  submitAdd(cx) {
    const fields = this.add[this.tab], [a, b] = fields.map((f) => f.value().trim());
    if (!a) return;
    const done = () => { for (const f of fields) f.set_value(""); this.adding = false; };
    if (this.tab === "plugins") { this.act("add", ["plugin", "marketplace", "add", a], cx); done(); }
    else if (this.tab === "connectors") {
      if (!b) return;
      const args = /^https?:\/\//.test(b) ? ["mcp", "add", "--scope", "user", "--transport", "http", a, b] : ["mcp", "add", "--scope", "user", a, "--", ...b.split(/\s+/)];
      this.act("add", args, cx, "mcp"); done();
    } else {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(a)) { this.errors.add = "Skill names are lowercase letters, digits and dashes."; cx.notify(); return; }
      cx.spawn(async (cx) => {
        try { await newSkill(a); delete this.errors.add; done(); this.loadPluginsAndSkills(cx); }
        catch (e) { this.errors.add = `New skill: ${e.message ?? e}`; }
        cx.notify();
      });
    }
  }

  go(patch, cx) { Object.assign(this, { showAll: null, limit: PAGE, confirm: null, adding: false, filter: "all" }, patch); cx.notify(); }

  // --- drawing: controls -----------------------------------------------------------------

  stop(el) { return el.on_mouse_down("left", (_e, cx) => cx.stop_propagation()); }

  button(id, label, t, onClick, opts = {}) {
    return this.stop(h_flex().id(id).flex_none().h(opts.h ?? 26).px(10).gap(5).items_center().rounded(7).cursor_pointer()
      .text_size(opts.size ?? 12.5).font_weight(500)
      .bg(opts.primary ? t.solid : t.raised).text_color(opts.danger ? t.ansi1 : opts.primary ? t.solid_foreground : t.foreground)
      .when(!opts.primary, (el) => el.border_1().border_color(t.border))
      .hover((s) => s.opacity(0.85))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
      .when(Boolean(opts.icon), (el) => el.child(svg(ICON(opts.icon ?? "plus")).size(13)))
      .child(label);
  }

  iconButton(id, icon, tip, t, onClick, active) {
    return this.stop(div().id(id).size(30).flex_none().flex().items_center().justify_center().rounded(7).cursor_pointer()
      .text_color(active ? t.foreground : t.muted).when(active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => onClick(cx))).child(svg(ICON(icon)).size(16));
  }

  // A two-click button for destructive actions.
  danger(id, label, t, onClick) {
    const armed = this.confirm === id;
    return this.button(id, armed ? "Sure?" : label, t, (cx) => { if (armed) onClick(cx); else { this.confirm = id; cx.notify(); } }, { danger: true, h: 24, size: 12 });
  }

  toolbar(t) {
    const seg = (id, label, on, onClick) => this.stop(div().id(id).h(30).px(10).flex().items_center().rounded(7).cursor_pointer().text_size(13.5)
      .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.raised).border_1().border_color(t.input))
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => onClick(cx))).child(label);
    const filterLabel = this.mode === "yours" ? { all: "All", yes: "On / connected", no: "Off / needs attention" } : { all: "All", yes: "Installed", no: "Not installed" };
    return h_flex().flex_wrap().gap(6).items_center()
      .child(h_flex().gap(2).children(TABS.map(([id, label]) => seg(`tab-${id}`, label, this.tab === id, (cx) => this.go({ tab: id }, cx)))))
      .child(div().w(1).h(20).mx(6).bg(t.border))
      .child(h_flex().p(2).gap(2).rounded(9).bg(t.surface).border_1().border_color(t.border)
        .child(seg("mode-yours", "Yours", this.mode === "yours", (cx) => this.go({ mode: "yours" }, cx)))
        .child(seg("mode-discover", "Discover", this.mode === "discover", (cx) => this.go({ mode: "discover" }, cx))))
      .child(div().flex_1())
      .child(this.stop(h_flex().flex_1().min_w(120).max_w(260).h(32).px(10).gap(7).items_center().rounded(8).bg(t.surface).border_1().border_color(t.border).text_color(t.muted))
        .child(svg(ICON("search")).size(14).flex_none())
        .child(div().flex_1().min_w(0).child(Input.new(this.input).text_size(13))))
      .child(this.iconButton("filter", "filter", `Show: ${filterLabel[this.filter]} (click to change)`, t, (cx) => {
        this.filter = { all: "yes", yes: "no", no: "all" }[this.filter]; this.limit = PAGE; cx.notify(); }, this.filter !== "all"))
      .child(this.iconButton("sort", "sort", `Sort: ${SORTS.find(([k]) => k === this.sort)[1]} (click to change)`, t, (cx) => {
        this.sort = SORTS[(SORTS.findIndex(([k]) => k === this.sort) + 1) % SORTS.length][0]; cx.notify(); }, this.sort !== "popular"))
      .child(this.button("add", "Add", t, (cx) => { this.adding = !this.adding; cx.notify(); }, { primary: true, icon: "plus", h: 30 }));
  }

  // The "+ Add" panel: what can be added on this tab, with Claude Code's own commands.
  addPanel(t) {
    const field = (state, w) => this.stop(h_flex().h(32).px(10).items_center().rounded(8).bg(t.background).border_1().border_color(t.input)
      .when(Boolean(w), (el) => el.w(w ?? 0)).when(!w, (el) => el.flex_1())).child(div().flex_1().child(Input.new(state).text_size(13)));
    const spec = {
      plugins: ["Add a marketplace", "claude plugin marketplace add", "Add marketplace"],
      connectors: ["Add an MCP server for all projects", "claude mcp add --scope user", "Add server"],
      skills: ["Write a new skill", "creates ~/.claude/skills/<name>/SKILL.md and opens it in the editor", "Create"],
    }[this.tab];
    const [first, second] = this.add[this.tab];
    return v_flex().gap(10).p(16).rounded(12).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(14).font_weight(600).child(spec[0]))
        .child(div().text_size(12).text_color(t.dim).child(spec[1])))
      .child(h_flex().gap(8).items_center()
        .child(field(first, second ? 180 : null))
        .when(Boolean(second), (el) => el.child(field(second ?? first, null)))
        .child(this.button("add-go", this.busy.add ? "Working…" : spec[2], t, (cx) => this.submitAdd(cx), { primary: true, h: 32 })))
      .when(this.tab === "connectors", (el) => el.child(div().text_size(12).text_color(t.dim)
        .child("claude.ai connectors are added at claude.ai › Settings › Connectors; they show up here on their own.")))
      .when(Boolean(this.errors.add), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(this.errors.add ?? "")));
  }

  // --- drawing: cards --------------------------------------------------------------------

  tile(item, t) {
    const glyph = item.kind === "connector" && this.mode === "yours"
      ? div().text_size(17).font_weight(600).text_color(t.foreground).child((item.name.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase())
      : svg(ICON(KIND_ICON[item.kind])).size(20).text_color(t.foreground);
    return div().size(42).flex_none().flex().items_center().justify_center().rounded(9).bg(t.background).border_1().border_color(t.border).child(glyph);
  }

  // Discover's corner button: + installs, ✓ is installed, a spinner while installing.
  installButton(item, t) {
    const busy = this.busy[item.target];
    const box = div().id(`i-${item.key}`).size(28).flex_none().flex().items_center().justify_center().rounded(7);
    if (busy) return box.bg(t.raised).child(svg(ICON("spinner")).size(14).text_color(t.muted).spin(900));
    if (item.state) return box.bg(t.raised).tooltip("Installed: manage it under Yours").child(svg(ICON("check")).size(15).text_color(t.ansi2));
    if (!item.target) return box;
    const what = item.kind === "plugin" ? "Install" : `Install the ${pluginName(item.target)} plugin`;
    return this.stop(box.bg(t.raised).border_1().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`${what} (claude plugin install ${item.target})`)
      .on_click((_e, cx) => { cx.stop_propagation(); this.install(item, cx); })).child(svg(ICON("plus")).size(15).text_color(t.foreground));
  }

  // Yours' controls, per kind.
  yourControls(item, t) {
    if (item.kind === "plugin") {
      const p = item.plugin, busy = this.busy[p.id];
      if (busy) return [div().text_size(12).text_color(t.dim).child("working…")];
      return [
        this.switch_(`pt-${p.id}`, item.state, t, (cx) => this.act(p.id, ["plugin", item.state ? "disable" : "enable", p.id], cx)),
      ];
    }
    if (item.kind === "skill") {
      const o = item.overrideState;
      return [this.button(`so-${item.key}`, SKILL_STATE[o] ?? "On", t, (cx) => this.toggleSkill(item, cx), { h: 24, size: 12 })];
    }
    const m = item.mcp, out = [];
    if (m.auth) out.push(this.button(`ml-${m.name}`, "Connect", t, () => inTab(["claude", "mcp", "login", m.name], `Connect ${m.label}`), { primary: true, h: 24, size: 12 }));
    if (m.kind === "local") out.push(this.busy[m.name] ? div().text_size(12).text_color(t.dim).child("removing…")
      : this.danger(`mx-${m.name}`, "Remove", t, (cx) => this.act(m.name, ["mcp", "remove", m.name, "--scope", "user"], cx, "mcp")));
    return out;
  }

  switch_(id, on, t, onClick) {
    return this.stop(div().id(id).w(34).h(20).flex_none().rounded_full().p(2).flex().items_center().cursor_pointer()
      .bg(on ? t.accent : t.raised).border_1().border_color(on ? t.accent : t.input).tooltip(on ? "Enabled: click to disable" : "Disabled: click to enable")
      .when(on, (el) => el.justify_end())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
      .child(div().size(14).rounded_full().bg(on ? t.accent_foreground : t.muted));
  }

  // The line under a Yours card: a plugin's Update / Remove, a connector's status.
  yourFooter(item, t) {
    if (item.kind === "plugin" && !this.busy[item.plugin.id]) {
      const p = item.plugin;
      return h_flex().gap(6).mt(8)
        .child(this.button(`pu-${p.id}`, "Update", t, (cx) => this.act(p.id, ["plugin", "update", p.id], cx), { h: 24, size: 12 }))
        .child(this.danger(`px-${p.id}`, "Remove", t, (cx) => this.act(p.id, ["plugin", "uninstall", "--keep-data", p.id], cx))); // keep its saved data for a reinstall
    }
    if (item.kind === "connector") {
      const color = item.ok ? t.ansi2 : item.auth ? t.blocked : /not configured/i.test(item.status) ? t.dim : t.ansi1;
      return h_flex().gap(6).mt(6).items_center().min_w(0)
        .child(div().size(7).flex_none().rounded_full().bg(color))
        .child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(item.status));
    }
    return null;
  }

  card(item, t) {
    const yours = this.mode === "yours";
    const right = yours ? this.yourControls(item, t) : [this.installButton(item, t)];
    const footer = yours ? this.yourFooter(item, t) : null;
    const open = item.path ? () => openInEditor(item.path) : null;
    return h_flex().id(`card-${item.key}`).flex_1().min_w(0).p(14).gap(12).items_start().rounded(12)
      .bg(t.surface).border_1().border_color(t.border).hover((s) => s.bg(t.raised))
      .when(Boolean(item.desc), (el) => el.tooltip(item.desc))
      .when(Boolean(open), (el) => el.cursor_pointer().on_click(() => open?.()))
      .child(this.tile(item, t))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().min_w(0).truncate().text_size(14).font_weight(600).text_color(yours && !item.state && item.kind !== "connector" ? t.muted : t.foreground).child(item.name))
          .when(Boolean(item.badge), (el) => el.child(div().flex_none().px(5).h(17).flex().items_center().rounded(4).border_1().border_color(t.border)
            .text_size(10.5).text_color(item.badge === "failed to load" ? t.ansi1 : t.muted).child(item.badge ?? ""))))
        .child(div().mt(3).h(36).overflow_hidden().line_height("18px").text_size(12.5).text_color(t.muted).child(item.desc || " "))
        .when(Boolean(item.meta), (el) => el.child(div().mt(4).truncate().text_size(12).text_color(t.dim).child(item.meta)))
        .when(Boolean(footer), (el) => el.child(footer)))
      .child(h_flex().flex_none().gap(6).items_center().children(right));
  }

  grid(items, t) {
    const cols = this.width >= 760 ? 2 : 1, rows = [];
    for (let i = 0; i < items.length; i += cols) {
      const row = items.slice(i, i + cols).map((it) => this.card(it, t));
      while (row.length < cols) row.push(div().flex_1());
      rows.push(h_flex().gap(12).items_start().children(row));
    }
    return v_flex().gap(12).children(rows);
  }

  skeleton(t, label) {
    const ghost = () => h_flex().flex_1().h(104).p(14).gap(12).rounded(12).bg(t.surface).border_1().border_color(t.border)
      .child(div().size(42).rounded(9).bg(t.raised))
      .child(v_flex().flex_1().gap(8).child(div().w(140).h(12).rounded(4).bg(t.raised)).child(div().w_full().h(10).rounded(4).bg(t.raised)).child(div().w(200).h(10).rounded(4).bg(t.raised)));
    return v_flex().gap(12)
      .child(h_flex().gap(8).items_center().text_size(13).text_color(t.muted)
        .child(svg(ICON("spinner")).size(14).spin(900)).child(label))
      .child(v_flex().gap(12).loop("opacity", { from: 0.45, to: 1, period: 1400 })
        .child(h_flex().gap(12).child(ghost()).child(ghost()))
        .child(h_flex().gap(12).child(ghost()).child(ghost())));
  }

  sectionHead(title, count, t, action) {
    return h_flex().items_center().gap(8).mt(8)
      .child(div().text_size(15).font_weight(600).child(title))
      .when(count != null, (el) => el.child(div().px(6).h(18).flex().items_center().rounded(5).bg(t.raised).text_size(11.5).text_color(t.muted).child(String(count))))
      .child(div().flex_1())
      .when(Boolean(action), (el) => el.child(action));
  }

  showAllLink(key, t) {
    return this.stop(h_flex().id(`all-${key}`).gap(5).items_center().cursor_pointer().text_size(13).text_color(t.foreground).hover((s) => s.opacity(0.75))
      .on_click((_e, cx) => { this.showAll = key; this.limit = PAGE; cx.notify(); }))
      .child("Show all").child(svg(ICON("arrow-right")).size(14));
  }

  // --- drawing: pages --------------------------------------------------------------------

  // "From Anthropic": plugins Anthropic publishes, from the directory, one at a time.
  bannerCard(t) {
    const list = this.featured ?? [];
    if (!list.length || this.query) return null;
    const i = ((this.banner % list.length) + list.length) % list.length, p = list[i];
    const arrow = (id, icon, d) => this.stop(div().id(id).size(28).flex().items_center().justify_center().rounded_full().cursor_pointer()
      .bg(t.raised).border_1().border_color(t.border).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.banner = i + d; cx.notify(); })).child(svg(ICON(icon)).size(14));
    return h_flex().id("banner").p(24).gap(24).items_center().rounded(14).bg(t.selected).border_1().border_color(t.border)
      .child(v_flex().flex_1().min_w(0).gap(6)
        .child(div().text_size(12).text_color(t.muted).child("From Anthropic"))
        .child(div().text_size(24).font_family("Georgia").child(p.name))
        .child(div().text_size(13.5).text_color(t.muted).max_h(40).overflow_hidden().child(p.desc))
        .child(h_flex().mt(8).gap(10).items_center()
          .child(p.state ? h_flex().gap(6).items_center().text_size(13).text_color(t.ansi2).child(svg(ICON("check")).size(14)).child("Installed")
            : this.busy[p.target] ? h_flex().gap(6).items_center().text_size(13).text_color(t.muted).child(svg(ICON("spinner")).size(14).spin(900)).child("Installing…")
              : this.button("banner-add", "Add", t, (cx) => this.install(p, cx), { primary: true, h: 28 }))
          .child(div().text_size(12).text_color(t.dim).child(p.meta))))
      .child(v_flex().flex_none().items_center().gap(14)
        .child(div().size(84).flex().items_center().justify_center().rounded(18).bg(t.background).border_1().border_color(t.border)
          .child(svg(ICON("box")).size(40).text_color(t.muted)))
        .child(h_flex().gap(8).items_center()
          .child(arrow("banner-prev", "chevron-left", -1))
          .child(div().text_size(11.5).text_color(t.dim).child(`${i + 1} / ${list.length}`))
          .child(arrow("banner-next", "chevron-right", 1))));
  }

  note(t, text) {
    return h_flex().p(16).gap(12).items_start().rounded(12).bg(t.surface).border_1().border_color(t.border)
      .child(svg(ICON("plug")).size(18).mt(1).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).text_size(13).text_color(t.muted).line_height("20px").child(text));
  }

  // One list in full: "Show all", search results, or a Yours section.
  fullList(title, items, t) {
    const list = this.shape(items), shown = list.slice(0, this.limit);
    return v_flex().gap(14)
      .child(this.sectionHead(title, list.length, t, null))
      .child(list.length ? this.grid(shown, t) : div().py(30).text_size(13).text_color(t.dim).child(this.query ? `Nothing matches "${this.query}".` : "Nothing here."))
      .when(list.length > shown.length, (el) => el.child(h_flex().justify_center().child(
        this.button("more", `Show ${Math.min(PAGE, list.length - shown.length)} more of ${list.length - shown.length}`, t, (cx) => { this.limit += PAGE; cx.notify(); }))));
  }

  backLink(t) {
    return this.stop(h_flex().id("back").gap(6).items_center().cursor_pointer().text_size(13).text_color(t.muted).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.showAll = null; this.limit = PAGE; cx.notify(); }))
      .child(svg(ICON("arrow-left")).size(14)).child("Back");
  }

  body(t) {
    const sections = this.sections(), yours = this.mode === "yours";
    const loading = { plugins: "Loading plugins…", skills: "Loading skills…", connectors: "Checking connectors (takes ~10 s the first time)…" }[this.tab];
    if (!sections) return [this.skeleton(t, loading)];
    const out = [];

    if (this.tab === "connectors" && !yours) out.push(this.note(t,
      "Claude Code has no connector directory: claude.ai's lives on claude.ai (Settings › Connectors), and the ones you added there appear under Yours. "
      + "Below are the MCP servers that marketplace plugins bring; + installs the plugin."));
    if (this.tab === "connectors" && yours) out.push(h_flex().gap(8).items_center()
      .child(div().flex_1().text_size(12.5).text_color(t.dim).child(this.mcpLoading ? "Checking every server's health…" : "Needs authentication? Connect signs in (claude mcp login) in a new tab."))
      .child(this.button("recheck", this.mcpLoading ? "Checking…" : "Recheck", t, (cx) => this.refreshMcp(cx), { h: 26 })));

    const all = sections.flatMap((s) => s.items);
    if (this.query) {
      const seen = new Set();
      out.push(this.fullList("Results", all.filter((i) => !seen.has(i.key) && seen.add(i.key)), t));
      return out;
    }
    if (this.showAll) {
      const s = sections.find((x) => x.key === this.showAll);
      if (s) return [this.backLink(t), this.fullList(s.title, s.items, t)];
    }
    if (this.tab === "plugins" && !yours) { const b = this.bannerCard(t); if (b) out.push(b); }
    if (!all.length) out.push(div().py(30).text_size(13).text_color(t.dim).child(yours ? "Nothing installed yet. Find something under Discover." : "Nothing in your marketplaces' catalogs."));
    for (const s of sections) {
      if (!s.items.length) continue;
      // Yours is short: show it whole. Discover filtered/sorted still previews (thousands of cards at
      // once froze the window, review 2026-11-01); "Show all" pages by 40.
      if (yours || this.filter !== "all" || this.sort !== "popular") {
        const list = this.shape(s.items);
        const shown = yours ? list : list.slice(0, PREVIEW);
        out.push(v_flex().gap(12).child(this.sectionHead(s.title, list.length, t, !yours && list.length > shown.length ? this.showAllLink(s.key, t) : null)).child(this.grid(shown, t)));
        this.memo = null;
        continue;
      }
      const preview = (s.preview ?? s.items).slice(0, PREVIEW);
      out.push(v_flex().gap(12)
        .child(this.sectionHead(s.title, s.items.length, t, s.items.length > preview.length ? this.showAllLink(s.key, t) : null))
        .child(this.grid(preview, t)));
    }
    return out;
  }

  render() {
    const t = theme();
    const errors = Object.values(this.errors);
    return v_flex().id("customize").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 4) { this.width = size.width; cx.notify(); } })
      .child(v_flex().id("customize-scroll").flex_1().min_h(0).overflow_y_scrollbar()
        // Centered at most 1080 wide by padding, not by justify_center: a centered child wider
        // than the pane spills off both edges.
        .child(v_flex().w_full().min_w(0).px(Math.max(24, (this.width - 1080) / 2)).pt(34).pb(48).gap(20)
          .child(div().text_size(30).font_family("Georgia").child("Customize"))
          .child(this.toolbar(t))
          .when(this.adding, (el) => el.child(this.addPanel(t)))
          .when(errors.length > 0, (el) => el.child(div().text_size(12).text_color(t.ansi1).child(errors.join("  ·  "))))
          .children(this.body(t))));
  }
}
