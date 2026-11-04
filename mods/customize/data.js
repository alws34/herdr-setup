// Customize's data and actions: what Claude Code has installed and what its marketplaces offer.
// Everything comes from Claude Code itself (its CLI and the caches it keeps under
// ~/.claude/plugins), so this page and /plugin, /mcp, /skills always agree. Nothing is made up:
// an install count, a description or an author shows only when one of these sources has it.
//
// The CLI helpers (claude, inTab, openInEditor, parseMcp, the skillOverrides cycle) are copies
// of mods/extensions/main.js's: herdr-app refuses a module outside the mod's own folder ("../"
// and symlinks both, tried 2026-11-01), so mods can't share code. Skill and agent frontmatter
// is read by the extensions mod's own scan.sh, run in place rather than copied.
import { exec, home, appHome, readTextFile, writeTextFile, spaces, panes, focused, run, setShared, notify } from "herdr";
import * as fs from "fs/promises";

const PLUGINS = () => `${home()}/.claude/plugins`;
export const SETTINGS = () => `${home()}/.claude/settings.json`;
const CACHE = () => `${appHome()}/data/customize`;
export const DIRECTORY = "anthropic-plugin-directory";
export const OFFICIAL = "claude-plugins-official";

// Long CLI calls go through herdr-core, whose limit can be raised past exec's 30 s.
export const claude = (args, timeout = 30) => exec("hc", ["exec", "--timeout", String(timeout), "--", "claude", ...args]);

// fs, not readTextFile: the directory cache is ~3 MB and readTextFile came back empty on it.
const readJson = async (path) => { try { return JSON.parse(await fs.readFile(path, "utf8")); } catch { return null; } };

export function openInEditor(path) {
  const space = spaces().find((s) => s.active), tab = space?.tabs.find((x) => x.active);
  if (!tab) return;
  setShared("editor.open", { path, on: null, tab: tab.id, at: Date.now() });
  const tabPanes = panes().filter((p) => p.tab === tab.id);
  if (tabPanes.some((p) => p.mod === "editor")) return;
  const from = tabPanes.find((p) => p.pane === focused()?.pane && p.terminal) ?? tabPanes.find((p) => p.terminal) ?? tabPanes[0];
  run("pane.split", { direction: "right", ...(from ? { pane: from.pane } : {}), mod: "editor", props: { tab: tab.id } });
}

// A tab in the shown space running a command (sign-ins need a browser round trip).
export function inTab(argv, name) {
  const space = spaces().find((s) => s.active);
  run("tab.new", { ...(space ? { space: space.id } : {}), name, argv });
}

// "name: target - ✔ Connected" lines; the name may hold colons, the target " - ". Unlike the
// extensions copy this also keeps "- Not configured" lines (plugin servers missing a URL).
export function parseMcp(out) {
  return out.split("\n").map((l) => l.trim().match(/^(.*?): (.*?) - [✔✘!⏸-] (.*)$/)).filter(Boolean).map(([, name, rawTarget, status]) => {
    const target = rawTarget.trim().replace(/\s*\((HTTP|SSE|stdio)\)$/, "");
    const kind = name.startsWith("claude.ai ") ? "claude.ai" : name.startsWith("plugin:") ? "plugin" : "local";
    const label = kind === "claude.ai" ? name.slice(10) : kind === "plugin" ? name.split(":").slice(2).join(":") : name;
    return { name, label, plugin: kind === "plugin" ? name.split(":")[1] : null, target, status, kind,
      ok: /connected/i.test(status) && !/failed/i.test(status), auth: /auth/i.test(status) && !/failed/i.test(status) };
  });
}

// `claude plugin list --json --available`: installed plugins, and every marketplace's catalog
// (the built-in Anthropic Directory included) with `installCount` where the marketplace has one.
// `available` leaves out what's installed, so each installed plugin also gets the description
// from its own .claude-plugin/plugin.json.
export async function loadPlugins() {
  const r = await claude(["plugin", "list", "--json", "--available"], 60);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "claude plugin list failed");
  const d = JSON.parse(r.stdout), installed = d.installed ?? [];
  for (const p of installed) if (p.installPath) p.desc = (await readJson(`${p.installPath}/.claude-plugin/plugin.json`))?.description ?? null;
  return { installed, available: d.available ?? [] };
}

