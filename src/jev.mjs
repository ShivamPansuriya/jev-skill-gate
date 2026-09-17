import { log } from "./log.mjs";

/**
 * Jev returns one calibrated probability per question, all evaluated in parallel
 * against a single shared read of the state. That is why this is cheap: 150
 * skills is one request, not 150.
 *
 * Two transports, verified live against Claude Code v2.1.274 / ai@7.0.105:
 *
 * TypeSafe direct
 *   POST {base}/systemone
 *   body    { state, model, questions: { k: { type: "noul", instructions } } }
 *   answer  { answers: { k: { noul: 0.93 } }, usage: { input_tokens } }
 *
 * Vercel AI Gateway
 *   POST {base}/v4/ai/evaluation-model
 *   header  ai-model-id, ai-evaluation-model-specification-version: 4
 *   body    { state, questions: { k: { type: "boolean", instructions } } }
 *   answer  { answers: { k: { probability: 0.99 } }, usage: { inputTokens } }
 *
 * The Gateway names the primitive "boolean" and puts the model in a header; the
 * direct API names it "noul" and puts the model in the body. Same model either
 * way.
 */

const RELEVANCE_CLAIM =
  "This skill is relevant to the work described in the state, and loading its " +
  "instructions would help complete that work.";

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildQuestions(skills, questionType) {
  const questions = {};
  const keyToName = new Map();
  skills.forEach((skill, i) => {
    const key = `q${i}`;
    keyToName.set(key, skill.name);
    questions[key] = {
      type: questionType,
      instructions: {
        claim: RELEVANCE_CLAIM,
        skill_name: skill.name,
        skill_description: skill.description || "(no description provided)",
      },
    };
  });
  return { questions, keyToName };
}

/** Per-transport request shape. */
function buildTransport(provider, cfg) {
  if (provider.kind === "gateway") {
    const base = (cfg.gateway.baseUrl || "https://ai-gateway.vercel.sh").replace(/\/+$/, "");
    return {
      url: `${base}/v4/ai/evaluation-model`,
      questionType: "boolean",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "ai-model-id": cfg.gateway.model || "typesafe-ai/jev",
        "ai-evaluation-model-specification-version": "4",
        "ai-gateway-protocol-version": "0.0.1",
      },
      body: (questions, state) => ({ state, questions, providerOptions: {} }),
    };
  }
  const base = (cfg.typesafe.baseUrl || "https://api.typesafe.ai/v1").replace(/\/+$/, "");
  return {
    url: `${base}/systemone`,
    questionType: "noul",
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    body: (questions, state) => ({ state, model: cfg.typesafe.model || "jev-latest", questions }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs tasks with bounded concurrency.
 *
 * Firing every batch at once is the obvious implementation and it is wrong:
 * free-tier Jev rate-limits immediately, so a large skill library fails on the
 * very first run. Sequential by default costs a few hundred milliseconds and
 * always works.
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

async function postWithRetry(url, body, headers, { timeoutMs, maxRetries }) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryAfterMs = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return await res.json();

      const text = await res.text().catch(() => "");
      // A 4xx that is not rate limiting will not get better by retrying.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      if (res.status === 429) {
        const hdr = res.headers.get("retry-after");
        if (hdr) {
          const secs = Number(hdr);
          retryAfterMs = Number.isFinite(secs) ? secs * 1000 : Math.max(0, new Date(hdr) - Date.now());
        }
      }
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    } catch (err) {
      clearTimeout(timer);
      if (/^HTTP 4(?!29)/.test(err.message)) throw err;
      lastErr = err.name === "AbortError" ? new Error(`timed out after ${timeoutMs}ms`) : err;
    }
    if (attempt < maxRetries) {
      // Honour the server's own backoff when it gives one; otherwise exponential
      // with jitter so parallel callers do not retry in lockstep.
      const backoff = retryAfterMs ?? 2 ** attempt * 700 + Math.random() * 400;
      log.debug(`retry ${attempt + 1}/${maxRetries} in ${Math.round(backoff)}ms (${lastErr.message.slice(0, 60)})`);
      await sleep(Math.min(backoff, 30000));
    }
  }
  throw lastErr;
}

/** Reads the probability out of either transport's answer shape. */
function readProbability(answer) {
  if (!answer || typeof answer !== "object") return null;
  for (const field of ["noul", "probability"]) {
    if (typeof answer[field] === "number" && Number.isFinite(answer[field])) {
      return Math.min(1, Math.max(0, answer[field]));
    }
  }
  return null;
}

export async function scoreWithJev(skills, state, cfg, provider) {
  const t = buildTransport(provider, cfg);
  const batches = chunk(skills, cfg.batchSize);
  log.debug(`jev: ${skills.length} skills in ${batches.length} batch(es) -> ${t.url}`);

  const started = Date.now();
  const results = await pooled(
    batches.map((batch) => async () => {
      const { questions, keyToName } = buildQuestions(batch, t.questionType);
      const json = await postWithRetry(t.url, t.body(questions, state), t.headers, {
        timeoutMs: cfg.timeoutMs,
        maxRetries: cfg.maxRetries,
      });
      return { json, keyToName };
    }),
    cfg.concurrency ?? 1
  );

  const scores = new Map();
  let inputTokens = 0;
  let outputTokens = 0;
  let reportedCost = 0;

  for (const { json, keyToName } of results) {
    const answers = json?.answers || {};
    for (const [key, name] of keyToName) {
      const p = readProbability(answers[key]);
      if (p !== null) scores.set(name, p);
    }
    const u = json?.usage || {};
    inputTokens += u.inputTokens ?? u.input_tokens ?? 0;
    outputTokens += u.outputTokens ?? u.output_tokens ?? 0;
    const gw = json?.providerMetadata?.gateway?.cost;
    if (gw) reportedCost += Number(gw) || 0;
  }

  if (scores.size === 0) throw new Error("provider returned no usable answers");

  const missing = skills.length - scores.size;
  if (missing > 0) log.warn(`${missing} skill(s) got no answer; they keep full visibility`);

  return {
    scores,
    // RLCD optimises probability against outcome, so these are calibrated and a
    // fixed threshold is a meaningful control surface.
    calibrated: true,
    signalStrength: Infinity,
    usage: { inputTokens, outputTokens, batches: batches.length, latencyMs: Date.now() - started },
    // Prefer the Gateway's own accounting; fall back to list price.
    costUsd: reportedCost || (inputTokens / 1e6) * 0.042,
  };
}

export const _internal = { buildTransport, buildQuestions, readProbability };
