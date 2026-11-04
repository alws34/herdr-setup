// System utilization, btop style, of the machine the current session runs on (or one picked).
// Roles (props.role):
// - "panel" (default): CPU (per core, temperature, history), GPU (load, temperature, memory),
//   memory and swap, disks (the main one, network mounts, external ones), network rates and
//   the top 5 processes. A row of machine chips picks Auto (the focused session's machine),
//   this computer or another Herdr machine (shared "sysmon.machine", for every copy).
// - "bar": one line for the title bar; a click opens the Utilization side bar section.
// collect.sh does the measuring (sent as `sh -c` text, so it runs on remote machines too);
// copies share one snapshot per machine (shared "sysmon.snap") so they don't each measure.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, readTextFile, appHome, machines, spaces, focused, theme, props, shared, setShared, settings } from "herdr";

const SNAP = "sysmon.snap", BUSY = "sysmon.busy", PICK = "sysmon.machine";
const EVERY = 2000, BAR_EVERY = 5000, HISTORY = 60;
const NETFS = /^(smbfs|smb3?|cifs|nfs\d?|afpfs|webdav|davfs|ftp|9p|ceph|glusterfs|sshfs|fuse\.sshfs|fuse\.rclone|osxfuse|macfuse)/;

// --- measuring ---------------------------------------------------------------------------

function sections(text) {
  const out = {};
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("@")) { cur = line.slice(1).trim(); out[cur] = []; }
    else if (cur && line.trim()) out[cur].push(line);
  }
  return out;
}
const num = (s) => Number.parseFloat(s);
const kv = (line, key) => { const m = line.match(new RegExp(`"${key}"=(\\d+)`)); return m ? Number(m[1]) : null; };

// Linux /proc/stat: busy share between two samples, per "cpu" and "cpuN" line.
function procStat(a = [], b = []) {
  const parse = (l) => { const f = l.trim().split(/\s+/); const v = f.slice(1).map(Number); return [f[0], v.reduce((x, y) => x + y, 0), v[3] + (v[4] || 0)]; };
  const before = Object.fromEntries(a.map(parse).map(([n, tot, idle]) => [n, { tot, idle }]));
  const res = {};
  for (const [n, tot, idle] of b.map(parse)) {
    const p = before[n]; if (!p) continue;
    const dt = tot - p.tot; res[n] = dt > 0 ? 1 - (idle - p.idle) / dt : 0;
  }
  return res;
}

function disks(df = [], mount = [], darwin) {
  const types = {};
  for (const l of mount) {
    const m = l.match(/^(.*?) on (.*?) (?:type (\S+) )?\(([^,)]+)/);
    if (m) types[m[2]] = /nobrowse/.test(l) ? "hidden" : m[3] ?? m[4];
  }
  const out = [];
  for (const l of df.slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f.length < 6) continue;
    const at = f.slice(5).join(" "), used = Number(f[2]) * 1024, total = (Number(f[2]) + Number(f[3])) * 1024, type = types[at] ?? "";
    const main = darwin ? at === "/System/Volumes/Data" : at === "/";
    if (!total || (type === "hidden" && !main)) continue;
    if (NETFS.test(type)) out.push({ name: at.split("/").pop() || at, at, used, total, kind: "net", type });
    else if (main) out.unshift({ name: "Main", at, used, total, kind: "main", type: "" });
    else if (darwin ? at.startsWith("/Volumes/") : /^\/(mnt|media|data|home)\b/.test(at) && /^\/dev\//.test(f[0])) out.push({ name: at.split("/").pop(), at, used, total, kind: "ext", type });
  }
  return out;
}

