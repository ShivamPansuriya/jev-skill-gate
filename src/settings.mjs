import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { CLAUDE_DIR, STATE_DIR } from "./config.mjs";
import { log } from "./log.mjs";

const MANAGED_STATE = join(STATE_DIR, "managed.json");

/**
 * Where the overrides land.
 *
 * Project-local by default, because relevance is a property of the project: the
 * Rust skills that matter in one repo are dead weight in another. Falls back to
 * user-level when the session is not inside a project.
 */
export function resolveSettingsPath(projectDir, scope = "auto") {
  if (scope === "user") return join(CLAUDE_DIR, "settings.local.json");
  if (scope === "project") return join(projectDir, ".claude", "settings.local.json");
  const looksLikeProject =
    existsSync(join(projectDir, ".git")) ||
    existsSync(join(projectDir, ".claude")) ||
    existsSync(join(projectDir, "package.json"));
  return looksLikeProject
    ? join(projectDir, ".claude", "settings.local.json")
    : join(CLAUDE_DIR, "settings.local.json");
}

export function readJsonFile(p, fallback = {}) {
  if (!existsSync(p)) return fallback;
  try {
    const text = readFileSync(p, "utf8").trim();
    return text ? JSON.parse(text) : fallback;
  } catch (err) {
    throw new Error(`cannot parse ${p}: ${err.message}`);
  }
}

/** Write via temp file + rename so an interrupted run never truncates settings. */
export function writeJsonAtomic(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.jev-tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  renameSync(tmp, p);
}

function loadManaged() {
  return readJsonFile(MANAGED_STATE, { keys: [], settingsPath: null, backup: null });
}

function saveManaged(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(MANAGED_STATE, state);
}

/**
 * Applies a name -> state map to skillOverrides.
 *
 * Two invariants:
 *  - Overrides the user set by hand are never touched. We only replace keys we
 *    wrote on a previous run, tracked in managed.json.
 *  - The first run snapshots the original skillOverrides so `restore` is exact.
 */
export function applyOverrides(settingsPath, overrides, { dryRun = false } = {}) {
  const settings = readJsonFile(settingsPath, {});
  const existing = settings.skillOverrides || {};
  const managed = loadManaged();

  if (managed.backup === null || managed.settingsPath !== settingsPath) {
    managed.backup = { ...existing };
    managed.settingsPath = settingsPath;
  }

  const userOwned = {};
  for (const [k, v] of Object.entries(existing)) {
    if (!managed.keys.includes(k)) userOwned[k] = v;
  }

  const next = { ...userOwned };
  let skippedUserOwned = 0;
  for (const [name, state] of Object.entries(overrides)) {
    if (name in userOwned) {
      skippedUserOwned++;
      continue;
    }
    next[name] = state;
  }

  const changed = JSON.stringify(next) !== JSON.stringify(existing);

  if (dryRun) {
    return { changed, next, previous: existing, skippedUserOwned, wrote: false, settingsPath };
  }

  if (changed) {
    settings.skillOverrides = next;
    writeJsonAtomic(settingsPath, settings);
  }

  managed.keys = Object.keys(overrides).filter((k) => !(k in userOwned));
  saveManaged(managed);

  return { changed, next, previous: existing, skippedUserOwned, wrote: changed, settingsPath };
}

/** Puts skillOverrides back exactly as it was before the first gated run. */
export function restoreOverrides() {
  const managed = loadManaged();
  if (!managed.settingsPath || managed.backup === null) {
    return { restored: false, reason: "no gated run recorded; nothing to restore" };
  }
  const settings = readJsonFile(managed.settingsPath, {});
  if (Object.keys(managed.backup).length === 0) {
    delete settings.skillOverrides;
  } else {
    settings.skillOverrides = managed.backup;
  }
  writeJsonAtomic(managed.settingsPath, settings);
  saveManaged({ keys: [], settingsPath: null, backup: null });
  log.info(`restored skillOverrides in ${managed.settingsPath}`);
  return { restored: true, settingsPath: managed.settingsPath };
}

export const HOOK_MARKER = "jev-skill-gate";

/**
 * Registers the SessionStart hook in ~/.claude/settings.json, merging into any
 * hooks the user already has rather than replacing the block.
 */
export function installHook({ entrypoint, event = "SessionStart", settingsPath = join(CLAUDE_DIR, "settings.json") }) {
  const settings = readJsonFile(settingsPath, {});
  settings.hooks = settings.hooks || {};
  settings.hooks[event] = settings.hooks[event] || [];

  const command = `node ${JSON.stringify(entrypoint)} hook --event ${event}`;
  const already = JSON.stringify(settings.hooks[event]).includes(HOOK_MARKER);
  if (already) return { installed: false, reason: "hook already present", settingsPath };

  settings.hooks[event].push({
    hooks: [{ type: "command", command, timeout: 30 }],
  });
  writeJsonAtomic(settingsPath, settings);
  return { installed: true, settingsPath, command };
}

export function uninstallHook({ settingsPath = join(CLAUDE_DIR, "settings.json") } = {}) {
  const settings = readJsonFile(settingsPath, {});
  if (!settings.hooks) return { removed: 0, settingsPath };

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    settings.hooks[event] = groups.filter((g) => {
      const hit = JSON.stringify(g).includes(HOOK_MARKER);
      if (hit) removed++;
      return !hit;
    });
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (removed) writeJsonAtomic(settingsPath, settings);
  return { removed, settingsPath };
}
