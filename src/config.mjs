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
  model: "jev-latest",
  typesafeBaseUrl: "https://api.typesafe.ai/v1",
  gatewayBaseUrl: "https://ai-gateway.vercel.sh/v1",
  gatewayModel: "typesafe-ai/jev",

  thresholds: {
    on: 0.6, // full description in context
    nameOnly: 0.25, // name only, ~3 tokens
    // below nameOnly -> "user-invocable-only" (hidden from Claude, /name still works)
  },

  // Hard caps so a miscalibrated run can never blow the budget back up.
  // They double as the slice sizes for the uncalibrated local scorer.
  maxOn: 40,
  maxNameOnly: 60,

  // Fail-open guards. Hiding a skill is silent, so thin evidence must not
  // produce confident hiding.
  safety: {
    minSignalTokens: 40,
  },

  scope: "auto", // auto | project | user

  // Never gated, always left at full visibility. Matched exactly against skill name.
  alwaysOn: [],
  // Never written to skillOverrides at all, whatever the score.
  ignore: [],

  // Request shaping
  batchSize: 120, // questions per Jev call; the API takes up to 255
  timeoutMs: 15000,
  maxRetries: 2,

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
 * Keys are read from the environment only. Nothing is ever persisted to the
 * config file, so this repo stays safe to commit and share.
 */
export function resolveProvider(cfg) {
  const typesafeKey = process.env.TYPESAFE_API_KEY || process.env.TYPESAFE_AI_API_KEY;
  const gatewayKey = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_KEY;

  if (cfg.provider === "disabled") return { kind: "disabled" };
  if (cfg.provider === "fallback") return { kind: "fallback" };
  if (cfg.provider === "typesafe") {
    return typesafeKey
      ? { kind: "typesafe", apiKey: typesafeKey }
      : { kind: "fallback", reason: "TYPESAFE_API_KEY not set" };
  }
  if (cfg.provider === "gateway") {
    return gatewayKey
      ? { kind: "gateway", apiKey: gatewayKey }
      : { kind: "fallback", reason: "AI_GATEWAY_API_KEY not set" };
  }
  // auto
  if (typesafeKey) return { kind: "typesafe", apiKey: typesafeKey };
  if (gatewayKey) return { kind: "gateway", apiKey: gatewayKey };
  return { kind: "fallback", reason: "no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY in environment" };
}
