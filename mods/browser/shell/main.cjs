// The browser itself: a real Chromium (Electron) window per Herdr tab, i.e. per Claude
// Code session, kept exactly over that tab's browser pane. Herdr can't embed a web view,
// so this frameless window floats over the pane instead, and Chromium does input,
// selection, drag and clipboard natively. Claude's `browser` MCP (../mcp.sh) drives the
// same window through --remote-debugging-port, so you watch what Claude does.
//
// Started by ../chrome.mjs as `Electron . --session=<tab> --dir=<profile>`. The pane
// (../main.js) POSTs /place about 20 times a second while it exists: whether it's on
// screen, whether Herdr is the active app, Herdr's window frame and the pane's size.
// Where the pane sits inside Herdr's window comes from marker.cjs (a mod can't ask).
// Visible only while the pane is shown and Herdr or this window is the active app, and
// only then floating above other windows; hidden when the pane stops reporting.
const { app, BrowserWindow, WebContentsView, ipcMain, Menu, session, safeStorage, shell } = require("electron");
const { execFile } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const SESSION = arg("session") ?? "default";
// A canvas browser (session "<tab>.cv-<artifact id>", one per open claude.ai canvas, see
// ../../tabs-vs) opens at --url and leaves with its tab, like the tab's own browser.
const OWNER = SESSION.replace(/\.cv-[^/]*$/, ""), CANVAS = OWNER !== SESSION;
const DIR = arg("dir") ?? path.join(os.homedir(), ".local/state/herdr-browser/default");
const HOME = "https://www.google.com/";
// The tab strip and address bar, drawn by ui.html. A canvas shows only its page (kiosk-style).
const BAR = CANVAS ? 0 : 72;
const HERDR_APP = path.join(os.homedir(), ".local/bin/herdr-app");

app.setPath("userData", DIR);
// Not for a canvas: Cloudflare's Turnstile on claude.ai refused to verify a browser with a
// DevTools port (2026-11-03). Claude sees a canvas through GET /shot and /text instead.
// --devtools-port: a restart keeps its old port, so Claude's browser MCP (pinned to it) still connects.
if (!CANVAS) app.commandLine.appendSwitch("remote-debugging-port", arg("devtools-port") ?? "0");
// Sites treat an "Electron" user agent as a bot or an old browser.
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|herdr-browser-shell)\/\S+/g, "");
if (!app.requestSingleInstanceLock()) app.exit(0);
// Why this browser left, for when it does so unexpectedly.
const log = (msg) => fs.appendFile(path.join(DIR, "shell.log"), `${new Date().toISOString()} ${msg}\n`, () => {});
log(`start pid ${process.pid}`);
// Logged, not shown: without a handler Electron puts an error dialog in front of the user.
process.on("uncaughtException", (e) => log(`uncaught: ${e?.stack ?? e}`));

let win, tabs = [], active = null, nextId = 1;

// ---- tabs ----------------------------------------------------------------------------

const { toUrl } = require("./url.cjs");

function layoutViews() {
  const [w, h] = win.getContentSize();
  for (const t of tabs) t.view.setBounds({ x: 0, y: BAR, width: w, height: Math.max(0, h - BAR) });
}

function sendState() {
  const t = tabs.find((x) => x.id === active), wc = t?.view.webContents;
  win?.webContents.send("state", {
    active,
    tabs: tabs.map((x) => ({ id: x.id, title: x.view.webContents.getTitle(), url: x.view.webContents.getURL(), loading: x.view.webContents.isLoading() })),
    url: wc?.getURL() ?? "", canBack: wc?.navigationHistory.canGoBack() ?? false, canForward: wc?.navigationHistory.canGoForward() ?? false,
  });
}

function addTab(url = HOME) {
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
  const t = { id: nextId++, view };
  tabs.push(t);
  win.contentView.addChildView(view);
  const wc = view.webContents;
  // Links that open a window (target=_blank, window.open) become tabs here.
  // A canvas has no tab strip to come back from a new tab: those open in the system browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (CANVAS) shell.openExternal(url);
    else activate(addTab(url).id);
    return { action: "deny" };
  });
  for (const e of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-start-loading", "did-stop-loading"]) wc.on(e, sendState);
  wc.loadURL(url);
  layoutViews();
  activate(t.id);
  return t;
}

