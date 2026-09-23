import { defineProvider, RELEVANCE_CLAIM, trimBase } from "./spec.mjs";

/**
 * Open-Jev (github.com/Zefan-Cai/Open-Jev) - an open reimplementation of the
 * System One decision model that you run yourself.
 *
 * Start it with:
 *
 *   python -m jev.server --checkpoint models/Open-Jev-2B/package/checkpoint \
 *                        --device cuda:0 --max-length 4096
 *
 * It listens on 127.0.0.1:8791 and serves the same request off three aliased
 * paths (/v1/systemone, /v1/inference, /api/jev).
 *
 *   POST {base}/v1/systemone
 *   body   { model, state, questions: { q0: { type: "noul", instructions } } }
 *   reply  { answers: { q0: { type: "noul", noul: 0.84 } } }
 *
 * Differences from the hosted API that a base-URL swap alone would not survive,
 * all read off jev/server.py and jev/api.py rather than inferred:
 *
 *   1. The reply is api.py's `{answers}` wrapped by serving.py, which adds
 *      `model`, `usage.input_tokens` and a `metadata` block carrying the
 *      calibration temperature and `inference_seconds`. Token counts are read
 *      when present and default to zero; the cost is zero either way.
 *   2. Every question becomes an independent record with its own copy of the
 *      state and its own forward pass, so a batch here is a loop on the server
 *      rather than hosted Jev's single parallel read. Hence a batch limit of
 *      64 against the hosted 250: the work is linear in questions.
 *   3. Validation is strict and returns 422, not 4xx-with-a-retry. The body
 *      cap is 4MB, which a skill library does not come close to.
 *
 * `instructions` takes a string, an object or an array here - api.py renders
 * whatever it is - so the structured form the hosted API uses would be
 * accepted. Prose is used below because that is what the model was prompted
 * with: candidate_prompts drops the rendered instructions straight into a
 * "Question:" line, where a JSON blob reads worse than a sentence.
 *
 * There is no authentication. The server binds to localhost and rejects
 * cross-origin requests; anything beyond that is the operator's business, so
 * point `baseUrl` at a reverse proxy if it needs to leave the machine.
 */
export default defineProvider({
  id: "open-jev",
  label: "Open-Jev (self-hosted server)",
  local: true,
  requiresKey: false,
  envKeys: ["OPEN_JEV_API_KEY"],
  defaults: {
    baseUrl: "http://127.0.0.1:8791",
    path: "/v1/systemone",
    model: "open-jev",
    /**
     * Ten minutes, against the 20s the hosted providers use.
     *
     * This is not padding. Measured on the released 2B checkpoint on CPU, one
     * question is about 4.5 seconds, and questions are evaluated one at a time
     * - so a 64-question batch is minutes, and the whole library can be a
     * quarter of an hour on a first, uncached run. A GPU makes this far
     * quicker; the default has to survive the machine that does not have one.
     */
    timeoutMs: 600000,
  },
  /**
   * Sixteen, where the hosted providers use 250.
   *
   * Questions are evaluated one at a time - about 4.5 seconds each on the
   * released 2B checkpoint on CPU - and the server serialises requests behind a
   * lock. Total work is the same whatever the batch size, so this is about
   * granularity: a small batch fails fast and visibly, where a large one spends
   * five minutes inside one request before anything is known.
   *
   * It used to be a hard ceiling rather than a preference. Node's global fetch
   * caps a response at a 300 second headersTimeout that core does not let you
   * raise, so batches this slow died as a bare "fetch failed". src/http.mjs
   * exists because of that; the batch size no longer has to work around it.
   */
  batchLimit: 16,
  concurrency: 1,

  /**
   * The 2B checkpoint does ship a fitted calibration temperature - its
   * package/checkpoint/temperature.json records one scalar fitted on a 512-row
   * held-out split - and the server applies it before returning probabilities.
   * So these are not raw logits.
   *
   * It is still not the claim this flag makes. That temperature was fitted on
   * Open-Jev's own evaluation tasks, not on "is this skill worth its tokens for
   * this prompt", and a threshold is only meaningful if it transfers. Since the
   * failure mode of guessing wrong is a silently hidden skill, the planner
   * ranks and slices instead.
   *
   * Measure it on your own library and set `providers.open-jev.calibrated:
   * true` if it holds.
   */
  calibrated: false,
  costPerMillionInputUsd: 0,

  request({ questions, state, conf, apiKey }) {
    const body = {};
    for (const q of questions) {
      body[q.key] = {
        type: "noul",
        instructions:
          `${RELEVANCE_CLAIM}\n\n` +
          `Skill name: ${q.name}\n` +
          `Skill description: ${q.description}`,
      };
    }
    const base = trimBase(conf.baseUrl, "http://127.0.0.1:8791");
    const path = conf.path || "/v1/systemone";
    return {
      url: `${base}${path.startsWith("/") ? path : `/${path}`}`,
      // The server wants no auth, but a user who fronted it with a proxy will,
      // so a key is sent when one is configured and omitted otherwise.
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: { model: conf.model || "open-jev", state, questions: body },
    };
  },

  readAnswers(json, questions) {
    const answers = json?.answers || {};
    const out = new Map();
    for (const q of questions) {
      const p = answers[q.key]?.noul;
      if (typeof p === "number" && Number.isFinite(p)) out.set(q.key, Math.min(1, Math.max(0, p)));
    }
    return out;
  },

  readUsage(json) {
    // serving.py adds this on top of api.py's answers. Absent on a build that
    // returns format_response directly, where zero is honest and a guess is not.
    return {
      inputTokens: json?.usage?.input_tokens || 0,
      outputTokens: json?.usage?.output_tokens || 0,
    };
  },
});
