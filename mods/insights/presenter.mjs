#!/usr/bin/env node
// Node presentation helper for Insights.
//
// QuickJS receives only a compact dashboard payload. The full snapshot rows and
// the pure analytics derivation stay in Node, where a filter change can also be
// prepared from the existing store without scanning transcripts again.
import os from "node:os";
import path from "node:path";
import {
  PRESENTATION_VERSION,
  compactDashboard,
  deriveDashboard,
} from "./analytics.js";
import { collectSnapshot } from "./collector.mjs";
import { loadStore, snapshotRows } from "./core/store.mjs";

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const match = /^--(store|home|config|options)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`unknown argument ${arg}`);
    const key = match[1];
    let value = match[2];
    if (value === undefined) {
      index += 1;
      value = argv[index];
      if (value === undefined) throw new Error(`--${key} needs a value`);
    }
    options[key] = value;
  }
  return { command, options };
}

function parseOptions(raw) {
  if (raw === undefined) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const invalid = new Error(`invalid --options: ${error.message}`);
    invalid.exitCode = 2;
    throw invalid;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const invalid = new Error("invalid --options: expected one JSON object");
    invalid.exitCode = 2;
    throw invalid;
  }
  return parsed;
}

function compactSnapshot(snapshot, rowCount = 0) {
  const {
    version = 1,
    generatedAt = null,
    lastScanAt = null,
    config = {},
    stats,
    sourceStats,
    warnings = [],
  } = snapshot ?? {};
  return {
    version,
    generatedAt,
    lastScanAt,
    config,
    rowCount: Array.isArray(snapshot?.rows)
      ? snapshot.rows.length
      : Number.isFinite(Number(rowCount))
        ? Number(rowCount)
        : 0,
    stats,
    sourceStats,
    warnings: Array.isArray(warnings) ? warnings : [],
  };
}

function presentation(command, snapshot, options, dashboard, error) {
  return {
    version: PRESENTATION_VERSION,
    kind: "insights-presentation",
    command,
    options,
    snapshot: compactSnapshot(snapshot),
    dashboard: dashboard ? compactDashboard(dashboard) : null,
    error: error ? String(error.message ?? error) : null,
  };
}

function storeSnapshot(store, loaded) {
  const rows = snapshotRows(store);
  return {
    version: 1,
    generatedAt: store.lastScanAt,
    lastScanAt: store.lastScanAt,
    config: store.config,
    rows,
    stats: loaded?.errors ? { errors: loaded.errors } : undefined,
    warnings: loaded?.warnings ?? [],
  };
}

function derive(snapshot, options) {
  try {
    return { dashboard: deriveDashboard(snapshot, options), error: null };
  } catch (error) {
    return { dashboard: null, error };
  }
}

async function run(argv) {
  const { command, options } = parseArgs(argv);
  if (!["snapshot", "configure", "prepare"].includes(command)) throw new Error(`unknown command ${command}`);
  if (!options.store) throw new Error("--store is required");
  if (command === "configure" && options.config === undefined) throw new Error("--config is required");

  const storePath = path.resolve(options.store);
  const dashboardOptions = parseOptions(options.options);
  let snapshot;
  if (command === "prepare") {
    const loaded = await loadStore(storePath, { readOnly: true });
    snapshot = storeSnapshot(loaded.store, loaded);
  } else {
    const home = path.resolve(options.home ?? os.homedir());
    snapshot = await collectSnapshot(command, { store: storePath, home, config: options.config });
  }
  const derived = derive(snapshot, dashboardOptions);
  return `${JSON.stringify(presentation(command, snapshot, dashboardOptions, derived.dashboard, derived.error))}\n`;
}

try {
  process.stdout.write(await run(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`insights presenter: ${error.message}\n`);
  process.exitCode = error.exitCode ?? 1;
}