function activate(id) {
  if (!tabs.some((t) => t.id === id)) return;
  active = id;
  for (const t of tabs) t.view.setVisible(t.id === id);
  if (win.isFocused()) tabs.find((t) => t.id === id).view.webContents.focus();
  sendState();
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  if (!tabs.length) addTab();
  else if (active === id) activate(tabs[Math.min(i, tabs.length - 1)].id);
  else sendState();
}

const current = () => { const wc = tabs.find((t) => t.id === active)?.view.webContents; return wc && !wc.isDestroyed() ? wc : null; };
const COMMANDS = {
  nav: (text) => current()?.loadURL(toUrl(text)),
  back: () => current()?.navigationHistory.goBack(),
  forward: () => current()?.navigationHistory.goForward(),
  reload: () => current()?.reload(),
  newTab: () => addTab(),
  closeTab: (id) => closeTab(id ?? active),
  activate: (id) => activate(id),
};
ipcMain.on("cmd", (_e, name, ...args) => COMMANDS[name]?.(...args));

// ---- following the pane ----------------------------------------------------------------

let pane = { visible: false }, offset = null, measuredFor = "", beat = 0, focused = false, hideTimer = null, measuring = false;
let retryAt = 0; // after a search that found no markers, the next waits a little
// A second search a second after each one: the frame a search used can still show the pane where it
// was before a layout change that moved it without resizing it (seen 2026-11-03: a canvas window
// sat ~165 px below its block).
let recheckAt = 0;
const GRIP = 4;

// Herdr's last frame, searched for the pane's markers; retried while the frame catches up.
async function measure(recheck = false) {
  if (measuring) return;
  measuring = true;
  const shot = path.join(os.tmpdir(), `herdr-browser-${process.pid}.png`);
  try {
    for (let i = 0; i < 10 && pane.visible; i++) {
      const want = pane.size, frame = pane.win;
      await new Promise((ok) => execFile(HERDR_APP, ["shot", shot], { timeout: 5000 }, () => ok()));
      // Searched in a child process (this binary as Node): decoding a Retina-sized frame here
      // would block this process, and its control server, for a noticeable moment.
      const m = await new Promise((ok) => execFile(process.execPath, [path.join(__dirname, "marker.cjs"), shot, ...(pane.marker ? [pane.marker.join(",")] : [])],
        { timeout: 5000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
        (err, out) => { try { ok(err ? null : JSON.parse(out)); } catch { ok(null); } }));
      const scale = m ? m.shotWidth / frame.width : 1;
      // The markers sit `inset` points in from the pane's corners (see ../main.js).
      const inset = pane.inset ?? 0;
      const box = m && { x: m.x / scale - inset, y: m.y / scale - inset, width: m.width / scale + 2 * inset, height: m.height / scale + 2 * inset };
      if (box && Math.abs(box.width - want.width) <= 2 && Math.abs(box.height - want.height) <= 2) {
        offset = box;
        measuredFor = key(pane);
        recheckAt = recheck ? 0 : Date.now() + 1000;
        break;
      }
      if (i === 9) { retryAt = Date.now() + 5000; log("pane markers not found; next search in 5 s"); }
      await new Promise((r) => setTimeout(r, 80));
    }
  } finally {
    fs.rm(shot, { force: true }, () => {});
    measuring = false;
    apply();
  }
}

// What moves the pane inside Herdr's window: its own size or Herdr's window size.
const key = (p) => `${p.size?.width}x${p.size?.height}/${p.win?.width}x${p.win?.height}`;

// "Hidden" is fully transparent and click-through, never win.hide(): macOS quits a background
// app ~1.7 s after its last window is hidden (tested; a separate 1 pt window didn't reliably
// prevent it), and a window that stays ordered in, even at opacity 0, keeps it running.
let wasWanted = false, onScreen = false;
let shownOnce = false;
function setShown(on) {
  // A browser started by Claude's MCP opens on a blank page; Google comes with the first show.
  if (on && !shownOnce) { shownOnce = true; if (tabs.length === 1 && current()?.getURL() === "about:blank") current().loadURL(HOME); }
  // Into the Space being looked at (Herdr's: it shows only while Herdr is active), and only
  // that one: joining all Spaces for a moment moves it here, leaving makes it stay. Always
  // with visibleOnFullScreen (Herdr may be fullscreen); false there would bring the Dock icon.
  if (on && !onScreen) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    setTimeout(() => win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true }), 100);
  }
  onScreen = on;
  win.setIgnoreMouseEvents(!on);
  win.setOpacity(on ? 1 : 0);
  if (on) win.setAlwaysOnTop(true, "floating"); else win.setAlwaysOnTop(false);
}

