/**
 * The provider contract.
 *
 * A provider answers one question for every skill in a library: "would loading
 * this skill help with the work described in the state?" It returns a number in
 * [0,1] per skill. Everything else in this tool - thresholds, caps, caching,
 * writing skillOverrides - is provider-agnostic and lives elsewhere.
 *
 * Adding a provider means adding one file. Nothing else changes: no switch
 * statement to extend, no config schema to edit, no registry list to append to
 * for user plugins. Drop a module in ~/.claude/jev-skill-gate/providers/ and it
 * is available as `provider: "<its id>"`.
 *
 * ---------------------------------------------------------------------------
 * Two ways to implement one
 * ---------------------------------------------------------------------------
 *
 * 1. DECLARATIVE (preferred). Describe one HTTP request that scores a batch of
 *    skills, and how to read the reply. The shared runner handles batching,
 *    bounded concurrency, timeouts, Retry-After, and jittered backoff for you.
 *
 *      request({ questions, state, cfg, conf, apiKey }) -> { url, headers, body }
 *      readAnswers(json, questions) -> Map<questionKey, probability>
 *      readUsage?(json) -> { inputTokens?, outputTokens?, costUsd? }
 *
 * 2. IMPERATIVE (escape hatch). Implement `score` and own the whole flow. Use
 *    this when one HTTP request cannot express a scoring pass - an in-process
 *    model, a provider that needs one call per skill, a streaming protocol.
 *
 *      score({ skills, state, cfg, conf, apiKey, post }) -> ScoreResult
 *
 * A provider must implement exactly one of `request` or `score`.
 *
 * ---------------------------------------------------------------------------
 * Fields
 * ---------------------------------------------------------------------------
 *
 *   id            string, required. Config value and cache-key component.
 *                 Lowercase, [a-z0-9-]. Must be unique.
 *   label         string. Shown by `status` and `doctor`.
 *   local         boolean. True for something the user runs themselves. Local
 *                 providers are excluded from `provider: "auto"` discovery
 *                 unless explicitly configured, because we cannot know whether
 *                 a server is listening without paying for a probe.
 *   requiresKey   boolean. False for a localhost server with no auth.
 *   envKeys       string[]. Environment variables checked, in order, for the
 *                 API key. Environment always beats the config file.
 *   defaults      object. Merged under cfg.providers[id]. Conventionally
 *                 { baseUrl, model }. Surfaced by `config --list`.
 *   batchLimit    number. Maximum skills per request. The runner splits above
 *                 this regardless of cfg.batchSize.
 *   concurrency   number. Default parallel requests. Hosted providers rate
 *                 limit, so they say 1; a local server on your own GPU can
 *                 usually take more.
 *
 *   calibrated    boolean, required. THIS IS THE IMPORTANT ONE.
 *
 *     true  - the numbers are probabilities that mean the same thing across
 *             prompts, so a fixed threshold (`on: 0.6`) is a real control.
 *             Only claim this for a model trained to be calibrated.
 *     false - the numbers only rank. The planner ignores thresholds and slices
 *             the top N instead. A relevance score that is merely a similarity
 *             or a logit is NOT calibrated.
 *
 *     Claiming calibration you do not have is the one mistake here that
 *     silently hides skills the user needed, so the default is false.
 *
 *   costPerMillionInputUsd  number. 0 for anything self-hosted.
 *
 * ---------------------------------------------------------------------------
 * ScoreResult
 * ---------------------------------------------------------------------------
 *
 *   {
 *     scores:         Map<skillName, number in [0,1]>,
 *     calibrated:     boolean,
 *     separation?:    number,   // top score minus median, for the safety gate
 *     signalStrength?: number,
 *     usage:          { inputTokens, outputTokens, batches, latencyMs },
 *     costUsd:        number,
 *   }
 */

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validates and normalises a provider definition.
 *
 * Validation is strict and happens at load time rather than at first use. A
 * provider with a typo in a field name would otherwise fail on a real session,
 * mid-gate, where the only visible symptom is a silent fall back to the local
 * scorer.
 */
export function defineProvider(def) {
  const id = def?.id;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new Error(`provider id must match ${ID_RE} (got ${JSON.stringify(id)})`);
  }
  const hasRequest = typeof def.request === "function";
  const hasScore = typeof def.score === "function";
  if (hasRequest === hasScore) {
    throw new Error(`provider "${id}" must implement exactly one of request() or score()`);
  }
  if (hasRequest && typeof def.readAnswers !== "function") {
    throw new Error(`provider "${id}" implements request() so it must also implement readAnswers()`);
  }

  return {
    label: id,
    local: false,
    requiresKey: true,
    envKeys: [],
    defaults: {},
    batchLimit: 250,
    concurrency: 1,
    calibrated: false,
    costPerMillionInputUsd: 0,
    ...def,
  };
}

/** The claim every provider is asked to evaluate, per skill. */
export const RELEVANCE_CLAIM =
  "This skill is relevant to the work described in the state, and loading its " +
  "instructions would help complete that work.";

/** Trailing slashes in a user-supplied base URL are a perennial 404 source. */
export const trimBase = (url, fallback) => String(url || fallback).replace(/\/+$/, "");
