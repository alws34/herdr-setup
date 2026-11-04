// Changes, VSCode style (a clone of Herdr's `changes`, 0.1.11). Two roles:
// - the list (default): commit box on top, then the changed files, filling its block
//   (made for a sidebar section);
// - the diff (props.diff): a pane split to the right of the terminal, showing the file
//   picked in the list. Clicking another file reuses that pane (shared "changes-vs.open").
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, props, shared, setShared, run } from "herdr";

const OPEN = "changes-vs.open";
const MOD = "changes-vs";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const statusColor = (s, t) => s === "A" ? t.ansi2 : s === "D" || s === "U" ? t.ansi1 : t.blocked;

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

// One file's diff lines: a new file as all-added, else `git diff [HEAD] -- path`.
async function diffLines(f) {
  if (f.fresh || (!f.hasHead && f.status === "A")) {
    const text = await readTextFile(`${f.root}/${f.path}`, { on: f.on }).catch(() => null);
    if (text === null) return ["Cannot preview this file (binary, too large, or unreadable)"];
    if (text.includes("\0")) return ["Binary file · no text diff"];
    return [`@@ -0,0 +1,${countLines(text)} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
  }
  const r = await exec("git", [...READ, "diff", ...(f.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", f.path], { cwd: f.root, on: f.on });
  if (r.code !== 0) throw new Error(r.stderr);
  const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
  return first < 0 ? ["No text diff available"] : all.slice(first);
}

export default class Changes extends View {
  init(_props, cx) {
    this.diff = Boolean(props()?.diff);
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = "";
    if (this.diff) {
      cx.timer.every(5000, (cx) => this.loadDiff(cx, true));
      return;
    }
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Message (Enter to commit)" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  // ---- list ----

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = [];
      this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          files.push({ path, status: s, fresh, ...(stats[path] ?? { add: 0, del: 0 }) });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // Shows the file in the diff pane of the shown tab, splitting one off the terminal if there's none.
  pick(f) {
    setShared(OPEN, { root: this.root, on: this.on ?? null, hasHead: this.hasHead, path: f.path, status: f.status, fresh: f.fresh, at: Date.now() });
    const space = spaces().find((s) => s.active), tab = space?.tabs.find((t) => t.active);
    if (!tab) return;
    const tabPanes = panes().filter((p) => p.tab === tab.id);
    if (tabPanes.some((p) => p.mod === MOD)) return;
    const from = tabPanes.find((p) => p.pane === focused()?.pane) ?? tabPanes.find((p) => p.terminal) ?? tabPanes[0];
    run("pane.split", { direction: "right", ...(from ? { pane: from.pane } : {}), mod: MOD, props: { diff: true } });
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  renderList(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), open = shared(OPEN);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    return v_flex().id("changes").size_full().min_h(0).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(v_flex().flex_none().px(10).pt(8).pb(6).gap(6)
        .child(div().id("commit-message").w_full().h(30).px(10).flex().items_center().rounded(7).bg(t.surface).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").w_full().h(28).flex().items_center().justify_center().rounded(7).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "✓ Commit")))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(6).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(v_flex().id("changes-list").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(6).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        const on = open?.root === this.root && open?.path === f.path;
        return h_flex().id(`change-${f.path}`).h(24).flex_none().px(8).gap(6).items_center().rounded(5).cursor_pointer().when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click(() => this.pick(f))
          .child(div().flex_none().max_w(200).truncate().child(name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))
          .when(f.add > 0, (e) => e.child(div().text_size(10.5).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(10.5).text_color(t.ansi1).child(`−${f.del}`)))
          .child(div().w(12).flex_none().text_size(11).text_color(statusColor(f.status, t)).child(f.fresh ? "U" : f.status));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")));
  }

  // ---- diff pane ----

  loadDiff(cx, again) {
    const f = shared(OPEN);
    if (!f || this.loadingDiff) return;
    const id = `${f.root}\0${f.path}\0${f.at}`;
    if (!again && id === this.shown) return;
    this.shown = id; this.loadingDiff = true;
    cx.spawn(async (cx) => {
      let lines;
      try { lines = await diffLines(f); } catch (e) { lines = [`Cannot preview this diff: ${e}`]; }
      finally { this.loadingDiff = false; }
      if (this.shown !== id) return;
      lines = lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line);
      const text = lines.join("\n");
      if (text === this.text) return;
      this.text = text; this.rows = diffRows(lines);
      this.add = this.rows.filter((r) => r.kind === "+").length; this.del = this.rows.filter((r) => r.kind === "-").length;
      this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
      cx.notify();
    });
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  renderDiff(cx) {
    this.loadDiff(cx, false);
    const t = theme(), f = shared(OPEN);
    if (!f) return div().size_full().p(16).text_color(t.dim).child("Click a file in Changes to see its diff here");
    const parts = f.path.split("/"), name = parts.pop();
    return v_flex().id("diff").size_full().min_h(0).text_color(t.foreground).text_size(13)
      .child(h_flex().h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(11).text_color(statusColor(f.status, t)).child(f.fresh ? "U" : f.status))
        .child(div().font_semibold().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/")))
        .child(div().text_size(11).text_color(t.ansi2).child(`+${this.add ?? 0}`))
        .child(div().text_size(11).text_color(t.ansi1).child(`−${this.del ?? 0}`)))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("diff-rows", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0()));
  }

  render(cx) { return this.diff ? this.renderDiff(cx) : this.renderList(cx); }
}
