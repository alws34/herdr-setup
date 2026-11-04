// Scans session transcripts into the Insights store. Imported by presenter.mjs.
import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeConfig, sourcesSignature } from "./core/config.mjs";
import { scanSources } from "./core/scan.mjs";
import {
  clearCollectedData,
  loadStore,
  saveStore,
  snapshotRows,
} from "./core/store.mjs";
import { withStoreLock } from "./core/util.mjs";

function buildSnapshot(store, scan, nowIso, loadWarnings = [], loadErrors = 0) {
  const warnings = [...loadWarnings, ...scan.warnings];
  const stats = {
    ...scan.stats,
    errors: scan.stats.errors + loadErrors,
  };
  return {
    version: 1,
    generatedAt: nowIso,
    lastScanAt: nowIso,
    config: store.config,
    rows: snapshotRows(store),
    stats,
    sourceStats: scan.sourceStats ?? undefined,
    warnings,
  };
}

/**
 * Best-effort scan progress sidecar next to the store. The native view polls
 * it only while a refresh is running; it is removed when the scan settles.
 */
function progressWriter(storePath) {
  const progressPath = `${storePath}.progress.json`;
  const tempPath = `${progressPath}.${process.pid}-${randomUUID()}.tmp`;
  let lastWrite = 0;
  return {
    update(state) {
      const now = Date.now();
      if (now - lastWrite < 250 && state.processed < state.total) return;
      lastWrite = now;
      try {
        // Atomic replacement also avoids following an existing sidecar link.
        writeFileSync(tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
        renameSync(tempPath, progressPath);
      } catch { /* progress is best-effort */ }
      finally {
        try { unlinkSync(tempPath); } catch { /* renamed or not created */ }
      }
    },
    clear() {
      try {
        unlinkSync(progressPath);
      } catch { /* already gone */ }
    },
  };
}

// Scans every enabled source into the store under the store lock. With a
// config (the "configure" command) it is validated and saved before scanning,
// so a failed scan still leaves the newly configured sources in place.
async function scanStore(storePath, home, config) {
  return withStoreLock(storePath, async () => {
    const loaded = await loadStore(storePath);
    const store = loaded.store;
    let dirty = loaded.dirty;
    if (config) {
      const mappingsChanged = sourcesSignature(store.config) !== sourcesSignature(config);
      if (JSON.stringify(store.config) !== JSON.stringify(config)) {
        store.config = config;
        dirty = true;
      }
      if (mappingsChanged) {
        clearCollectedData(store);
        dirty = true;
      }
      if (dirty) {
        await saveStore(storePath, store);
        dirty = false;
      }
    }

    const progress = progressWriter(storePath);
    let scan;
    try {
      scan = await scanSources(store, { home, onProgress: (state) => progress.update(state) });
    } finally {
      progress.clear();
    }
    if (dirty || scan.dirty) await saveStore(storePath, store);
    return buildSnapshot(store, scan, new Date().toISOString(), loaded.warnings, loaded.errors);
  });
}

/** In-process API: the presenter never serializes and reparses raw rows. */
export async function collectSnapshot(command, options) {
  const storePath = path.resolve(options.store);
  const home = path.resolve(options.home ?? os.homedir());
  if (command === "snapshot") return scanStore(storePath, home, null);
  let config;
  try {
    const raw = options.config;
    config = normalizeConfig(typeof raw === "string" ? JSON.parse(raw) : raw);
  } catch (error) {
    const invalid = new Error(`invalid --config: ${error.message}`);
    invalid.exitCode = 2;
    throw invalid;
  }
  return scanStore(storePath, home, config);
}
