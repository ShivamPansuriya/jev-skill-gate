import { defineProvider, RELEVANCE_CLAIM, trimBase } from "./spec.mjs";

/**
 * The same Jev model, reached through Vercel's AI Gateway.
 *
 *   POST {base}/v4/ai/evaluation-model
 *   header ai-model-id, ai-evaluation-model-specification-version: 4
 *   body   { state, questions: { q0: { type: "boolean", instructions } } }
 *   reply  { answers: { q0: { probability: 0.99 } }, usage: { inputTokens } }
 *
 * It differs from the direct API on four counts, all verified live against
 * ai@7.0.105 by wrapping its fetch: the endpoint path, the primitive's name
 * ("boolean", not "noul"), where the model goes (header, not body), and the
 * casing of the usage fields. Same model, same numbers.
 */
export default defineProvider({
  id: "gateway",
  label: "Vercel AI Gateway (hosted Jev)",
  requiresKey: true,
  envKeys: ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_KEY"],
  defaults: {
    baseUrl: "https://ai-gateway.vercel.sh",
    model: "typesafe-ai/jev",
  },
  batchLimit: 250,
  concurrency: 1,
  calibrated: true,
  costPerMillionInputUsd: 0.042,

  request({ questions, state, conf, apiKey }) {
    const body = {};
    for (const q of questions) {
      body[q.key] = {
        type: "boolean",
        instructions: {
          claim: RELEVANCE_CLAIM,
          skill_name: q.name,
          skill_description: q.description,
        },
      };
    }
    return {
      url: `${trimBase(conf.baseUrl, "https://ai-gateway.vercel.sh")}/v4/ai/evaluation-model`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "ai-model-id": conf.model || "typesafe-ai/jev",
        "ai-evaluation-model-specification-version": "4",
        "ai-gateway-protocol-version": "0.0.1",
      },
      body: { state, questions: body, providerOptions: {} },
    };
  },

  readAnswers(json, questions) {
    const answers = json?.answers || {};
    const out = new Map();
    for (const q of questions) {
      const p = answers[q.key]?.probability;
      if (typeof p === "number" && Number.isFinite(p)) out.set(q.key, Math.min(1, Math.max(0, p)));
    }
    return out;
  },

  readUsage(json) {
    return {
      inputTokens: json?.usage?.inputTokens || 0,
      outputTokens: json?.usage?.outputTokens || 0,
      // The Gateway bills and reports its own figure; prefer it over list price.
      costUsd: Number(json?.providerMetadata?.gateway?.cost) || 0,
    };
  },
});