function apply() {
  const live = Date.now() - beat < 2500;
  const wanted = pane.visible && live;
  // Coming back on screen: the layout may have changed meanwhile, so measure before showing.
  // While shown, a size change keeps the edge that didn't move until measured: a pane flush with
  // Herdr's right edge (the tools panel) grows and shrinks leftward, any other rightward. Keeping
  // the left edge always made the tools panel's canvas jump back while its divider was dragged.
  if (wanted && !wasWanted) { offset = null; measuredFor = ""; }
  wasWanted = wanted;
  if (wanted && measuredFor !== key(pane) && Date.now() >= retryAt) {
    if (offset) {
      const right = Math.abs(offset.x + offset.width - pane.win.width) <= 2;
      offset = { ...offset, x: right ? offset.x + offset.width - pane.size.width : offset.x, width: pane.size.width, height: pane.size.height };
    }
    measure();
  } else if (wanted && recheckAt && Date.now() >= recheckAt) { recheckAt = 0; measure(true); }
  const show = wanted && offset && (pane.active || focused);
  if (show) {
    clearTimeout(hideTimer); hideTimer = null;
    // GRIP points of the pane left uncovered on the left, so the divider there can still be grabbed.
    win.setBounds({ x: Math.round(pane.win.x + offset.x + GRIP), y: Math.round(pane.win.y + offset.y), width: Math.round(offset.width - GRIP), height: Math.round(offset.height) });
    if (!onScreen) setShown(true);
  } else if (onScreen && !hideTimer) {
    // Clicking between Herdr and this window makes both look inactive for a moment.
    const now = !wanted || !offset;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (pane.visible && Date.now() - beat < 2500 && offset && (pane.active || focused)) return apply();
      setShown(false);
      // Hidden because its pane went away while it had the keyboard: hand it back to Herdr.
      if (focused && !pane.visible) execFile("open", ["-b", "dev.herdr.app"], () => {});
    }, now ? 0 : 300);
  }
}

function serve() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reply = (o) => { if (!res.headersSent) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); } };
      // Never throws: a request arriving while the browser quits (its window gone) once did.
      try { handle(reply); } catch (e) { reply({ ok: false, error: String(e) }); }
    });
    const handle = (reply) => {
      // Only Herdr's pane (and chrome.mjs) talk to this: a web page's request carries an Origin.
      if (req.headers.origin) { res.writeHead(403); return res.end(); }
      if (!win || win.isDestroyed()) return reply({ ok: false, error: "closing" });
      if (req.url === "/place") {
        try {
          const p = JSON.parse(body || "{}");
          beat = Date.now();
          if (p.colors && JSON.stringify(p.colors) !== JSON.stringify(pane.colors)) win.webContents.send("colors", p.colors);
          if (p.visible !== pane.visible || p.active !== pane.active) log(`place visible=${p.visible} active=${p.active}`);
          pane = p;
          apply();
          reply({ ok: true });
        } catch (e) { reply({ ok: false, error: String(e) }); }
      } else if ((req.url.startsWith("/shot") || req.url === "/text") && !current()) {
        reply({ ok: false, error: "no page" });
      } else if (req.url.startsWith("/shot")) {
        // The page as a PNG (?out=<path>: written there instead), for Claude: a canvas has no DevTools.
        const out = new URL(req.url, "http://x").searchParams.get("out");
        current().capturePage().then((img) => {
          const png = img.toPNG();
          if (!out) { res.writeHead(200, { "content-type": "image/png" }); return res.end(png); }
          fs.writeFile(out, png, (e) => reply(e ? { ok: false, error: String(e) } : { ok: true, out }));
        }, (e) => reply({ ok: false, error: String(e) }));
      } else if (req.url === "/text") {
        current().executeJavaScript("({ title: document.title, url: location.href, text: document.body?.innerText ?? '' })")
          .then((page) => reply({ ok: true, ...page }), (e) => reply({ ok: false, error: String(e) }));
      } else if (req.url === "/quit") { log("quit: asked (/quit)"); reply({ ok: true }); setTimeout(() => app.quit(), 20); }
      else reply({ ok: true, session: SESSION, shown: onScreen, bounds: win.getBounds(), offset, focused, pane, beatAgo: Date.now() - beat });
    };
  });
  server.listen(0, "127.0.0.1", () => fs.writeFileSync(path.join(DIR, "shell.port"), String(server.address().port)));
}

