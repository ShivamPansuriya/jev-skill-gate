import { log } from "./log.mjs";

/**
 * Jev returns one calibrated probability per question, all evaluated in parallel
 * against a single shared read of the state. That is the whole reason this works
 * cheaply: 200 skills is one request, not 200.
 *
 * Request shape (POST {base}/systemone):
 *   { state, model, questions: { <key>: { type: "noul", instructions } } }
 * Response:
 *   { model, answers: { <key>: { type: "noul", noul: 0.93 } }, usage: {...} }
 */

const RELEVANCE_PROMPT =
  "This skill is relevant to the work described in the state, and loading its " +
  "instructions would help complete that work.";

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildQuestions(skills) {
  const questions = {};
  const keyToName = new Map();
  skills.forEach((skill, i) => {
    const key = `q${i}`;
    keyToName.set(key, skill.name);
    questions[key] = {
      type: "noul",
      instructions: {
        claim: RELEVANCE_PROMPT,
        skill_name: skill.name,
        skill_description: skill.description || "(no description provided)",
      },
    };
  });
  return { questions, keyToName };
}

async function postWithRetry(url, body, headers, { timeoutMs, maxRetries }) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      // 4xx other than 429 will not get better by trying again.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (err.name === "AbortError") lastErr = new Error(`timed out after ${timeoutMs}ms`);
      if (String(err.message).startsWith("HTTP 4")) throw err;
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 400));
    }
  }
  throw lastErr;
}

function endpointFor(provider, cfg) {
  if (provider.kind === "gateway") {
    return {
      url: `${cfg.gatewayBaseUrl.replace(/\/$/, "")}/systemone`,
      model: cfg.gatewayModel,
      headers: { Authorization: `Bearer ${provider.apiKey}` },
    };
  }
  return {
    url: `${cfg.typesafeBaseUrl.replace(/\/$/, "")}/systemone`,
    model: cfg.model,
    headers: { Authorization: `Bearer ${provider.apiKey}` },
  };
}

/**
 * Scores every skill. Resolves to { scores: Map<name, 0..1>, usage, batches }.
 * Throws if the provider is unreachable; callers fall back to the local scorer.
 */
export async function scoreWithJev(skills, state, cfg, provider) {
  const { url, model, headers } = endpointFor(provider, cfg);
  const batches = chunk(skills, cfg.batchSize);
  log.debug(`jev: ${skills.length} skills in ${batches.length} batch(es) -> ${url}`);

  const results = await Promise.all(
    batches.map(async (batch) => {
      const { questions, keyToName } = buildQuestions(batch);
      const json = await postWithRetry(
        url,
        { state, model, questions },
        headers,
        { timeoutMs: cfg.timeoutMs, maxRetries: cfg.maxRetries }
      );
      return { json, keyToName };
    })
  );

  const scores = new Map();
  let inputTokens = 0;
  let outputTokens = 0;

  for (const { json, keyToName } of results) {
    const answers = json?.answers || {};
    for (const [key, name] of keyToName) {
      const a = answers[key];
      // `noul` is the documented field; `probability` is what the AI SDK
      // surfaces for the same primitive through the Gateway.
      const p = typeof a?.noul === "number" ? a.noul : typeof a?.probability === "number" ? a.probability : null;
      if (p !== null && Number.isFinite(p)) scores.set(name, Math.min(1, Math.max(0, p)));
    }
    inputTokens += json?.usage?.input_tokens || 0;
    outputTokens += json?.usage?.output_tokens || 0;
  }

  if (scores.size === 0) throw new Error("provider returned no usable answers");

  const missing = skills.length - scores.size;
  if (missing > 0) log.warn(`${missing} skill(s) got no answer; they keep full visibility`);

  return {
    scores,
    // RLCD optimises probabilities against outcomes, so these are calibrated and
    // a fixed threshold is a meaningful control surface.
    calibrated: true,
    signalStrength: Infinity,
    usage: { inputTokens, outputTokens, batches: batches.length },
    costUsd: (inputTokens / 1e6) * 0.042,
  };
}
