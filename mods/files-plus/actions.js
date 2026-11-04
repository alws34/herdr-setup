import { exec, focused, panes, spaces, home, shared, setShared, run } from "herdr";
import { basename, dirname, joinPath, contains, relativePath, workspaceOf } from "./roots.js";

export const CLIPBOARD = "files-plus.clipboard", REVISION = "files-plus.revision";
const destination = target => target.kind === "file" ? dirname(target.path) : target.path;
async function checked(command, args, on) {
  const result = await exec(command, args, { on });
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed`);
  return result;
}
const shell = (script, args, on) => checked("sh", ["-c", script, "files-plus", ...args], on);

export function captureTarget(space, path, kind, root, on, physicalRoot = root) {
  const f = focused();
  const active = f?.space === space && f.terminal ? { pane: f.pane, terminal: f.shown || f.terminal, cwd: f.cwd } : null;
  return { space, path, kind, root, physicalRoot, on: on ?? null, active };
}
export function ensureTarget(target) {
  if (!spaces().some(s => s.id === target.space && s.machine === target.on)) throw new Error("The target space is no longer available");
}
export function reference(target) {
  let cwd = target.active?.cwd;
  // Herdr reports physical terminal cwd paths; workspace roots keep their spelling.
  if (cwd && target.physicalRoot && contains(target.physicalRoot, cwd)) {
    const relative = relativePath(target.physicalRoot, cwd);
    cwd = relative === "." ? target.root : joinPath(target.root, relative);
  }
  const path = cwd && contains(target.root, cwd) && contains(cwd, target.path) ? relativePath(cwd, target.path) : target.path;
  return `@${/[\s"\\]/.test(path) ? JSON.stringify(path) : path} `;
}
export async function insertReference(target, cx) {
  ensureTarget(target);
  const active = target.active;
  if (!active?.terminal) throw new Error("There is no active terminal in this space");
  const space = spaces().find(s => s.id === target.space), tabs = new Set(space.tabs.map(t => t.id));
  if (active.pane && !panes().some(p => p.pane === active.pane && tabs.has(p.tab) && p.terminal)) throw new Error("The target terminal is no longer available");
  const previous = cx.read_from_clipboard();
  // run() queues a command. Yield before reading focus or restoring clipboard text.
  run("pane.focus", { terminal: active.terminal });
  await cx.sleep(0);
  if (focused()?.terminal !== active.terminal && focused()?.shown !== active.terminal) throw new Error("Could not focus the target terminal");
  try {
    cx.write_to_clipboard(reference(target));
    run("terminal.paste");
    await cx.sleep(0);
  } finally { if (previous !== undefined) cx.write_to_clipboard(previous); }
}
export function validateName(name) {
  if (!name.trim() || name === "." || name === ".." || /[/\\\x00-\x1f\x7f]/.test(name)) throw new Error("Enter a name without path separators or control characters");
  return name;
}
export async function exists(path, on) {
  const result = await exec("sh", ["-c", '[ -e "$1" ] || [ -L "$1" ]', "files-plus", path], { on });
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || "Cannot check this path");
  return result.code === 0;
}
export async function availablePath(dir, name, kind, on) {
  const dot = kind === "file" ? name.lastIndexOf(".") : -1;
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 0; n < 10000; n++) {
    const candidate = n === 0 ? name : `${stem} copy${n > 1 ? ` ${n}` : ""}${ext}`;
    const path = joinPath(dir, candidate);
    if (!await exists(path, on)) return path;
  }
  throw new Error("No available copy name in this folder");
}
export function changed() { setShared(REVISION, (Number(shared(REVISION)) || 0) + 1); }

export async function paste(target) {
  ensureTarget(target);
  const source = shared(CLIPBOARD), dir = destination(target);
  if (!source || source.on !== target.on) throw new Error("Copy an entry from the same machine first");
  if (source.kind !== "file") {
    if (contains(source.path, dir)) throw new Error("A folder cannot be pasted into itself or a descendant");
    // A symlink in the destination path must not bypass the directory-cycle check.
    const physical = await shell('cd -P "$1" && printf "%s\\0" "$PWD" && cd -P "$2" && printf "%s\\0" "$PWD"', [source.path, dir], target.on);
    const [src, dst] = physical.stdout.split("\0");
    if (contains(src, dst)) throw new Error("A folder cannot be pasted into itself or a descendant");
  }
  if (!await exists(source.path, target.on)) throw new Error("The copied entry is no longer available");
  const path = await availablePath(dir, basename(source.path), source.kind, target.on);
  await checked("cp", ["-R", "-P", "-n", source.path, path], target.on);
  changed();
  return path;
}

export async function createEntry(target, kind, name) {
  ensureTarget(target); validateName(name);
  const path = joinPath(destination(target), name);
  if (await exists(path, target.on)) throw new Error("An entry with this name already exists");
  if (kind === "file") await shell('set -C; : > "$1"', [path], target.on);
  else await checked("mkdir", [path], target.on);
  changed();
  return path;
}

export async function renameEntry(target, name) {
  ensureTarget(target); validateName(name);
  if (target.kind === "root") throw new Error("Workspace roots cannot be renamed here");
  if (name === basename(target.path)) return target.path;
  const path = joinPath(dirname(target.path), name);
  if (await exists(path, target.on)) throw new Error("An entry with this name already exists");
  await shell('mv -n "$1" "$2" && { [ ! -e "$1" ] && [ ! -L "$1" ]; }', [target.path, path], target.on);
  changed();
  return path;
}

export async function trashEntry(target) {
  ensureTarget(target);
  if (target.kind === "root" || target.path === target.root || target.path === "/") throw new Error("Workspace roots cannot be removed here");
  if (!target.on) {
    const trash = joinPath(home(), ".Trash");
    await checked("mkdir", ["-p", trash], null);
    const path = await availablePath(trash, basename(target.path), target.kind, null);
    await shell('mv -n "$1" "$2" && { [ ! -e "$1" ] && [ ! -L "$1" ]; }', [target.path, path], null);
  } else await checked("rm", ["-rf", "--", target.path], target.on);
  changed();
}
export async function reveal(target) {
  ensureTarget(target);
  if (target.on !== null) throw new Error("Reveal is only available for local files");
  await checked("open", ["-R", target.path], null);
}
export function menuItems(target) {
  const clip = shared(CLIPBOARD), root = target.kind === "root" || target.path === target.root;
  return [
    { id: "agent", label: "Add to agent (@)", enabled: Boolean(target.active?.terminal) },
    { id: "copy", label: "Copy", enabled: true },
    { id: "paste", label: "Paste", enabled: Boolean(clip && clip.on === target.on) },
    { id: "path", label: "Copy path", enabled: true },
    { id: "relative", label: "Copy relative path", enabled: true },
    { id: "reveal", label: "Reveal in Finder", enabled: target.on === null },
    { id: "new-file", label: "New file…", enabled: true, group: true },
    { id: "new-folder", label: "New folder…", enabled: true },
    { id: "rename", label: "Rename…", enabled: !root },
    { id: "trash", label: "Move to Trash…", enabled: !root, danger: true },
    ...(root ? [
      { id: "new-here", label: "New terminal or agent here…", enabled: true, group: true },
      { id: "remove-root", label: "Remove from workspace", enabled: (workspaceOf(target.space)?.folders.length || 0) > 1 }
    ] : [])
  ];
}
