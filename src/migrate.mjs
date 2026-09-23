import { join } from "node:path";
import { mkdirSync, existsSync, unlinkSync, chmodSync } from "node:fs";
import { STATE_DIR, CONFIG_PATH } from "./paths.mjs";
import { readJsonFile, writeJsonAtomic } from "./settings.mjs";
import { log } from "./log.mjs";

const VERSION_PATH = join(STATE_DIR, "state-version.json");

/**
 * Bump when an on-disk format changes, and add the matching step below.
 */
export const STATE_VERSION = 3;

/**
 * Each migration takes the state directory and makes it valid for the next
 * version. They must be idempotent: a half-finished update, a crash, or a user
 * running two copies at once should not corrupt anything.
 *
 * Migrations never touch skillOverrides. Those live in the user's settings and
 * are owned by apply/restore; rewriting them here could silently change what
 * Claude sees without anyone asking for it.
 */
const MIGRATIONS = {
  // v1 -> v2: the cache key gained the provider, so every existing entry is
  // keyed the old way. They would never be read again, but a stale local-scorer
  // entry that DID match would serve worse scores to a run that now has a key.
  // Dropping the file is correct and costs one re-score.
  2: (stateDir) => {
    const cache = join(stateDir, "cache.json");
    if (existsSync(cache)) {
      unlinkSync(cache);
      return "cleared the score cache (key format changed to include the provider)";
    }
    return "no cache to clear";
  },

  // v2 -> v3: providers became plugins, so their settings moved from top-level
  // `typesafe` / `gateway` keys into a `providers` map.
  //
  // loadConfig folds the old keys in at read time regardless, so this rewrite
  // is tidiness rather than a fix - which is exactly why it is safe to do here.
  // It only ever moves keys that already exist, and a key already present in
  // the new location wins, so running it twice changes nothing.
  3: () => {
    const cfg = readJsonFile(CONFIG_PATH, null);
    if (!cfg || typeof cfg !== "object") return "no config file to migrate";
    const legacy = ["typesafe", "gateway"].filter((id) => cfg[id] && typeof cfg[id] === "object");
    if (legacy.length === 0) return "config already uses the providers map";

    const providers = { ...(cfg.providers || {}) };
    for (const id of legacy) {
      providers[id] = { ...cfg[id], ...(providers[id] || {}) };
      delete cfg[id];
    }
    writeJsonAtomic(CONFIG_PATH, { ...cfg, providers });
    try {
      // It may hold an API key, and the move must not widen its permissions.
      chmodSync(CONFIG_PATH, 0o600);
    } catch {
      /* best effort on platforms without POSIX modes */
    }
    return `moved ${legacy.join(", ")} into providers.* in ${CONFIG_PATH}`;
  },
};

/**
 * Files that only an older version could have written. Their presence is what
 * makes an install "existing"; the state directory alone is not, because it
 * also holds things a fresh install creates for its own reasons - the provider
 * plugin directory, for one. Keying off the directory reported every new
 * install as three versions behind.
 */
const LEGACY_STATE_FILES = ["cache.json", "stats.json"];

export function readStateVersion() {
  if (existsSync(VERSION_PATH)) return readJsonFile(VERSION_PATH, { version: 1 }).version || 1;
  // No version file. Older state means v1; nothing at all means a fresh install
  // with nothing to migrate.
  const hasOldState = LEGACY_STATE_FILES.some((f) => existsSync(join(STATE_DIR, f)));
  return hasOldState ? 1 : STATE_VERSION;
}

/**
 * Brings on-disk state up to STATE_VERSION.
 *
 * Called only by `update`. Migration is part of updating, not something every
 * command should do behind the user's back: a normal invocation has no business
 * rewriting state just because it happened to run.
 *
 * Skipping it is safe for the migrations that exist. v1 cache entries are keyed
 * the old way, so they simply never match and sit inert until the 30-entry cap
 * evicts them. `doctor` reports when state is behind so nothing is silent.
 */
export function runMigrations({ quiet = true } = {}) {
  let from;
  try {
    from = readStateVersion();
  } catch {
    return { migrated: false, from: null, to: STATE_VERSION, steps: [] };
  }
  if (from >= STATE_VERSION) return { migrated: false, from, to: STATE_VERSION, steps: [] };

  const steps = [];
  for (let v = from + 1; v <= STATE_VERSION; v++) {
    const fn = MIGRATIONS[v];
    if (!fn) continue;
    try {
      const note = fn(STATE_DIR);
      steps.push({ version: v, note });
      if (!quiet) log.info(`migrated state to v${v}: ${note}`);
    } catch (err) {
      // A failed migration must not block the tool. Report and stop, leaving
      // the version unchanged so it will be retried next time.
      log.warn(`migration to v${v} failed: ${err.message}`);
      return { migrated: steps.length > 0, from, to: v - 1, steps, error: err.message };
    }
  }

  mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(VERSION_PATH, { version: STATE_VERSION, migratedAt: new Date().toISOString() });
  return { migrated: true, from, to: STATE_VERSION, steps };
}

export const STATE_VERSION_FILE = VERSION_PATH;
