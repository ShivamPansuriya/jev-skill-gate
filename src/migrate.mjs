import { join } from "node:path";
import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { STATE_DIR } from "./config.mjs";
import { readJsonFile, writeJsonAtomic } from "./settings.mjs";
import { log } from "./log.mjs";

const VERSION_PATH = join(STATE_DIR, "state-version.json");

/**
 * Bump when an on-disk format changes, and add the matching step below.
 */
export const STATE_VERSION = 2;

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
};

export function readStateVersion() {
  // A state dir that exists but has no version file predates versioning, so it
  // is v1. A dir that does not exist at all is a fresh install and needs no
  // migration.
  if (!existsSync(STATE_DIR)) return STATE_VERSION;
  return readJsonFile(VERSION_PATH, { version: 1 }).version || 1;
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
