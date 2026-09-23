import { readFileSync, existsSync } from "node:fs";
import { CLAUDE_DIR, CONFIG_PATH, STATE_DIR } from "./paths.mjs";

export { CLAUDE_DIR, CONFIG_PATH, STATE_DIR };

/**
 * Thresholds map a relevance probability onto Claude Code's four skillOverrides
 * states. We never emit "off": that would hide the skill from the user's own
 * slash menu too, so a wrong call would cost them access rather than tokens.
 */
export const DEFAULTS = {
  // "auto" picks the first hosted provider that has a key, else the local
  // scorer. Any provider id works here - run `jev-skill-gate providers` for the
  // list, which includes anything you dropped in the plugin directory.
  // "disabled" turns gating off entirely.
  provider: "auto",

  // Per-provider settings, keyed by provider id. Each provider supplies its own
  // defaults (base URL, model, and so on); anything set here overrides them.
  // apiKey may live here, but an environment variable always wins, and env is
  // the better place for it.
  //
  //   "providers": {
  //     "open-jev": { "baseUrl": "http://127.0.0.1:8791" },
  //     "laya-mlx": { "model": "convaiinnovations/laya" }
  //   }
  providers: {},

  // Tuned against eval/RESULTS.md and eval/JEV-PARTIAL.md rather than guessed.
  //
  // Measured Jev distribution for a prompt: median ~0.06, long tail, with the
  // primary skills for a request landing at 0.83-0.96. `on: 0.6` separates those
  // cleanly.
  //
  // `nameOnly` started at 0.25 and hid two skills the user actually needed:
  // inventory-demand-planning at 0.17 on a freight prompt, and security-review
  // at 0.20 on a PR-review prompt. Secondary-but-relevant skills cluster in
  // 0.15-0.60, so the floor moved to 0.15. Costs ~3 tokens each to keep; hiding
  // one is silent.
  thresholds: {
    on: 0.6, // full description in context
    nameOnly: 0.15, // name only, ~3 tokens
    // below nameOnly -> "user-invocable-only" (hidden from Claude, /name still works)
  },

  // Hard caps so a miscalibrated run can never blow the budget back up.
  // They double as the slice sizes for the uncalibrated local scorer.
  maxOn: 40,
  maxNameOnly: 60,
  // Caps also scale with library size, so a small install still gets gated.
  // A flat cap of 40 leaves a 54-skill library almost entirely visible.
  maxOnRatio: 0.2,
  maxNameOnlyRatio: 0.3,

  // Fail-open guards. Hiding a skill is silent, so thin evidence must not
  // produce confident hiding.
  safety: {
    // Bail out unless the top score clears the median by this much. Measures
    // whether the scores discriminate, which is the thing that matters, rather
    // than how long the input was.
    minSeparation: 0.15,
    // Cheap early-out for a literally empty prompt.
    minStateTokens: 3,
  },

  scope: "auto", // auto | project | user

  // Never gated, always left at full visibility. Matched exactly against skill name.
  alwaysOn: [],
  // Never written to skillOverrides at all, whatever the score.
  ignore: [],

  // Request shaping
  // Jev evaluates up to 255 questions in one parallel pass, and the request
  // budget is ~32k tokens. One batch per session is both cheapest and least
  // likely to trip a rate limit.
  batchSize: 250,
  // Batches run sequentially by default. Firing them in parallel trips
  // free-tier rate limits on the very first run with a large skill library.
  concurrency: 1,
  timeoutMs: 20000,
  maxRetries: 4,

  cacheTtlHours: 168, // 7 days
  logLevel: "info", // silent | info | debug
  dryRun: false,
};

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out && typeof out[k] === "object" && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/**
 * Before providers were pluggable there were exactly two, configured as
 * top-level `typesafe` and `gateway` objects. Those keys are folded into
 * `providers` here so that an existing config keeps working untouched, and the
 * old keys lose to the new ones if somehow both are present.
 *
 * `migrate` rewrites the file properly during an update. This shim is what
 * makes that rewrite optional rather than urgent.
 */
function liftLegacyProviders(cfg) {
  const legacy = ["typesafe", "gateway"].filter((id) => cfg[id] && typeof cfg[id] === "object");
  if (legacy.length === 0) return cfg;
  const providers = { ...cfg.providers };
  for (const id of legacy) providers[id] = { ...cfg[id], ...(providers[id] || {}) };
  const out = { ...cfg, providers };
  for (const id of legacy) delete out[id];
  return out;
}

export function loadConfig(overrides = {}) {
  let fileCfg = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fileCfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
      process.stderr.write(`[jev-skill-gate] ignoring malformed ${CONFIG_PATH}: ${err.message}\n`);
    }
  }
  const cfg = liftLegacyProviders(deepMerge(deepMerge(DEFAULTS, fileCfg), overrides));

  if (process.env.JEV_SKILL_GATE_DRY_RUN === "1") cfg.dryRun = true;
  if (process.env.JEV_SKILL_GATE_LOG) cfg.logLevel = process.env.JEV_SKILL_GATE_LOG;
  if (process.env.JEV_SKILL_GATE_PROVIDER) cfg.provider = process.env.JEV_SKILL_GATE_PROVIDER;

  return cfg;
}

/**
 * Choosing a provider now belongs to the registry, which is the only thing that
 * knows what providers exist. Re-exported here so callers keep one import.
 */
export { resolveProvider, loadProviders, providerConfig, providerKey } from "./providers/index.mjs";

/** Masks a key for display. Never print one in full. */
export function maskKey(key) {
  if (!key) return "(unset)";
  return key.length <= 12 ? "****" : `${key.slice(0, 6)}...${key.slice(-4)}`;
}