function parse(text) {
  const s = sections(text), host = (s.host?.[0] ?? "").split(" "), darwin = host[0] === "Darwin";
  const snap = { host: host[1] ?? "?", os: darwin ? "macOS" : host[0] || "?", ncpu: Number(s.ncpu?.[0]) || 1, cpuName: (s.cpuname?.[0] ?? "").trim() };
  const load = (s.load?.[0] ?? "").replace(/[{}]/g, "").trim().split(/\s+/).map(Number);
  snap.load = load.length >= 3 ? load : null;
  if (darwin) {
    const boot = (s.uptime?.[0] ?? "").match(/sec = (\d+)/);
    snap.uptime = boot ? Date.now() / 1000 - Number(boot[1]) : null;
    let mac = null;
    try { mac = s.macmon?.[0] ? JSON.parse(s.macmon[0]) : null; } catch { mac = null; }
    if (mac) {
      const cores = [...(mac.ecpu_cores ?? []), ...(mac.pcpu_cores ?? [])];
      snap.cores = cores.map((c) => c.active_ratio);
      snap.cpu = cores.length ? snap.cores.reduce((a, b) => a + b, 0) / cores.length : null;
      snap.cpuTemp = mac.temp?.cpu_temp_avg || null; snap.gpuTemp = mac.temp?.gpu_temp_avg || null;
      snap.power = mac.all_power ?? null; snap.cpuMhz = mac.pcpu_freq_mhz ?? null;
      snap.fan = mac.fans?.[0]?.rpm ?? null;
      if (mac.memory) { snap.mem = [mac.memory.ram_usage, mac.memory.ram_total]; snap.swap = [mac.memory.swap_usage, mac.memory.swap_total]; }
    } else {
      const idle = (s.top?.[0] ?? "").match(/([\d.]+)% idle/);
      snap.cpu = idle ? 1 - num(idle[1]) / 100 : null;
    }
    if (!snap.mem) {
      const page = Number(((s.vmstat?.[0] ?? "").match(/page size of (\d+)/) ?? [])[1]) || 16384;
      const pages = (k) => Number(((s.vmstat ?? []).find((l) => l.startsWith(k)) ?? "").replace(/\D/g, "")) || 0;
      snap.mem = [(pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * page, Number(s.memsize?.[0]) || 0];
      const sw = (s.swap?.[0] ?? "").match(/total = ([\d.]+)M\s+used = ([\d.]+)M/);
      snap.swap = sw ? [num(sw[2]) * 2 ** 20, num(sw[1]) * 2 ** 20] : null;
    }
    const g = s.gpu?.[0] ?? "";
    if (g) snap.gpus = [{ name: snap.cpuName ? `${snap.cpuName} GPU` : "GPU", load: (kv(g, "Device Utilization %") ?? 0) / 100, temp: snap.gpuTemp, mem: [kv(g, "In use system memory") ?? 0, snap.mem?.[1] ?? 0], unified: true }];
  } else {
    snap.uptime = num(s.uptime?.[0]) || null;
    const st = procStat(s.stat1, s.stat2);
    snap.cpu = st.cpu ?? null;
    snap.cores = Object.keys(st).filter((k) => k !== "cpu").sort((a, b) => num(a.slice(3)) - num(b.slice(3))).map((k) => st[k]);
    const mi = Object.fromEntries((s.meminfo ?? []).map((l) => { const [k, v] = l.split(/:\s+/); return [k, num(v) * 1024]; }));
    snap.mem = [mi.MemTotal - mi.MemAvailable, mi.MemTotal];
    snap.swap = mi.SwapTotal ? [mi.SwapTotal - mi.SwapFree, mi.SwapTotal] : null;
    const zones = (s.thermal ?? []).map((l) => { const [type, v] = l.split(" "); return { type, c: num(v) / 1000 }; }).filter((z) => z.c > 0 && z.c < 150);
    const cpuZone = zones.find((z) => /x86_pkg|coretemp|k10temp|cpu|soc|tctl/i.test(z.type)) ?? zones.sort((a, b) => b.c - a.c)[0];
    snap.cpuTemp = cpuZone?.c ?? null;
    snap.gpus = (s.nvidia ?? []).map((l) => {
      const [name, load, temp, used, total, power] = l.split(",").map((x) => x.trim());
      return { name, load: num(load) / 100, temp: num(temp) || null, mem: [num(used) * 2 ** 20, num(total) * 2 ** 20], power: num(power) || null };
    });
  }
  const [rx, tx] = (s.net?.[0] ?? "0 0").split(" ").map(Number);
  snap.net = { rx, tx };
  snap.procs = (s.ps ?? []).map((l) => {
    const f = l.trim().split(/\s+/), cmd = f.slice(4).join(" ");
    const name = cmd.includes("/") ? cmd.split("/").pop() : cmd;
    return { pid: f[0], cpu: num(f[1]), mem: num(f[2]), rss: Number(f[3]) * 1024, name: name.replace(/\.app$/, "") };
  });
  snap.disks = disks(s.df, s.mount, darwin);
  return snap;
}

// --- which machine -----------------------------------------------------------------------

// The focused session's machine (a remote terminal's address is "<machine>/<id>").
function autoMachine() {
  const f = focused(), space = spaces().find((s) => s.active);
  if (f?.terminal?.includes("/")) return f.terminal.split("/")[0];
  return space?.machine ?? null;
}
function picked() { const p = shared(PICK); return p === undefined || p === "auto" ? { auto: true, on: autoMachine() } : { auto: false, on: p }; }
const keyOf = (on) => on ?? "local";

let SCRIPT = null;
async function measure(on) {
  const key = keyOf(on), now = Date.now();
  const busy = shared(BUSY) ?? {};
  if (busy[key] && now - busy[key] < 20000) return;
  const prev = (shared(SNAP) ?? {})[key];
  if (prev && now - prev.at < EVERY - 300) return; // another copy measured just now
  setShared(BUSY, { ...busy, [key]: now });
  try {
    SCRIPT ??= await readTextFile(`${appHome()}/mods/sysmon/collect.sh`);
    const r = await exec("sh", ["-c", SCRIPT], { on });
    const snap = parse(r.stdout), at = Date.now();
    const dt = prev?.snap ? (at - prev.at) / 1000 : 0;
    snap.rate = dt > 0 && prev.snap.net ? { rx: Math.max(0, (snap.net.rx - prev.snap.net.rx) / dt), tx: Math.max(0, (snap.net.tx - prev.snap.net.tx) / dt) } : null;
    const hist = (name, v) => [...(prev?.hist?.[name] ?? []), v ?? 0].slice(-HISTORY);
    const hist2 = { cpu: hist("cpu", snap.cpu), gpu: hist("gpu", snap.gpus?.[0]?.load), rx: hist("rx", snap.rate?.rx), tx: hist("tx", snap.rate?.tx) };
    setShared(SNAP, { ...(shared(SNAP) ?? {}), [key]: { at, snap, hist: hist2, error: null } });
  } catch (e) {
    setShared(SNAP, { ...(shared(SNAP) ?? {}), [key]: { ...(prev ?? {}), at: Date.now(), error: String(e.message ?? e) } });
  } finally {
    setShared(BUSY, { ...(shared(BUSY) ?? {}), [key]: 0 });
  }
}

// --- drawing -----------------------------------------------------------------------------

const GB = 2 ** 30;
function bytes(n) {
  if (n == null || Number.isNaN(n)) return "–";
  const u = ["B", "K", "M", "G", "T", "P"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)}${u[i]}`;
}
const pct = (f) => (f == null ? "–" : `${Math.round(f * 100)}%`);
const deg = (c) => (c == null ? null : `${Math.round(c)}°C`);
function ago(sec) {
  if (!sec) return "";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `up ${d}d ${h}h` : h ? `up ${h}h ${m}m` : `up ${m}m`;
}
// btop's green → yellow → red.
function heat(f, t) { return f >= 0.85 ? t.ansi1 : f >= 0.6 ? t.ansi3 : t.ansi2; }

function bar(f, t, h = 6) {
  const v = Math.max(0, Math.min(1, f ?? 0));
  return div().flex_1().min_w(0).h(h).rounded(h / 2).bg(t.surface).overflow_hidden()
    .child(div().h_full().w(`${(v * 100).toFixed(1)}%`).rounded(h / 2).bg(heat(v, t)));
}

// Columns rising from the bottom, newest on the right.
function spark(values, t, max, h = 34, color) {
  const top = max ?? Math.max(1, ...values);
  const pad = Array(Math.max(0, HISTORY - values.length)).fill(0);
  return h_flex().w_full().h(h).items_end().gap(1).children([...pad, ...values].map((v) => {
    const f = Math.max(0, Math.min(1, v / top));
    return div().flex_1().h(Math.max(1, f * h)).bg(color ?? heat(f, t)).opacity(f > 0 ? 0.9 : 0.25);
  }));
}

export default class Sysmon extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "panel";
    this.seen = 0; this.drawn = Date.now();
    const tick = (cx) => {
      const { on } = picked();
      const show = () => { const s = (shared(SNAP) ?? {})[keyOf(on)]; if (s?.at !== this.seen) { this.seen = s?.at; cx.notify(); } };
      // A hidden panel's timer keeps running (AGENTS.md) but it isn't drawn: it stops measuring
      // and only picks up the bar's snapshots, so showing it again redraws it and resumes.
      if (this.role === "bar" || Date.now() - this.drawn < 3 * EVERY) measure(on).then(show); else show();
    };
    cx.spawn(async (cx) => tick(cx));
    cx.timer.every(this.role === "bar" ? BAR_EVERY : EVERY, tick);
  }

  render() {
    const t = theme(), { auto, on } = picked(), cur = (shared(SNAP) ?? {})[keyOf(on)], s = cur?.snap;
    this.drawn = Date.now();
    if (this.role === "bar") return this.bar(t, on, cur, s);
    const mono = settings().font_family;
    const label = (x) => div().w(44).flex_none().text_size(10.5).text_color(t.muted).child(x);
    const head = (title, right) => h_flex().h(22).px(10).mt(6).gap(6).items_center()
      .child(div().text_size(10.5).font_weight(700).text_color(t.accent).child(title))
      .child(div().flex_1().h(1).bg(t.border))
      .when(Boolean(right), (el) => el.child(div().text_size(10.5).text_color(t.muted).child(right ?? "")));
    const row = (name, f, value, extra) => h_flex().h(18).px(10).gap(8).items_center()
      .child(label(name)).child(bar(f, t)).child(div().w(96).flex_none().whitespace_nowrap().text_size(10.5).text_color(t.foreground).child(value))
      .when(Boolean(extra), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.muted).child(extra ?? "")));
    const chips = [{ id: "auto", name: `Auto${auto ? ` · ${on ?? "this Mac"}` : ""}` }, { id: null, name: "This computer" },
      ...machines().filter((m) => m.name).map((m) => ({ id: m.name, name: m.name, off: m.layout === "unavailable" }))];
    const pick = shared(PICK) ?? "auto";
    const chip = (c) => div().id(`m-${c.id ?? "local"}`).px(8).h(20).flex().items_center().rounded(10).cursor_pointer().text_size(10.5)
      .bg(pick === c.id ? t.selected : t.surface).text_color(c.off ? t.dim : pick === c.id ? t.foreground : t.muted)
      .border_1().border_color(pick === c.id ? t.accent : t.border).hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { setShared(PICK, c.id); this.seen = -1; cx.notify(); }).child(c.name);

    const parts = [];
    if (!s) parts.push(div().p(12).text_size(11.5).text_color(cur?.error ? t.ansi1 : t.dim).child(cur?.error ?? "Measuring…"));
    else {
      const temps = [deg(s.cpuTemp), s.cpuMhz ? `${(s.cpuMhz / 1000).toFixed(2)} GHz` : null, s.power ? `${s.power.toFixed(1)} W` : null].filter(Boolean).join(" · ");
      parts.push(head("CPU", temps),
        h_flex().px(10).gap(10).items_center()
          .child(div().w(52).flex_none().text_size(20).font_weight(600).text_color(heat(s.cpu ?? 0, t)).child(pct(s.cpu)))
          .child(div().flex_1().min_w(0).child(spark(cur.hist?.cpu ?? [], t, 1))),
        div().px(10).pt(4).text_size(10).text_color(t.dim).truncate().child(`${s.cpuName || "CPU"} · ${s.ncpu} cores${s.load ? ` · load ${s.load.map((x) => x.toFixed(2)).join(" ")}` : ""}${s.fan ? ` · fan ${s.fan} rpm` : ""}`));
      if (s.cores?.length) parts.push(h_flex().flex_wrap().px(10).pt(4).gap(4).children(s.cores.map((c, i) =>
        h_flex().w("48%").h(14).gap(5).items_center()
          .child(div().w(18).flex_none().text_size(9.5).text_color(t.dim).child(String(i)))
          .child(bar(c, t, 5)).child(div().w(30).flex_none().text_size(9.5).text_color(t.muted).child(pct(c))))));
      for (const g of s.gpus ?? []) {
        parts.push(head(`GPU${s.gpus.length > 1 ? ` · ${g.name}` : ""}`, [deg(g.temp), g.power ? `${g.power.toFixed(0)} W` : null].filter(Boolean).join(" · ")),
          h_flex().px(10).gap(10).items_center()
            .child(div().w(52).flex_none().text_size(20).font_weight(600).text_color(heat(g.load ?? 0, t)).child(pct(g.load)))
            .child(div().flex_1().min_w(0).child(spark(cur.hist?.gpu ?? [], t, 1, 26))),
          row(g.unified ? "GPU mem" : "VRAM", g.mem[1] ? g.mem[0] / g.mem[1] : 0, `${bytes(g.mem[0])} / ${bytes(g.mem[1])}`, g.unified ? "unified" : null));
      }
      parts.push(head("MEMORY"), row("RAM", s.mem?.[1] ? s.mem[0] / s.mem[1] : 0, `${bytes(s.mem?.[0])} / ${bytes(s.mem?.[1])}`));
      if (s.swap?.[1]) parts.push(row("Swap", s.swap[0] / s.swap[1], `${bytes(s.swap[0])} / ${bytes(s.swap[1])}`));
      parts.push(head("DISKS"), ...s.disks.map((d) => row(d.name.slice(0, 7), d.used / d.total, `${bytes(d.used)} / ${bytes(d.total)}`, d.kind === "net" ? d.type : d.kind === "ext" ? "ext" : null)));
      if (!s.disks.some((d) => d.kind === "net")) parts.push(div().px(10).text_size(10).text_color(t.dim).child("No network drives mounted"));
      parts.push(head("NETWORK", s.rate ? `↓ ${bytes(s.rate.rx)}/s  ↑ ${bytes(s.rate.tx)}/s` : "…"),
        h_flex().px(10).gap(8)
          .child(v_flex().flex_1().min_w(0).child(spark(cur.hist?.rx ?? [], t, null, 22, t.ansi4)).child(div().text_size(9.5).text_color(t.dim).child("download")))
          .child(v_flex().flex_1().min_w(0).child(spark(cur.hist?.tx ?? [], t, null, 22, t.ansi5)).child(div().text_size(9.5).text_color(t.dim).child("upload"))));
      parts.push(head("PROCESSES", "by CPU"),
        h_flex().px(10).h(16).gap(6).text_size(9.5).text_color(t.dim)
          .child(div().flex_1().child("name")).child(div().w(46).child("pid")).child(div().w(40).child("cpu")).child(div().w(46).child("mem")),
        ...s.procs.map((p) => h_flex().px(10).h(18).gap(6).items_center().text_size(10.5)
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(p.name))
          .child(div().w(46).text_color(t.dim).child(p.pid))
          .child(div().w(40).text_color(heat(Math.min(1, p.cpu / 100), t)).child(`${p.cpu.toFixed(0)}%`))
          .child(div().w(46).text_color(t.muted).child(bytes(p.rss)))));
    }
    return v_flex().id("sysmon").size_full().min_h(0).text_color(t.foreground).font_family(mono)
      .child(v_flex().flex_none().px(10).pt(6).gap(5)
        .child(h_flex().flex_wrap().gap(4).children(chips.map(chip)))
        .when(Boolean(s), (el) => el.child(h_flex().gap(6).text_size(10.5).text_color(t.muted)
          .child(div().font_weight(600).text_color(t.foreground).child(s.host)).child(div().child(s.os)).child(div().child(ago(s.uptime)))
          .when(Boolean(cur.error), (el) => el.child(div().text_color(t.ansi1).truncate().child(`stale: ${cur.error}`))))))
      .child(v_flex().id("sysmon-body").flex_1().min_h(0).overflow_y_scrollbar().pb(10).children(parts));
  }

  // One line for the title bar.
  bar(t, on, cur, s) {
    const item = (name, f, text, extra) => h_flex().flex_none().whitespace_nowrap().gap(4).items_center()
      .child(div().text_size(10.5).text_color(t.dim).child(name))
      .when(f != null, (el) => el.child(div().w(28).child(bar(f, t, 4))))
      .child(div().text_size(10.5).text_color(f != null ? heat(f, t) : t.muted).child(text))
      .when(Boolean(extra), (el) => el.child(div().text_size(10).text_color(t.dim).child(extra ?? "")));
    const g = s?.gpus?.[0];
    return h_flex().id("sysmon-bar").size_full().px(8).gap(10).items_center().justify_end().cursor_pointer().overflow_hidden()
      .font_family(settings().font_family).hover((st) => st.bg(t.hover)).tooltip(`${s?.host ?? on ?? "This computer"}: open Utilization`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => setShared("vsections.open", { id: "utilization", toggle: false, at: Date.now() }))
      .when(!s, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(cur?.error ? "sysmon: unreachable" : "sysmon…")))
      .when(Boolean(s), (el) => el
        .when(Boolean(on), (el) => el.child(div().text_size(10.5).text_color(t.accent).child(on)))
        .child(item("CPU", s.cpu, pct(s.cpu), deg(s.cpuTemp)))
        .when(Boolean(g), (el) => el.child(item("GPU", g.load, pct(g.load), deg(g.temp))))
        .child(item("MEM", s.mem?.[1] ? s.mem[0] / s.mem[1] : null, `${(s.mem[0] / GB).toFixed(1)}/${(s.mem[1] / GB).toFixed(0)}G`))
        .when(Boolean(s.rate), (el) => el.child(item("NET", null, `↓${bytes(s.rate.rx)} ↑${bytes(s.rate.tx)}`))));
  }
}