// Leave when this Herdr tab is gone: missing from two checks 30 s apart (nothing is
// decided when Herdr can't be asked).
function watchTab() {
  if (SESSION === "default") return;
  let missing = 0;
  setInterval(() => execFile(HERDR_APP, ["ls"], { timeout: 5000, maxBuffer: 32 << 20 }, (err, out) => {
    if (err) return;
    try {
      const live = JSON.parse(out).spaces.some((s) => s.tabs.some((t) => t.id === OWNER));
      missing = live ? 0 : missing + 1;
      if (missing >= 2) { log("quit: Herdr tab is gone"); app.quit(); }
    } catch {}
  }), 30000);
}

function menu() {
  // click() gets (menuItem, ...): only commands that take no argument go in directly.
  const tabCmd = (label, accelerator, fn) => ({ label, accelerator, click: fn });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Browser", submenu: [
      tabCmd("New Tab", "CmdOrCtrl+T", COMMANDS.newTab),
      tabCmd("Close Tab", "CmdOrCtrl+W", () => closeTab(active)),
      tabCmd("Open Location", "CmdOrCtrl+L", () => { win.webContents.focus(); win.webContents.send("focus-url"); }),
      tabCmd("Reload", "CmdOrCtrl+R", COMMANDS.reload),
      tabCmd("Back", "CmdOrCtrl+[", COMMANDS.back),
      tabCmd("Forward", "CmdOrCtrl+]", COMMANDS.forward),
    ] },
    { role: "editMenu" },
  ]));
}

// Canvases are private claude.ai pages, and each canvas browser has its own profile, so they share
// one claude.ai login: its cookies, encrypted with the keychain (safeStorage), in LOGIN_JAR, loaded
// before the canvas and saved whenever they change. Only canvas browsers: the tab browsers are
// driven by Claude's `browser` MCP and never get the login.
const LOGIN_JAR = path.join(os.homedir(), ".local/state/herdr-browser/claude-login.bin");
// Not Cloudflare's cookies: another browser's clearance made claude.ai answer with an endless
// "Performing security verification" (tested 2026-11-03); each browser earns its own.
const isLogin = (c) => /(^|\.)(claude\.ai|claudeusercontent\.com)$/.test(c.domain.replace(/^\./, "")) && !/^(__cf|cf_|_cfuvid)/.test(c.name);
let saveLoginTimer = null;
const setCookies = async (list) => {
  for (const c of list.filter(isLogin)) {
    const { hostOnly, session: _s, domain, ...rest } = c;
    await session.defaultSession.cookies.set({ ...rest, url: `https://${domain.replace(/^\./, "")}${c.path}`, ...(hostOnly ? {} : { domain }) }).catch(() => {});
  }
};

// The Claude desktop app's claude.ai login (asked 2026-11-03: "I am already logged in"), read from
// its Chromium cookie store: values are AES-128-CBC under a key from its keychain item "Claude Safe
// Storage" (macOS asks the person once to allow that read). [] when the app or the keychain says
// no: the canvas then shows claude.ai's sign-in. Values are never logged.
const run = (cmd, args) => new Promise((ok) => execFile(cmd, args, { timeout: 60000, maxBuffer: 16 << 20 }, (err, out) => ok(err ? null : out)));
async function desktopLogin() {
  const db = `file:${path.join(os.homedir(), "Library/Application Support/Claude/Cookies")}?immutable=1`;
  const rows = JSON.parse((await run("sqlite3", ["-readonly", "-json", db,
    "select host_key, name, path, is_secure, is_httponly, expires_utc, samesite, hex(encrypted_value) as v from cookies where host_key like '%claude.ai'"])) || "[]");
  const version = Number(await run("sqlite3", ["-readonly", db, "select value from meta where key='version'"]));
  const password = rows.length && (await run("security", ["find-generic-password", "-w", "-s", "Claude Safe Storage", "-a", "Claude"]))?.trim();
  if (!password) return [];
  const key = require("node:crypto").pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const SAME_SITE = { 0: "no_restriction", 1: "lax", 2: "strict" };
  return rows.flatMap((r) => {
    try {
      const enc = Buffer.from(r.v, "hex");
      if (enc.subarray(0, 3).toString() !== "v10") return [];
      const d = require("node:crypto").createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
      let value = Buffer.concat([d.update(enc.subarray(3)), d.final()]);
      if (version >= 24) value = value.subarray(32); // a SHA-256 of the host comes first
      const expires = r.expires_utc ? r.expires_utc / 1e6 - 11644473600 : undefined; // µs since 1601
      return [{ name: r.name, value: value.toString("utf8"), domain: r.host_key, hostOnly: !r.host_key.startsWith("."), path: r.path,
        secure: Boolean(r.is_secure), httpOnly: Boolean(r.is_httponly), ...(expires ? { expirationDate: expires } : {}),
        ...(SAME_SITE[r.samesite] ? { sameSite: SAME_SITE[r.samesite] } : {}) }];
    } catch { return []; }
  });
}
const signedIn = async () => (await session.defaultSession.cookies.get({ name: "sessionKey" }))
  .some((c) => /(^|\.)claude\.ai$/.test(c.domain) && (!c.expirationDate || c.expirationDate * 1000 > Date.now()));
