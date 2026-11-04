import { spaces, readTextFile, writeTextFile, shared } from "herdr";
import { dirname, resolvePath, relativePath, parseConfig, reloadWorkspace, loadConfig, workspaceOf, setWorkspace, putShared, RECENT } from "./roots.js";

const identity = entry => JSON.stringify(entry && { name: entry.name, file: entry.file, folders: entry.folders });
function checkSpace(target) {
  const space = spaces().find(s => s.id === target.space);
  if (!space || space.machine !== null) throw new Error("This workspace is no longer available");
  return space;
}

export async function workspaceSnapshot(target) {
  checkSpace(target);
  let entry = workspaceOf(target.space);
  const snapshot = entry?.file ? await loadConfig(entry.file) : null;
  if (identity(workspaceOf(target.space)) !== identity(entry)) throw new Error("The workspace changed. Open the action again.");
  if (snapshot) {
    entry = { name: snapshot.name, file: entry.file, folders: snapshot.folders };
    setWorkspace(target.space, entry);
  }
  return { entry, snapshot };
}

export async function changeRoots(target, action, path, captured) {
  const space = checkSpace(target), entry = workspaceOf(target.space);
  if (identity(entry) !== identity(captured.entry)) throw new Error("The workspace changed. Open the action again.");
  const current = entry || { name: space.name, file: null, folders: [{ name: null, path: target.root, source: target.root }] };
  let folders;
  if (action === "add-root") {
    if (!path) return false;
    path = resolvePath(target.root, path);
    if (current.folders.some(f => f.path === path)) return false;
    folders = [...current.folders, { name: null, path, source: path }];
  } else {
    if (!entry || entry.folders.length < 2) throw new Error("Keep at least one folder in the workspace");
    folders = entry.folders.filter(f => f.path !== target.root);
    if (folders.length === entry.folders.length) throw new Error("This folder is no longer in the workspace");
  }
  if (!current.file) { setWorkspace(target.space, { ...current, folders }); return true; }
  const { snapshot } = captured, raw = { ...snapshot.raw }, originals = new Map();
  for (const item of snapshot.raw.folders) {
    const resolved = resolvePath(dirname(current.file), typeof item === "string" ? item : item.path);
    if (!originals.has(resolved)) originals.set(resolved, item);
  }
  raw.folders = folders.map(folder => originals.get(folder.path) ?? { path: relativePath(dirname(current.file), folder.path), ...(folder.name ? { name: folder.name } : {}) });
  const text = JSON.stringify(raw, null, 2) + "\n";
  try { await writeTextFile(current.file, text, snapshot.text); }
  catch (error) {
    if (await readTextFile(current.file) !== snapshot.text) {
      await reloadWorkspace(target.space).catch(() => null);
      throw new Error("The workspace file changed on disk. Reloaded. Open the action again.");
    }
    throw error;
  }
  // A completed disk write must not recreate a mapping for a closed or replaced space.
  if (spaces().some(s => s.id === target.space) && identity(workspaceOf(target.space)) === identity(entry)) {
    const parsed = parseConfig(text, current.file);
    setWorkspace(target.space, { name: parsed.name, file: current.file, folders: parsed.folders });
  }
  putShared(RECENT, [current.file, ...(shared(RECENT) || []).filter(file => file !== current.file)].slice(0, 10));
  return true;
}
