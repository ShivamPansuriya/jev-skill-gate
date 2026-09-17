import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const CONFIG_PATH = join(CLAUDE_DIR, "jev-skill-gate.json");
export const STATE_DIR = join(CLAUDE_DIR, "jev-skill-gate");

/**
 * Thresholds map a relevance probability onto Claude Code's four skillOverrides
 * states. We never emit "off": that would hide the skill from the user's own
 * slash menu too, so a wrong call would cost them access rather than tokens.
 */
export const DEFAULTS = {
  provider: "auto", // auto | typesafe | gateway | fallback | disabled

  // Per-transport endpoint config. apiKey may be set here, but an environment
  // variable always wins, and env is the better place for it.
  typesafe: {
    baseUrl: "https://api.typesafe.ai/v1",
    model: "jev-latest",
    apiKey: null,
  },
  gateway: {
    baseUrl: "https://ai-gateway.vercel.sh",
    model: "typesafe-ai/jev",
    apiKey: null,
  },

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

export function loadConfig(overrides = {}) {
  let fileCfg = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fileCfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
      process.stderr.write(`[jev-skill-gate] ignoring malformed ${CONFIG_PATH}: ${err.message}\n`);
    }
  }
  const cfg = deepMerge(deepMerge(DEFAULTS, fileCfg), overrides);

  if (process.env.JEV_SKILL_GATE_DRY_RUN === "1") cfg.dryRun = true;
  if (process.env.JEV_SKILL_GATE_LOG) cfg.logLevel = process.env.JEV_SKILL_GATE_LOG;
  if (process.env.JEV_SKILL_GATE_PROVIDER) cfg.provider = process.env.JEV_SKILL_GATE_PROVIDER;

  return cfg;
}

/**
 * Resolves which transport to use and with what key.
 *
 * Precedence is environment first, config file second. Env is the better home
 * for a credential: it is per-shell, easy to rotate, and never ends up in a
 * file you might commit. The config field exists because not every setup has a
 * convenient place to export a variable.
 */
export function resolveProvider(cfg) {
  const typesafeKey =
    process.env.TYPESAFE_API_KEY || process.env.TYPESAFE_AI_API_KEY || cfg.typesafe?.apiKey || null;
  const gatewayKey =
    process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_KEY || cfg.gateway?.apiKey || null;

  if (cfg.provider === "disabled") return { kind: "disabled" };
  if (cfg.provider === "fallback") return { kind: "fallback" };
  if (cfg.provider === "typesafe") {
    return typesafeKey
      ? { kind: "typesafe", apiKey: typesafeKey }
      : { kind: "fallback", reason: "no TypeSafe key (set TYPESAFE_API_KEY or typesafe.apiKey)" };
  }
  if (cfg.provider === "gateway") {
    return gatewayKey
      ? { kind: "gateway", apiKey: gatewayKey }
      : { kind: "fallback", reason: "no Gateway key (set AI_GATEWAY_API_KEY or gateway.apiKey)" };
  }
  // auto
  if (typesafeKey) return { kind: "typesafe", apiKey: typesafeKey };
  if (gatewayKey) return { kind: "gateway", apiKey: gatewayKey };
  return { kind: "fallback", reason: "no API key found in environment or config" };
}

/** Masks a key for display. Never print one in full. */
export function maskKey(key) {
  if (!key) return "(unset)";
  return key.length <= 12 ? "****" : `${key.slice(0, 6)}...${key.slice(-4)}`;
}
