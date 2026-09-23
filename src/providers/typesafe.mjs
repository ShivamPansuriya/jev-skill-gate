import { defineProvider, RELEVANCE_CLAIM, trimBase } from "./spec.mjs";

/**
 * TypeSafe Jev, called directly.
 *
 *   POST {base}/systemone
 *   body   { state, model, questions: { q0: { type: "noul", instructions } } }
 *   reply  { answers: { q0: { noul: 0.93 } }, usage: { input_tokens } }
 *
 * Jev evaluates every question in one parallel pass against a single read of
 * the state, which is why scoring 250 skills costs one request rather than 250.
 */
export default defineProvider({
  id: "typesafe",
  label: "TypeSafe Jev (hosted)",
  requiresKey: true,
  envKeys: ["TYPESAFE_API_KEY", "TYPESAFE_AI_API_KEY"],
  defaults: {
    baseUrl: "https://api.typesafe.ai/v1",
    model: "jev-latest",
  },
  // Jev accepts up to 255 options per Choice; questions share that ceiling.
  batchLimit: 250,
  concurrency: 1,
  // Trained with RLCD against outcomes, so the probabilities are comparable
  // across prompts and a fixed threshold means something.
  calibrated: true,
  costPerMillionInputUsd: 0.042,

  request({ questions, state, conf, apiKey }) {
    const body = {};
    for (const q of questions) {
      body[q.key] = {
        type: "noul",
        instructions: {
          claim: RELEVANCE_CLAIM,
          skill_name: q.name,
          skill_description: q.description,
        },
      };
    }
    return {
      url: `${trimBase(conf.baseUrl, "https://api.typesafe.ai/v1")}/systemone`,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: { state, model: conf.model || "jev-latest", questions: body },
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
    return {
      inputTokens: json?.usage?.input_tokens || 0,
      outputTokens: json?.usage?.output_tokens || 0,
    };
  },
});