async function importDesktopLogin() {
  const list = await desktopLogin();
  await setCookies(list);
  log(`desktop login: ${list.length ? `${list.filter(isLogin).length} cookies` : "none"}`);
}

async function shareLogin() {
  const jar = session.defaultSession.cookies;
  try { await setCookies(JSON.parse(safeStorage.decryptString(fs.readFileSync(LOGIN_JAR)))); }
  catch {} // no jar yet, or the keychain said no
  jar.on("changed", (_e, c) => {
    if (!isLogin(c)) return;
    clearTimeout(saveLoginTimer);
    saveLoginTimer = setTimeout(async () => {
      const mine = (await jar.get({})).filter(isLogin);
      try { fs.writeFileSync(LOGIN_JAR, safeStorage.encryptString(JSON.stringify(mine)), { mode: 0o600 }); } catch (e) { log(`login not saved: ${e}`); }
    }, 1000);
  });
  // Saved by the listener above, so later canvases start signed in from the jar.
  if (!(await signedIn())) await importDesktopLogin();
}

app.whenReady().then(async () => {
  app.dock?.hide();
  // Sites get no permissions (camera, microphone, location, notifications, clipboard read,
  // local network...): this browser is for looking and for Claude, and every tab uses this
  // default session.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  win = new BrowserWindow({
    show: false, frame: false, hasShadow: false, roundedCorners: true, skipTaskbar: true,
    fullscreenable: false, minimizable: false, maximizable: false, backgroundColor: "#1e1e1e",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, "ui.html"));
  // Allowed beside fullscreen windows: with Herdr in macOS fullscreen (its own Space) a plain
  // window stays on the desktop Space and never shows over the pane (2026-11-03). Not on all
  // Spaces: it showed over other desktops. setShown moves it to Herdr's Space.
  win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true });
  // Ordered in from the start, invisible until its pane shows (see setShown).
  setShown(false);
  win.showInactive();
  win.webContents.on("did-finish-load", () => { sendState(); if (pane.colors) win.webContents.send("colors", pane.colors); });
  win.on("resize", layoutViews);
  // No focus() here: the click that focused the window already put the keyboard where it
  // landed (the address box or the page).
  win.on("focus", () => { focused = true; log("focus"); apply(); });
  win.on("blur", () => { focused = false; apply(); });
  menu();
  // Up before the login: its keychain read can wait on the person's Allow, longer than chrome.mjs
  // waits for a start.
  serve();
  if (CANVAS) await shareLogin();
  addTab(arg("url") ?? "about:blank");
  // The jar's login can be stale (signed out elsewhere): on claude.ai's sign-in page, take the
  // desktop app's once more and load the canvas again.
  let retried = false;
  if (CANVAS) current().on("page-title-updated", async (_e, title) => {
    const wc = current();
    if (retried || !wc || !/^Sign in/.test(title) && !/^https:\/\/claude\.ai\/login/.test(wc.getURL())) return;
    retried = true;
    await importDesktopLogin();
    wc.loadURL(arg("url"));
  });
  watchTab();
  setInterval(apply, 1000);
});
app.on("window-all-closed", () => { log("quit: windows closed"); app.quit(); });
app.on("before-quit", () => log("before-quit"));
app.on("second-instance", (_e, argv) => log(`second instance: ${argv.join(" ")}`));
app.on("will-quit", () => log("will-quit"));