// Claude Code's own caches of the two Anthropic catalogs. The official marketplace's has each
// plugin's skills, MCP servers, author and last update; the directory's has display names,
// publishers and who reviewed each listing. Either may be missing; the page then shows less.
export async function loadCatalogs() {
  const cat = (await readJson(`${PLUGINS()}/plugin-catalog-cache.json`))?.catalog?.plugins ?? {};
  const official = {};
  for (const [id, p] of Object.entries(cat)) {
    const e = p.marketplace_entry ?? {};
    official[id] = { desc: e.description ?? null, installs: p.unique_installs ?? null, updated: p.last_updated ?? null, author: e.author?.name ?? null,
      skills: (p.components?.skills ?? []).map((s) => s.name), mcp: p.components?.mcpServers ?? [] };
  }
  const dir = await readJson(`${PLUGINS()}/plugin-directory-cache-v2.json`);
  const directory = {};
  (dir?.listings ?? []).forEach((l, order) => {
    const entry = dir.entryNames?.[l.id];
    if (!entry) return;
    const repo = l.source?.repository?.url?.match(/github\.com\/([^/]+)/)?.[1];
    directory[`${entry}@${DIRECTORY}`] = { title: l.name, summary: l.summary, order,
      by: l.publisher?.name ?? (repo === "anthropics" ? "Anthropic" : repo) ?? null, fromAnthropic: repo === "anthropics", review: l.checks?.review?.state === "done" ? l.checks.review.by?.type ?? null : null };
  });
  return { official, directory };
}

// Plugin folders the marketplaces have on disk (plugins whose source is a path inside the
// marketplace's clone), as scan.sh pairs: "<name>@<marketplace>" <folder>.
export async function marketplaceFolders() {
  const root = `${PLUGINS()}/marketplaces`, pairs = [];
  let names = [];
  try { names = await fs.readdir(root); } catch { return pairs; }
  for (const m of names) {
    const mk = await readJson(`${root}/${m}/.claude-plugin/marketplace.json`);
    for (const p of mk?.plugins ?? []) {
      if (typeof p.source === "string" && p.source.startsWith("./")) pairs.push(`${p.name}@${mk.name ?? m}`, `${root}/${m}/${p.source.slice(2)}`.replace(/\/$/, ""));
    }
  }
  return pairs;
}

// Skills (and agents) from ~/.claude and the given "<source>" <folder> pairs, through the
// extensions mod's scan.sh: kind, source, name, description, path, on.
export async function scanSkills(pairs) {
  const r = await exec("sh", [`${appHome()}/mods/extensions/scan.sh`, `${home()}/.claude/agents.disabled`, ...pairs]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "extensions/scan.sh failed");
  return r.stdout.split("\n").filter(Boolean).map((l) => {
    const [kind, source, name, desc, path] = l.split("\t");
    return { kind, source, name, desc: (desc ?? "").replace(/^["']|["']$/g, ""), path };
  }).filter((i) => i.kind === "skill");
}

export async function readOverrides() {
  return (await readJson(SETTINGS()))?.skillOverrides ?? {};
}

// skillOverrides: on (no entry) → name-only → off → on. Returns the new overrides.
export async function cycleSkill(name) {
  const text = await readTextFile(SETTINGS()), s = JSON.parse(text ?? "{}"); // null: create the file
  const next = { undefined: "name-only", on: "name-only", "name-only": "off", off: undefined }[s.skillOverrides?.[name]];
  s.skillOverrides = { ...(s.skillOverrides ?? {}) };
  if (next) s.skillOverrides[name] = next; else delete s.skillOverrides[name];
  if (!Object.keys(s.skillOverrides).length) delete s.skillOverrides;
  await writeTextFile(SETTINGS(), JSON.stringify(s, null, 2) + "\n", text);
  return s.skillOverrides ?? {};
}

// Runs a CLI change and says how it went. Resolves true on success.
export async function change(args, timeout = 180) {
  try {
    const r = await claude(args, timeout);
    if (r.code !== 0) { notify({ title: `claude ${args.slice(0, 2).join(" ")} failed`, body: (r.stderr || r.stdout).trim().slice(0, 300), level: "error" }); return false; }
    notify({ title: `Done: claude ${args.join(" ")}`, body: "New Claude sessions pick this up.", level: "success", timeout: 5000 });
    return true;
  } catch (e) { notify({ title: "Failed", body: String(e.message ?? e), level: "error" }); return false; }
}

// A new skill of yours: ~/.claude/skills/<name>/SKILL.md, opened in the editor to fill in.
export async function newSkill(name) {
  const path = `${home()}/.claude/skills/${name}/SKILL.md`;
  const r = await exec("mkdir", ["-p", `${home()}/.claude/skills/${name}`]);
  if (r.code !== 0) throw new Error(r.stderr);
  await writeTextFile(path, `---\nname: ${name}\ndescription: When Claude should use this skill, in one or two sentences.\n---\n\n# ${name}\n\n`, null);
  openInEditor(path);
}

// `claude mcp list` health-checks every server (~10 s), so its last answer is kept on disk and
// shown at once while a fresh one runs.
export async function cachedMcp() {
  try { return parseMcp(await fs.readFile(`${CACHE()}/mcp-list.txt`, "utf8")); } catch { return null; }
}
export async function loadMcp() {
  const out = (await claude(["mcp", "list"], 90)).stdout;
  try { await fs.mkdir(CACHE(), { recursive: true }); await fs.writeFile(`${CACHE()}/mcp-list.txt`, out); } catch { /* shown, just not kept */ }
  return parseMcp(out);
}

export function compact(n) {
  if (n == null) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}
