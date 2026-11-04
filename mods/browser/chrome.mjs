// browser's launcher: one real Chromium window (the Electron app in ./shell) per Herdr
// tab, i.e. per Claude Code session, so the tab's browser pane and that session's
// `browser` MCP use the same browser and two sessions never share one. Node built-ins
// only; run as `node chrome.mjs <command> ...`.
//
// A session is a Herdr tab id. Its browser keeps its profile in
// ~/.local/state/herdr-browser/<tab> (cookies and logins survive restarts). Chromium picks
// its DevTools port (--remote-debugging-port=0) and writes it to DevToolsActivePort there;
// the shell writes the port of its own control server (the pane talks to it) to
// shell.port. No registry: whichever of pane or MCP comes first starts it.
//
//   ensure <s> [url]         start the session's browser if needed (opening url): {port, shell}
//                            A canvas session is "<tab>.cv-<artifact id>" (one per open canvas).
//   port-for-terminal <t>    DevTools port for herdr terminal t's tab (plain text), for mcp.sh
//   stop <s>                 quit that browser and drop its profile
//   gc                       stop every session whose Herdr tab is gone
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SHELL = join(dirname(fileURLToPath(import.meta.url)), "shell");
const ELECTRON_APP = join(SHELL, "node_modules/electron/dist/Electron.app");
const ROOT = join(homedir(), ".local/state/herdr-browser");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Remote tab ids look like "machine/tb…": keep them one path segment.
const dirOf = (session) => join(ROOT, String(session || "default").replace(/[^A-Za-z0-9_.-]/g, "_"));

const get = async (url, method = "GET") => {
  const text = await (await fetch(url, { method, signal: AbortSignal.timeout(3000) })).text();
  try { return JSON.parse(text); } catch { return text; }
};
const read = (file) => { try { return readFileSync(file, "utf8"); } catch { return null; } };

// The running browser's ports, or null. DevToolsActivePort survives a crash, so the
// browser id on its second line must match what answers on that port. shell: null while
// Chromium is up but the shell hasn't written shell.port (starting, or its server failed).
async function alive(dir) {
  const [port, path] = (read(join(dir, "DevToolsActivePort")) ?? "").split("\n");
  const shell = read(join(dir, "shell.port"));
  // A canvas browser has no DevTools port: its own server says it's up.
  if (!port) {
    try { if (shell && (await get(`http://127.0.0.1:${shell}/`)).session) return { port: null, shell: Number(shell) }; } catch {}
    return null;
  }
  try {
    const v = await get(`http://127.0.0.1:${port}/json/version`);
    if (!v.webSocketDebuggerUrl?.endsWith(path)) return null;
  } catch { return null; }
  return { port: Number(port), shell: shell ? Number(shell) : null };
}

// Closes whatever answers on the profile's DevTools port (through the shell, or DevTools without it).
async function closeBrowser(dir, ports) {
  try { appendFileSync(join(dir, "shell.log"), `${new Date().toISOString()} chrome.mjs closing it (pid ${process.pid}, ppid ${process.ppid}, ${process.argv.slice(2).join(" ")})\n`); } catch {}
  if (ports.shell) await get(`http://127.0.0.1:${ports.shell}/quit`, "POST").catch(() => {});
  else {
    const v = await get(`http://127.0.0.1:${ports.port}/json/version`);
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((ok) => { ws.onopen = ok; ws.onerror = ok; });
    try { ws.send(JSON.stringify({ id: 1, method: "Browser.close" })); } catch {}
  }
  for (let i = 0; i < 60 && (await alive(dir)); i++) await sleep(50);
}

// ponytail: mkdir lock, stale after 20 s; enough for "pane and MCP start at once".
async function locked(dir, fn) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock");
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 20000) rmdirSync(lock); } catch {}
      if (i > 400) throw new Error("another start of this browser is stuck");
      await sleep(50);
    }
  }
  try { return await fn(); } finally { try { rmdirSync(lock); } catch {} }
}

// A browser keeps running the shell code it started with (across Herdr restarts too), so one
// started before shell/*.cjs last changed is restarted here. shell.port is written at start.
function stale(dir) {
  try {
    const born = statSync(join(dir, "shell.port")).mtimeMs;
    return readdirSync(SHELL).some((f) => f.endsWith(".cjs") && statSync(join(SHELL, f)).mtimeMs > born);
  } catch { return false; }
}

