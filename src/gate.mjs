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

  // Thin evidence is the dangerous case: "fix it", or a brand-new directory,
  // gives the scorer nothing to go on, and a threshold pass would then hide
  // almost everything. Hiding is silent - Claude never learns the skill existed
  // - so with no real evidence we fail open instead.
  //
  // The test is whether the scores SEPARATE, not how long the input was. A
  // ten-word prompt that clearly points at Rust is strong evidence; a
  // two-hundred-word README that matches everything equally is not. Measuring
  // length instead of separation conflates the two, and treats every real
  // prompt as weak.
  const values = [...scores.values()].sort((a, b) => b - a);
  // A scorer that transforms its output (the local one emits rank-percentiles)
  // must report separation itself, measured on its raw similarities. Deriving it
  // from the transformed values would measure the transform, not the evidence.
  const separation =
    meta.separation ??
    (values.length > 1 ? values[0] - values[Math.floor(values.length / 2)] : 0);
  const minSeparation = cfg.safety?.minSeparation ?? 0.15;
  const tooShort = (meta.signalStrength ?? Infinity) < (cfg.safety?.minStateTokens ?? 3);

  if (tooShort || (values.length > 1 && separation < minSeparation)) {
    log.warn(
      tooShort
        ? "empty input; leaving every skill visible"
        : `scores do not separate (top ${values[0]?.toFixed(2)} vs median ` +
            `${values[Math.floor(values.length / 2)]?.toFixed(2)}); leaving every skill visible`
    );
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
      bailedOut: tooShort ? "empty-input" : "no-separation",
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

  // Caps scale with the library. A flat cap of 40 does nothing on a 54-skill
  // install - almost everything stays fully visible and the gate saves nothing.
  const ratio = (n, r, hard) => Math.max(3, Math.min(hard, Math.round(n * r)));
  const maxOn = ratio(skills.length, cfg.maxOnRatio ?? 0.2, cfg.maxOn);
  const maxNameOnly = ratio(skills.length, cfg.maxNameOnlyRatio ?? 0.3, cfg.maxNameOnly);

  const decided = [];
  let onCount = 0;
  let nameOnlyCount = 0;

  for (const c of candidates) {
    let state;
    if (calibrated) {
      // Jev's probabilities are calibrated against outcomes, so a threshold is
      // meaningful: 0.6 really is "more likely relevant than not".
      if (c.score >= cfg.thresholds.on && onCount < maxOn) {
        state = STATE_ON;
        onCount++;
      } else if (c.score >= cfg.thresholds.nameOnly && nameOnlyCount < maxNameOnly) {
        state = STATE_NAME_ONLY;
        nameOnlyCount++;
      } else {
        state = STATE_HIDDEN;
      }
    } else {
      // The local scorer emits ranks, not probabilities. Thresholding a rank is
      // meaningless, so take a fixed slice off the top instead, and require some
      // actual term overlap before hiding anything.
      if (onCount < maxOn && c.score > 0) {
        state = STATE_ON;
        onCount++;
      } else if (nameOnlyCount < maxNameOnly && c.score > 0) {
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
    // Scored skills first, highest first. Skills kept without a score (pinned,
    // unscored, or not model-invocable) sort last: they are not "best matches"
    // and listing them on top misrepresents the ranking.
    decisions: all.sort((a, b) => {
      if (a.score === null && b.score === null) return a.skill.name.localeCompare(b.skill.name);
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score;
    }),
    stats: {
      total: skills.length,
      on: all.filter((d) => d.state === STATE_ON).length,
      nameOnly: nameOnlyCount,
      hidden: all.filter((d) => d.state === STATE_HIDDEN).length,
      approxTokensBefore: skills.reduce((n, s) => n + s.approxTokens, 0),
      approxTokensSaved: savedTokens,
      maxOn,
      maxNameOnly,
      calibrated,
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
  const provider = resolveProvider(cfg);
  if (provider.kind === "disabled") {
    return { skills, state, plan: null, provider: "disabled", cached: false, costUsd: 0 };
  }
  // Keyed on the provider: a cached local-scorer result must not be served to a
  // run that now has an API key.
  const key = cacheKey(skills, state, cfg, provider.kind);

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

  let result;
  let providerUsed;

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

  const meta = {
    calibrated: result.calibrated,
    separation: result.separation,
    signalStrength: result.signalStrength,
  };
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
