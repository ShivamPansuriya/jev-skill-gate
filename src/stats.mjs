import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { STATE_DIR } from "./config.mjs";
import { readJsonFile, writeJsonAtomic } from "./settings.mjs";
import { log } from "./log.mjs";

const STATS_PATH = join(STATE_DIR, "stats.json");
const KEEP_RECENT = 50;

const EMPTY = {
  version: 1,
  firstRunAt: null,
  lastRunAt: null,
  totals: {
    runs: 0,
    cachedRuns: 0,
    tokensBefore: 0,
    tokensSaved: 0,
    costUsd: 0,
    jevInputTokens: 0,
    jevRequests: 0,
  },
  byProvider: {},
  recent: [],
};

export function readStats() {
  const s = readJsonFile(STATS_PATH, EMPTY);
  // Older files may predate a field; merge so display code never sees undefined.
  return { ...EMPTY, ...s, totals: { ...EMPTY.totals, ...(s.totals || {}) } };
}

/**
 * Records one gating run.
 *
 * Only a run that actually changed what Claude sees is recorded - `apply` and
 * the hook. `preview` writes nothing, so browsing the plan never inflates the
 * numbers.
 *
 * Running totals are kept separately from the `recent` list, so trimming the
 * list to the last 50 runs never loses lifetime history.
 */
export function recordRun({
  provider,
  cached = false,
  skills,
  tokensBefore,
  tokensSaved,
  costUsd = 0,
  usage = {},
  projectDir,
  source = "apply",
}) {
  try {
    const stats = readStats();
    const now = new Date().toISOString();

    stats.firstRunAt = stats.firstRunAt || now;
    stats.lastRunAt = now;

    const t = stats.totals;
    t.runs += 1;
    if (cached) t.cachedRuns += 1;
    t.tokensBefore += tokensBefore || 0;
    t.tokensSaved += tokensSaved || 0;
    t.costUsd += costUsd || 0;
    t.jevInputTokens += usage.inputTokens || 0;
    t.jevRequests += usage.batches || 0;

    const p = (stats.byProvider[provider] = stats.byProvider[provider] || {
      runs: 0,
      tokensSaved: 0,
      costUsd: 0,
    });
    p.runs += 1;
    p.tokensSaved += tokensSaved || 0;
    p.costUsd += costUsd || 0;

    stats.recent.unshift({
      at: now,
      provider,
      cached,
      source,
      skills,
      tokensBefore,
      tokensSaved,
      costUsd,
      latencyMs: usage.latencyMs ?? null,
      project: projectDir,
    });
    stats.recent = stats.recent.slice(0, KEEP_RECENT);

    mkdirSync(STATE_DIR, { recursive: true });
    writeJsonAtomic(STATS_PATH, stats);
  } catch (err) {
    // Bookkeeping must never break a session.
    log.debug(`could not record stats: ${err.message}`);
  }
}

export function resetStats() {
  mkdirSync(STATE_DIR, { recursive: true });
  writeJsonAtomic(STATS_PATH, EMPTY);
  return STATS_PATH;
}

export const STATS_FILE = STATS_PATH;
