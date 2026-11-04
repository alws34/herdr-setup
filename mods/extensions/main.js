// Extensions: Claude Code's plugins, skills, MCP servers and subagents in one place, as
// VSCode's Extensions view. Everything goes through Claude Code's own CLI and settings, so it
// stays in step with /plugin, /mcp and /skills; changes apply to sessions started afterwards.
// - Plugins: installed ones (enable / disable, update, uninstall, always-on token cost from
//   `claude plugin details`), and the marketplaces' catalog to search and install from.
// - Skills: yours (~/.claude/skills) and the plugins'. On / name only / off is settings.json's
//   `skillOverrides`. A click opens the SKILL.md in the editor pane.
// - MCP: `claude mcp list` with status; Sign in opens `claude mcp login` in a new tab; remove;
//   add an HTTP URL or a command.
// - Agents: ~/.claude/agents and the plugins'. Turning one of yours off moves its file to
//   ~/.claude/agents.disabled (Claude Code has no switch for agents); on moves it back.
import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { exec, home, appHome, readTextFile, writeTextFile, theme, run, spaces, panes, focused, setShared, notify } from "herdr";

const TABS = [["plugins", "Plugins"], ["skills", "Skills"], ["mcp", "MCP"], ["agents", "Agents"]];
const SHOW = 60;
const SETTINGS = () => `${home()}/.claude/settings.json`;
const OFF_AGENTS = () => `${home()}/.claude/agents.disabled`;
const unquote = (s) => (s ?? "").replace(/^["']|["']$/g, "");

// Long CLI calls go through herdr-core, whose limit can be raised past exec's 30 s.
const claude = (args, timeout = 30) => exec("hc", ["exec", "--timeout", String(timeout), "--", "claude", ...args]);

function openInEditor(path) {
  const space = spaces().find((s) => s.active), tab = space?.tabs.find((x) => x.active);
  if (!tab) return;
  setShared("editor.open", { path, on: null, tab: tab.id, at: Date.now() });
  const tabPanes = panes().filter((p) => p.tab === tab.id);
  if (tabPanes.some((p) => p.mod === "editor")) return;
  const from = tabPanes.find((p) => p.pane === focused()?.pane && p.terminal) ?? tabPanes.find((p) => p.terminal) ?? tabPanes[0];
  run("pane.split", { direction: "right", ...(from ? { pane: from.pane } : {}), mod: "editor", props: { tab: tab.id } });
}

// A Claude tab in the shown space running a command (sign-ins need a browser round trip).
function inTab(argv, name) {
  const space = spaces().find((s) => s.active);
  run("tab.new", { ...(space ? { space: space.id } : {}), name, argv });
}

// "name: target - ✔ Connected" lines; the name may hold colons, the target " - ".
function parseMcp(out) {
  return out.split("\n").map((l) => l.trim()).filter((l) => / - [✔✘!⏸]/.test(l)).map((l) => {
    const cut = l.indexOf(": "), dash = l.lastIndexOf(" - ");
    const name = l.slice(0, cut), target = l.slice(cut + 2, dash), status = l.slice(dash + 3);
    const kind = name.startsWith("claude.ai ") ? "claude.ai" : name.startsWith("plugin:") ? "plugin" : "local";
    return { name, target, status, kind, ok: status.startsWith("✔"), auth: /auth/i.test(status) };
  });
}

export default class Extensions extends View {
  init(_props, cx) {
    this.tab = "plugins";
    this.query = "";
    this.input = InputState.new({ placeholder: "Search extensions" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value().trim().toLowerCase(); cx.notify(); });
    this.addName = InputState.new({ placeholder: "name" });
    this.addTarget = InputState.new({ placeholder: "https://…/mcp  or  command args" });
    this.plugins = null; this.available = []; this.items = null; this.mcp = null; this.cost = {};
    this.busy = {}; this.confirm = null; this.overrides = {};
    this.loadPlugins(cx);
    this.loadSettings(cx);
    this.loadMcp(cx);
  }

  // --- loading ---------------------------------------------------------------------------

  loadPlugins(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await claude(["plugin", "list", "--json", "--available"], 60);
        const d = JSON.parse(r.stdout);
        this.plugins = d.installed ?? []; this.available = d.available ?? []; this.error = null;
        this.loadItems(cx);
        this.loadCosts(this.plugins.map((p) => p.id), cx);
      } catch (e) { this.error = `claude plugin list: ${e.message ?? e}`; this.plugins = []; }
      cx.notify();
    });
  }

  // One at a time: several `claude` processes at once time out.
  loadCosts(ids, cx) {
    cx.spawn(async (cx) => {
      for (const id of ids) {
        try {
          const r = await claude(["plugin", "details", id], 60);
          const m = r.stdout.match(/Always-on:\s+~?([\d.,]+k?)\s*tok/);
          if (m) this.cost[id] = m[1];
        } catch { /* no cost shown */ }
        cx.notify();
      }
    });
  }

  loadItems(cx) {
    cx.spawn(async (cx) => {
      try {
        const pairs = (this.plugins ?? []).filter((p) => p.installPath).flatMap((p) => [p.id.split("@")[0], p.installPath]);
        const r = await exec("sh", [`${appHome()}/mods/extensions/scan.sh`, OFF_AGENTS(), ...pairs]);
        this.items = r.stdout.split("\n").filter(Boolean).map((l) => {
          const [kind, source, name, desc, path, state] = l.split("\t");
          return { kind, source, name: source === "user" ? name : `${source}:${name}`, desc: unquote(desc), path, on: state === "on" };
        });
      } catch (e) { this.error = `scan: ${e.message ?? e}`; this.items = []; }
      cx.notify();
    });
  }

  loadSettings(cx) {
    cx.spawn(async (cx) => {
      try { this.overrides = JSON.parse((await readTextFile(SETTINGS())) ?? "{}").skillOverrides ?? {}; } catch { this.overrides = {}; }
      cx.notify();
    });
  }

  loadMcp(cx) {
    if (this.mcpLoading) return;
    this.mcpLoading = true;
    cx.spawn(async (cx) => {
      try { this.mcp = parseMcp((await claude(["mcp", "list"], 90)).stdout); }
      catch (e) { this.error = `claude mcp list: ${e.message ?? e}`; this.mcp = this.mcp ?? []; }
      finally { this.mcpLoading = false; cx.notify(); }
    });
    cx.notify();
  }

  // --- actions ---------------------------------------------------------------------------

  // Runs a CLI change, then reloads; `key` marks the row busy meanwhile.
  act(key, args, done, cx, timeout = 180) {
    this.busy[key] = true; this.confirm = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await claude(args, timeout);
        if (r.code !== 0) notify({ title: `claude ${args.slice(0, 2).join(" ")} failed`, body: (r.stderr || r.stdout).trim().slice(0, 300), level: "error" });
        else notify({ title: `Done: claude ${args.join(" ")}`, body: "New Claude sessions pick this up.", level: "success", timeout: 5000 });
      } catch (e) { notify({ title: "Failed", body: String(e.message ?? e), level: "error" }); }
      finally { delete this.busy[key]; done(cx); cx.notify(); }
    });
  }

  // skillOverrides: on (no entry) → name-only → off → on.
  cycleSkill(name, cx) {
    cx.spawn(async (cx) => {
      try {
        const text = (await readTextFile(SETTINGS())) ?? "{}", s = JSON.parse(text);
        const next = { undefined: "name-only", on: "name-only", "name-only": "off", off: undefined }[s.skillOverrides?.[name]];
        s.skillOverrides = { ...(s.skillOverrides ?? {}) };
        if (next) s.skillOverrides[name] = next; else delete s.skillOverrides[name];
        if (!Object.keys(s.skillOverrides).length) delete s.skillOverrides;
        await writeTextFile(SETTINGS(), JSON.stringify(s, null, 2) + "\n", text);
        this.overrides = s.skillOverrides ?? {};
      } catch (e) { notify({ title: "Couldn't change settings.json", body: String(e.message ?? e), level: "error" }); }
      cx.notify();
    });
  }

  toggleAgent(item, cx) {
    const name = item.path.split("/").pop();
    const to = item.on ? `${OFF_AGENTS()}/${name}` : `${home()}/.claude/agents/${name}`;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'mkdir -p "$(dirname "$2")" && mv -n "$1" "$2"', "mv", item.path, to]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: "Couldn't move the agent", body: r.stderr, level: "error" });
      this.loadItems(cx);
    });
  }

  addMcp(cx) {
    const name = this.addName.value().trim(), target = this.addTarget.value().trim();
    if (!name || !target) return;
    const args = /^https?:\/\//.test(target)
      ? ["mcp", "add", "--scope", "user", "--transport", "http", name, target]
      : ["mcp", "add", "--scope", "user", name, "--", ...target.split(/\s+/)];
    this.act(`mcp-add`, args, (cx) => { this.addName.set_value(""); this.addTarget.set_value(""); this.loadMcp(cx); }, cx, 60);
  }

  // --- drawing ---------------------------------------------------------------------------

  button(id, label, t, onClick, opts = {}) {
    return div().id(id).flex_none().px(7).h(20).flex().items_center().rounded(4).cursor_pointer().text_size(11)
      .bg(opts.primary ? t.solid : t.raised).text_color(opts.danger ? t.ansi1 : opts.primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.85)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
  }

  // A two-click button for destructive actions.
  danger(id, label, t, onClick) {
    const armed = this.confirm === id;
    return this.button(id, armed ? "Sure?" : label, t, (cx) => { if (armed) onClick(cx); else { this.confirm = id; cx.notify(); } }, { danger: true });
  }

  row(id, title, sub, right, t, opts = {}) {
    return h_flex().id(id).flex_none().px(10).py(5).gap(8).items_start().hover((s) => s.bg(t.hover))
      .when(Boolean(opts.onClick), (el) => el.cursor_pointer().on_click((_e, cx) => opts.onClick(cx)))
      .child(div().mt(5).size(7).flex_none().rounded_full().bg(opts.dot ?? t.dim))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(6).items_center()
          .child(div().min_w(0).truncate().text_size(12.5).text_color(opts.dim ? t.muted : t.foreground).font_weight(600).child(title))
          .when(Boolean(opts.badge), (el) => el.child(div().flex_none().px(5).rounded(3).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(opts.badge ?? ""))))
        .when(Boolean(sub), (el) => el.child(div().text_size(11).text_color(t.dim).max_h(30).overflow_hidden().child(sub ?? ""))))
      .child(h_flex().flex_none().gap(4).items_center().children(right));
  }

  group(title, n, t) {
    return h_flex().flex_none().h(24).px(10).mt(4).items_center().gap(6)
      .child(div().text_size(10.5).font_weight(700).text_color(t.muted).child(title.toUpperCase()))
      .child(div().text_size(10.5).text_color(t.dim).child(n == null ? "" : String(n)));
  }

  match(...fields) { return !this.query || fields.some((f) => (f ?? "").toLowerCase().includes(this.query)); }

  plugins_(t) {
    if (!this.plugins) return [div().p(12).text_size(11.5).text_color(t.dim).child("Loading plugins…")];
    const installed = this.plugins.filter((p) => this.match(p.id));
    const ids = new Set(this.plugins.map((p) => p.id));
    const out = [this.group("Installed", installed.length, t)];
    for (const p of installed) {
      const busy = this.busy[p.id], failed = p.errors?.length || p.error;
      out.push(this.row(`p-${p.id}`, p.id.split("@")[0], `${p.id.split("@")[1]} · v${String(p.version).slice(0, 12)}${this.cost[p.id] ? ` · ~${this.cost[p.id]} tok/session` : ""}${failed ? " · failed to load" : ""}`,
        busy ? [div().text_size(11).text_color(t.dim).child("working…")] : [
          this.button(`pt-${p.id}`, p.enabled ? "Disable" : "Enable", t, (cx) => this.act(p.id, ["plugin", p.enabled ? "disable" : "enable", p.id], (cx) => this.loadPlugins(cx), cx)),
          this.button(`pu-${p.id}`, "Update", t, (cx) => this.act(p.id, ["plugin", "update", p.id], (cx) => this.loadPlugins(cx), cx)),
          this.danger(`px-${p.id}`, "Remove", t, (cx) => this.act(p.id, ["plugin", "uninstall", p.id], (cx) => this.loadPlugins(cx), cx)),
        ], t, { dot: failed ? t.ansi1 : p.enabled ? t.ansi2 : t.dim, dim: !p.enabled }));
    }
    const avail = this.available.filter((a) => !ids.has(a.pluginId) && this.match(a.name, a.description, a.marketplaceName));
    out.push(h_flex().flex_none().pr(10).items_center()
      .child(div().flex_1().child(this.group("Marketplace", avail.length, t)))
      .child(this.button("mk-update", this.busy.mk ? "Updating…" : "Update catalogs", t, (cx) => this.act("mk", ["plugin", "marketplace", "update"], (cx) => this.loadPlugins(cx), cx))));
    if (!this.query) out.push(div().px(10).pb(4).text_size(11).text_color(t.dim).child(`${this.available.length} plugins in your marketplaces. Type to search.`));
    else for (const a of avail.slice(0, SHOW)) {
      out.push(this.row(`a-${a.pluginId}`, a.name, a.description, this.busy[a.pluginId] ? [div().text_size(11).text_color(t.dim).child("installing…")]
        : [this.button(`ai-${a.pluginId}`, "Install", t, (cx) => this.act(a.pluginId, ["plugin", "install", a.pluginId], (cx) => this.loadPlugins(cx), cx), { primary: true })],
        t, { badge: a.marketplaceName }));
    }
    if (avail.length > SHOW && this.query) out.push(div().px(10).text_size(11).text_color(t.dim).child(`… ${avail.length - SHOW} more, refine the search`));
    return out;
  }

  skills_(t) {
    if (!this.items) return [div().p(12).text_size(11.5).text_color(t.dim).child("Loading skills…")];
    const all = this.items.filter((i) => i.kind === "skill" && this.match(i.name, i.desc));
    const label = { "name-only": "Name only", off: "Off", "user-invocable-only": "/ only" };
    const out = [];
    for (const source of [...new Set(all.map((i) => i.source))]) {
      const list = all.filter((i) => i.source === source);
      out.push(this.group(source === "user" ? "Your skills" : source, list.length, t));
      for (const i of list) {
        const o = this.overrides[i.name];
        out.push(this.row(`s-${i.name}`, i.name, i.desc,
          [this.button(`so-${i.name}`, label[o] ?? "On", t, (cx) => this.cycleSkill(i.name, cx))], t,
          { dot: o === "off" ? t.dim : o ? t.blocked : t.ansi2, dim: o === "off", onClick: () => openInEditor(i.path) }));
      }
    }
    out.push(div().px(10).py(6).text_size(10.5).text_color(t.dim).child("On → Name only (listed without its description, saves tokens) → Off. Plugin skills also go with their plugin."));
    return out;
  }

  mcp_(t) {
    if (!this.mcp) { return [div().p(12).text_size(11.5).text_color(t.dim).child("Checking MCP servers (takes ~10 s)…")]; }
    const list = this.mcp.filter((m) => this.match(m.name, m.target));
    const out = [h_flex().flex_none().pr(10).items_center()
      .child(div().flex_1().child(this.group("Servers", list.length, t)))
      .child(this.button("mcp-refresh", this.mcpLoading ? "Checking…" : "Recheck", t, (cx) => this.loadMcp(cx)))];
    for (const m of list) {
      const right = [];
      if (m.auth) right.push(this.button(`ml-${m.name}`, "Sign in", t, () => inTab(["claude", "mcp", "login", m.name], `Sign in: ${m.name}`), { primary: true }));
      if (m.kind === "local") right.push(this.busy[m.name] ? div().text_size(11).text_color(t.dim).child("removing…")
        : this.danger(`mx-${m.name}`, "Remove", t, (cx) => this.act(m.name, ["mcp", "remove", m.name, "--scope", "user"], (cx) => this.loadMcp(cx), cx, 30)));
      if (m.kind === "claude.ai") right.push(div().text_size(10).text_color(t.dim).child("claude.ai"));
      if (m.kind === "plugin") right.push(div().text_size(10).text_color(t.dim).child("plugin"));
      out.push(this.row(`m-${m.name}`, m.name.replace(/^claude\.ai /, ""), `${m.target} · ${m.status}`, right, t,
        { dot: m.ok ? t.ansi2 : m.auth ? t.blocked : t.ansi1 }));
    }
    out.push(this.group("Add a server", null, t),
      v_flex().flex_none().px(10).gap(5)
        .child(div().h(26).px(8).flex().items_center().rounded(5).bg(t.surface).border_1().border_color(t.border).child(Input.new(this.addName).text_size(12)))
        .child(div().h(26).px(8).flex().items_center().rounded(5).bg(t.surface).border_1().border_color(t.border).child(Input.new(this.addTarget).text_size(12)))
        .child(h_flex().gap(6).items_center()
          .child(this.button("mcp-add", this.busy["mcp-add"] ? "Adding…" : "Add for all projects", t, (cx) => this.addMcp(cx), { primary: true }))
          .child(div().text_size(10.5).text_color(t.dim).child("A URL adds an HTTP server; anything else runs as a command."))),
      div().px(10).py(6).text_size(10.5).text_color(t.dim).child("claude.ai connectors are added and removed at claude.ai › Settings › Connectors; plugin servers go with their plugin."));
    return out;
  }

  agents_(t) {
    if (!this.items) return [div().p(12).text_size(11.5).text_color(t.dim).child("Loading agents…")];
    const all = this.items.filter((i) => i.kind === "agent" && this.match(i.name, i.desc));
    const out = [];
    for (const source of [...new Set(all.map((i) => i.source))]) {
      const list = all.filter((i) => i.source === source).sort((a, b) => Number(b.on) - Number(a.on) || a.name.localeCompare(b.name));
      out.push(this.group(source === "user" ? `Your agents · ${list.filter((i) => i.on).length} on` : source, list.length, t));
      for (const i of list) out.push(this.row(`g-${i.path}`, i.name, i.desc,
        source === "user" ? [this.button(`gt-${i.path}`, i.on ? "Turn off" : "Turn on", t, (cx) => this.toggleAgent(i, cx))] : [],
        t, { dot: i.on ? t.ansi2 : t.dim, dim: !i.on, onClick: () => openInEditor(i.path) }));
    }
    out.push(div().px(10).py(6).text_size(10.5).text_color(t.dim).child("Every agent that's on adds its description to each session. Off moves the file to ~/.claude/agents.disabled."));
    return out;
  }

  render(cx) {
    const t = theme();
    const counts = {
      plugins: this.plugins?.length, mcp: this.mcp?.length,
      skills: this.items?.filter((i) => i.kind === "skill").length, agents: this.items?.filter((i) => i.kind === "agent" && i.on).length,
    };
    const body = { plugins: () => this.plugins_(t), skills: () => this.skills_(t), mcp: () => this.mcp_(t), agents: () => this.agents_(t) }[this.tab]();
    return v_flex().id("extensions").size_full().min_h(0).text_color(t.foreground)
      .child(div().flex_none().px(10).pt(8).pb(6)
        .child(div().w_full().h(28).px(9).flex().items_center().rounded(7).bg(t.surface).border_1().border_color(t.border)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12))))
      .child(h_flex().flex_none().px(6).h(28).gap(2).border_b(1).border_color(t.border).children(TABS.map(([id, name]) =>
        div().id(`tab-${id}`).px(8).h_full().flex().items_center().gap(4).cursor_pointer().text_size(11.5)
          .text_color(this.tab === id ? t.foreground : t.muted).when(this.tab === id, (el) => el.border_b(2).border_color(t.accent))
          .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.tab = id; this.confirm = null; cx.notify(); })
          .child(name).when(counts[id] != null, (el) => el.child(div().text_size(10).text_color(t.dim).child(String(counts[id] ?? "")))))))
      .when(Boolean(this.error), (el) => el.child(div().px(10).py(4).text_size(10.5).text_color(t.ansi1).child(this.error ?? "")))
      .child(v_flex().id("ext-list").flex_1().min_h(0).overflow_y_scrollbar().pb(8).children(body));
  }
}
