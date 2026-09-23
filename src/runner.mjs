import { log } from "./log.mjs";
import { postJson, HttpError, isLocalUrl } from "./http.mjs";

/**
 * The provider-agnostic scoring runner.
 *
 * Every provider answers the same question - "is this skill worth its tokens
 * for this prompt?" - so batching, retries, backoff and usage accounting are
 * written once here rather than once per provider. A provider supplies either
 * one request shape (the common case) or its own `score` (a local process, or
 * anything else a single HTTP call cannot express).
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += Math.max(1, size)) out.push(arr.slice(i, i + Math.max(1, size)));
  return out;
}

/**
 * Runs tasks with bounded concurrency.
 *
 * Firing every batch at once is the obvious implementation and it is wrong:
 * free-tier hosted Jev rate-limits immediately, so a large skill library fails
 * on the very first run. Sequential by default costs a few hundred milliseconds
 * and always works; a provider that can take more says so.
 */
async function pooled(tasks, limit) {
  const out = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      out[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

export async function postWithRetry(url, body, headers, { timeoutMs, maxRetries }) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let retryAfterMs = null;
    try {
      return await postJson(url, body, headers, { timeoutMs });
    } catch (err) {
      // A 4xx that is not rate limiting will not get better by retrying. Open-Jev
      // answers a malformed request with 422, so retrying would just repeat it.
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;
      if (err instanceof HttpError && err.status === 429 && err.retryAfter) {
        const secs = Number(err.retryAfter);
        retryAfterMs = Number.isFinite(secs) ? secs * 1000 : Math.max(0, new Date(err.retryAfter) - Date.now());
      }
      lastErr = err;
    }
    if (attempt < maxRetries) {
      // Honour the server's own backoff when it gives one; otherwise exponential
      // with jitter so parallel callers do not retry in lockstep.
      const backoff = retryAfterMs ?? 2 ** attempt * 700 + Math.random() * 400;
      log.debug(`retry ${attempt + 1}/${maxRetries} in ${Math.round(backoff)}ms (${lastErr.message.slice(0, 80)})`);
      await sleep(Math.min(backoff, 30000));
    }
  }
  throw lastErr;
}

/**
 * Rough word count of the state, used only as the thin-input guard for
 * uncalibrated providers. Exactness does not matter; the threshold it feeds is
 * three words.
 */
function countStateTokens(state) {
  const text = typeof state === "string" ? state : JSON.stringify(state ?? "");
  return (text.match(/[a-z0-9_-]+/gi) || []).length;
}

/**
 * What one million input tokens costs on this run. An explicit per-provider
 * setting wins; otherwise a local endpoint is free and anything else pays the
 * provider's published rate.
 */
function ratePerMillion(provider, conf, endpoint) {
  if (typeof conf.costPerMillionInputUsd === "number") return conf.costPerMillionInputUsd;
  if (endpoint && isLocalUrl(endpoint)) return 0;
  return provider.costPerMillionInputUsd || 0;
}

/** One question per skill, with a stable key the provider echoes back. */
function buildQuestions(skills) {
  return skills.map((skill, i) => ({
    key: `q${i}`,
    name: skill.name,
    description: skill.description || "(no description provided)",
  }));
}

/**
 * Scores every skill with the resolved provider.
 *
 * `resolved` is what the registry returned: { id, provider, conf, apiKey }.
 * Throws on failure; the caller decides whether to degrade, and it always does.
 */
export async function scoreWithProvider(skills, state, cfg, resolved) {
  const { provider, conf, apiKey } = resolved;

  // A score() provider gets the whole library in one call and owns its own
  // batching. batchLimit is deliberately NOT applied here: for the local
  // providers this path exists to serve, each call is a fresh process paying a
  // model load - measured at ~69s for laya's 421M checkpoint - so chunking
  // would multiply the one genuinely expensive part of the run.
  if (typeof provider.score === "function") {
    const result = await provider.score({ skills, state, cfg, conf, apiKey, postWithRetry });
    if (!result?.scores?.size) throw new Error(`${provider.id} returned no usable answers`);
    return { costUsd: 0, ...result, calibrated: conf.calibrated ?? result.calibrated ?? provider.calibrated };
  }

  // A provider's batchLimit is a protocol fact, so it wins over the user's
  // preference rather than being averaged with it.
  const batchSize = Math.min(cfg.batchSize || 250, provider.batchLimit);
  const batches = chunk(buildQuestions(skills), batchSize);
  const started = Date.now();
  log.debug(`${provider.id}: ${skills.length} skills in ${batches.length} batch(es)`);

  let endpoint = null;
  const results = await pooled(
    batches.map((questions) => async () => {
      const { url, headers, body } = provider.request({ questions, state, cfg, conf, apiKey });
      endpoint = url;
      const json = await postWithRetry(url, body, headers || {}, {
        timeoutMs: conf.timeoutMs || cfg.timeoutMs,
        maxRetries: cfg.maxRetries,
      });
      return { json, questions };
    }),
    cfg.concurrency ?? provider.concurrency ?? 1
  );

  const scores = new Map();
  let inputTokens = 0;
  let outputTokens = 0;
  let reportedCost = 0;

  for (const { json, questions } of results) {
    const byKey = provider.readAnswers(json, questions) || new Map();
    const nameOf = new Map(questions.map((q) => [q.key, q.name]));
    for (const [key, value] of byKey) {
      const name = nameOf.get(key);
      if (name !== undefined && typeof value === "number" && Number.isFinite(value)) {
        scores.set(name, Math.min(1, Math.max(0, value)));
      }
    }
    const usage = provider.readUsage?.(json) || {};
    inputTokens += usage.inputTokens || 0;
    outputTokens += usage.outputTokens || 0;
    reportedCost += usage.costUsd || 0;
  }

  if (scores.size === 0) throw new Error(`${provider.id} returned no usable answers`);

  const missing = skills.length - scores.size;
  if (missing > 0) log.warn(`${missing} skill(s) got no answer; they keep full visibility`);

  const calibrated = conf.calibrated ?? provider.calibrated;
  return {
    scores,
    calibrated,
    // A calibrated provider's probabilities are comparable across prompts, so
    // the safety gate reads them directly and the thin-input check adds
    // nothing. An uncalibrated one keeps that check: its scores only rank, so
    // a near-empty state can still produce a confident-looking ordering.
    signalStrength: calibrated ? Infinity : countStateTokens(state),
    usage: { inputTokens, outputTokens, batches: batches.length, latencyMs: Date.now() - started },
    // Prefer a provider's own billing figure over list price, and never charge
    // list price for a server running on this machine.
    costUsd: reportedCost || (inputTokens / 1e6) * ratePerMillion(provider, conf, endpoint),
  };
}

export const _internal = { chunk, pooled, buildQuestions };