export async function ensure(session, url) {
  const dir = dirOf(session);
  const now = await alive(dir);
  if (now?.shell && !stale(dir)) return now;
  return locked(dir, async () => {
    const again = await alive(dir);
    if (again?.shell && !stale(dir)) return again;
    if (again) await closeBrowser(dir, again);
    const keep = again?.port; // a restart reuses the DevTools port the session's MCP is pinned to
    for (const f of ["DevToolsActivePort", "shell.port"]) rmSync(join(dir, f), { force: true });
    // Through LaunchServices with -g: started directly, macOS makes the new app the active one,
    // which takes the keyboard from Herdr (and hides the browser, which shows only while Herdr
    // or itself is active).
    spawn("open", ["-n", "-g", "-a", ELECTRON_APP, "--args", SHELL, `--session=${session || "default"}`, `--dir=${dir}`, ...(keep ? [`--devtools-port=${keep}`] : []), ...(url ? [`--url=${url}`] : [])], { stdio: "ignore", detached: true }).unref();
    for (let i = 0; i < 300; i++) {
      await sleep(50);
      const p = await alive(dir);
      if (p?.shell) { await gc().catch(() => {}); return p; }
    }
    throw new Error("the browser did not start");
  });
}

// Herdr tab of a herdr terminal (its herdr.tab label), else "default" (Claude outside Herdr).
function sessionOfTerminal(terminal) {
  if (!terminal) return "default";
  try {
    const t = JSON.parse(execFileSync("hc", ["get", terminal, "--json"], { encoding: "utf8", timeout: 5000 }));
    return t.labels?.["herdr.tab"] ?? "default";
  } catch { return "default"; }
}

// The browser processes using this profile (the shell is started with --dir=<dir>).
const pidsOf = (dir) => {
  try { return execFileSync("pgrep", ["-f", `dir=${dir}`], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number); } catch { return []; }
};

export async function stop(session) {
  const dir = dirOf(session);
  const ports = await alive(dir);
  if (ports) await closeBrowser(dir, ports);
  // Its profile goes only after it has exited: removed under a quitting Chromium, it hangs.
  for (let i = 0; i < 100 && pidsOf(dir).length; i++) await sleep(50);
  for (const pid of pidsOf(dir)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  return { ok: true };
}

// Herdr's live tab ids; null when the app can't be asked (then nothing is collected).
function liveTabs() {
  for (const bin of [join(homedir(), ".local/bin/herdr-app"), "herdr-app"]) {
    try {
      const ls = JSON.parse(execFileSync(bin, ["ls"], { encoding: "utf8", timeout: 5000 }));
      const ids = new Set(ls.spaces.flatMap((s) => s.tabs.map((t) => t.id)));
      // No tabs at all: Herdr is starting or its layout isn't loaded, not every tab closed.
      return ids.size ? ids : null;
    } catch {}
  }
  return null;
}

export async function gc() {
  const live = liveTabs();
  if (!live || !existsSync(ROOT)) return { ok: true, stopped: [] };
  const stopped = [];
  for (const name of readdirSync(ROOT)) {
    // A canvas profile ("<tab>.cv-<id>") goes with its tab.
    if (!name.startsWith("tb") || live.has(name.replace(/\.cv-.*$/, ""))) continue;
    await stop(name).catch(() => {});
    stopped.push(name);
  }
  return { ok: true, stopped };
}

const COMMANDS = {
  ensure: async ([s, url]) => ({ ok: true, ...(await ensure(s, url)) }),
  "port-for-terminal": async ([t]) => { process.stdout.write(`${(await ensure(sessionOfTerminal(t))).port}\n`); return null; },
  stop: ([s]) => stop(s),
  gc,
};

if (process.argv[1]?.endsWith("chrome.mjs")) {
  const [command, ...args] = process.argv.slice(2);
  const timer = setTimeout(() => { console.log(JSON.stringify({ ok: false, error: "took longer than 25 s" })); process.exit(1); }, 25000);
  timer.unref();
  try {
    const run = COMMANDS[command];
    if (!run) throw new Error(`unknown command: ${command}`);
    const r = await run(args);
    if (r) console.log(JSON.stringify(r));
    process.exit(0);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
    process.exit(1);
  }
}
