import { discoverSkills } from "./discover.mjs";
import { collectSignals, withPrompt } from "./signals.mjs";
import { scoreWithJev } from "./jev.mjs";
import { scoreLocally } from "./fallback.mjs";
import { cacheKey, readCache, writeCache } from "./cache.mjs";
import { resolveProvider } from "./config.mjs";
import { log } from "./log.mjs";

export const STATE_ON = "on";
export const STATE_NAME_ONLY = "name-only";
export const STATE_HIDDEN = "user-invocable-only";

/**
 * Turns scores into skillOverrides entries.
 *
 * "on" is Claude Code's default for an absent key, so we only ever write the two
 * reduced states. That keeps settings.local.json small and makes un-gating a
 * skill a matter of deleting one line.
 *
 * We never write "off". "user-invocable-only" hides the skill from Claude while
 * leaving /name typable, so a miscalibrated score costs tokens saved, never
 * access lost.
 */
export function planOverrides(skills, scores, cfg, meta = {}) {
  const alwaysOn = new Set(cfg.alwaysOn || []);
  const ignore = new Set(cfg.ignore || []);
  const calibrated = meta.calibrated !== false;

  // Thin evidence is the dangerous case: an empty or brand-new directory gives
  // the scorer almost nothing, and a naive threshold pass would then hide
  // everything. Hiding a skill is silent - Claude never learns it existed - so
  // when there is not enough signal we fail open instead.
  const signal = meta.signalStrength ?? Infinity;
  const thinSignal = signal < (cfg.safety?.minSignalTokens ?? 40);
  if (thinSignal) {
    log.warn(`weak project signal (${signal} tokens); leaving every skill visible`);
    return {
      overrides: {},
      decisions: skills.map((skill) => ({ skill, score: null, state: STATE_ON, reason: "weak signal" })),
      stats: {
        total: skills.length,
        on: skills.length,
        nameOnly: 0,
        hidden: 0,
        approxTokensBefore: skills.reduce((n, s) => n + s.approxTokens, 0),
        approxTokensSaved: 0,
      },
      bailedOut: "weak-signal",
    };
  }

  const candidates = [];
  const kept = [];

  for (const skill of skills) {
    if (ignore.has(skill.name)) continue;
    if (alwaysOn.has(skill.name)) {
      kept.push({ skill, score: 1, state: STATE_ON, reason: "alwaysOn" });
      continue;
    }
    // A skill Claude cannot auto-invoke already costs no description tokens.
    if (!skill.modelInvocable) {
      kept.push({ skill, score: null, state: STATE_ON, reason: "not model-invocable" });
      continue;
    }
    // No score came back for it: fail open, keep it fully visible.
    if (!scores.has(skill.name)) {
      kept.push({ skill, score: null, state: STATE_ON, reason: "unscored" });
      continue;
    }
    candidates.push({ skill, score: scores.get(skill.name) });
  }

  candidates.sort((a, b) => b.score - a.score);

  const decided = [];
  let onCount = 0;
  let nameOnlyCount = 0;

  for (const c of candidates) {
    let state;
    if (calibrated) {
      // Jev's probabilities are calibrated against outcomes, so a threshold is
      // meaningful: 0.6 really is "more likely relevant than not".
      if (c.score >= cfg.thresholds.on && onCount < cfg.maxOn) {
        state = STATE_ON;
        onCount++;
      } else if (c.score >= cfg.thresholds.nameOnly && nameOnlyCount < cfg.maxNameOnly) {
        state = STATE_NAME_ONLY;
        nameOnlyCount++;
      } else {
        state = STATE_HIDDEN;
      }
    } else {
      // The local scorer emits ranks, not probabilities. Thresholding a rank is
      // meaningless, so take a fixed slice off the top instead, and require some
      // actual term overlap before hiding anything.
      if (onCount < cfg.maxOn && c.score > 0) {
        state = STATE_ON;
        onCount++;
      } else if (nameOnlyCount < cfg.maxNameOnly && c.score > 0) {
        state = STATE_NAME_ONLY;
        nameOnlyCount++;
      } else {
        state = STATE_HIDDEN;
      }
    }
    decided.push({ ...c, state, reason: calibrated ? "scored" : "ranked" });
  }

  const all = [...kept, ...decided];
  const overrides = {};
  for (const d of all) {
    if (d.state !== STATE_ON) overrides[d.skill.name] = d.state;
  }

  const savedTokens = all
    .filter((d) => d.state !== STATE_ON)
    .reduce((n, d) => n + (d.state === STATE_HIDDEN ? d.skill.approxTokens : Math.max(0, d.skill.approxTokens - 4)), 0);

  return {
    overrides,
    decisions: all.sort((a, b) => (b.score ?? 1) - (a.score ?? 1)),
    stats: {
      total: skills.length,
      on: all.filter((d) => d.state === STATE_ON).length,
      nameOnly: nameOnlyCount,
      hidden: all.filter((d) => d.state === STATE_HIDDEN).length,
      approxTokensBefore: skills.reduce((n, s) => n + s.approxTokens, 0),
      approxTokensSaved: savedTokens,
    },
  };
}

/**
 * Full pipeline: discover -> signals -> score -> plan.
 * Never throws for provider problems; degrades to the local scorer instead, so a
 * session can never end up with an empty skill manifest because a key expired.
 */
export async function buildPlan(cfg, { projectDir = process.cwd(), prompt = null, useCache = true } = {}) {
  const skills = discoverSkills({ projectDir });
  if (skills.length === 0) {
    return { skills, plan: planOverrides([], new Map(), cfg), provider: "none", cached: false, costUsd: 0 };
  }

  const state = withPrompt(collectSignals(projectDir), prompt);
  const key = cacheKey(skills, state, cfg);

  if (useCache) {
    const hit = readCache(key, cfg);
    if (hit) {
      return {
        skills,
        state,
        plan: planOverrides(skills, hit.scores, cfg, hit.meta),
        provider: hit.provider,
        cached: true,
        costUsd: 0,
      };
    }
  }

  const provider = resolveProvider(cfg);
  let result;
  let providerUsed;

  if (provider.kind === "disabled") {
    return { skills, state, plan: null, provider: "disabled", cached: false, costUsd: 0 };
  }

  if (provider.kind === "fallback") {
    if (provider.reason) log.info(`using local scorer: ${provider.reason}`);
    result = scoreLocally(skills, state);
    providerUsed = "fallback";
  } else {
    try {
      result = await scoreWithJev(skills, state, cfg, provider);
      providerUsed = provider.kind;
      log.debug(
        `jev scored ${result.scores.size} skills, ${result.usage.inputTokens} input tokens, ` +
          `$${result.costUsd.toFixed(6)}`
      );
    } catch (err) {
      log.warn(`${provider.kind} unavailable (${err.message}); falling back to local scorer`);
      result = scoreLocally(skills, state);
      providerUsed = "fallback";
    }
  }

  const meta = { calibrated: result.calibrated, signalStrength: result.signalStrength };
  if (useCache) writeCache(key, result.scores, providerUsed, meta);

  return {
    skills,
    state,
    plan: planOverrides(skills, result.scores, cfg, meta),
    provider: providerUsed,
    cached: false,
    costUsd: result.costUsd || 0,
    usage: result.usage,
  };
}
