/**
 * Example provider plugin: any chat model served by Ollama.
 *
 * Copy this file to ~/.claude/jev-skill-gate/providers/ and it becomes
 * `provider: "ollama"`. Nothing in the tool needs editing.
 *
 *   ollama serve
 *   ollama pull qwen2.5:3b
 *   cp examples/providers/ollama.mjs ~/.claude/jev-skill-gate/providers/
 *   jev-skill-gate config --provider ollama
 *   jev-skill-gate preview --prompt "fix my cargo build"
 *
 * ---------------------------------------------------------------------------
 * Read this before trusting it
 * ---------------------------------------------------------------------------
 *
 * This is a demonstration of the plugin interface, not a recommendation. A
 * general chat model asked to rate relevance is doing something quite different
 * from a decision model:
 *
 *   - It is not calibrated. A 0.8 from one prompt does not mean what a 0.8 from
 *     the next one means, which is why `calibrated: false` below is not
 *     modesty. The planner will rank and slice rather than apply thresholds.
 *   - It costs a generated token per skill, so a 200-skill library is a real
 *     amount of work rather than one forward pass.
 *   - It can return malformed JSON. Skills it fails to score keep full
 *     visibility, which is the safe direction but also means the saving is
 *     whatever survived parsing.
 *
 * Open-Jev, laya and laya-mlx are all purpose-built for this and ship as
 * built-in providers. Reach for this one when you already run Ollama and want
 * to try a model they do not cover.
 */

const CLAIM =
  "Rate how likely it is that loading this skill's instructions would help " +
  "with the work described in the state.";

export default {
  id: "ollama",
  label: "Ollama (any local chat model)",
  local: true,
  requiresKey: false,
  defaults: {
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen2.5:3b",
  },
  // Small models lose track of long numbered lists, and one bad batch costs
  // the accuracy of every skill in it. Twenty is conservative on purpose.
  batchLimit: 20,
  // Ollama serialises requests per model anyway, so more workers buys nothing.
  concurrency: 1,
  calibrated: false,
  costPerMillionInputUsd: 0,

  request({ questions, state, conf }) {
    const list = questions.map((q) => `${q.key}: ${q.name} — ${q.description}`).join("\n");
    const text = typeof state === "string" ? state : JSON.stringify(state);
    return {
      url: `${String(conf.baseUrl).replace(/\/+$/, "")}/api/chat`,
      headers: {},
      body: {
        model: conf.model,
        stream: false,
        // Ollama enforces the schema itself, which removes most of the
        // malformed-JSON problem that makes this approach fragile elsewhere.
        format: {
          type: "object",
          properties: Object.fromEntries(
            questions.map((q) => [q.key, { type: "number", minimum: 0, maximum: 1 }])
          ),
          required: questions.map((q) => q.key),
        },
        options: { temperature: 0 },
        messages: [
          { role: "system", content: `${CLAIM} Answer with a number in [0,1] for every id. No prose.` },
          { role: "user", content: `STATE:\n${text}\n\nSKILLS:\n${list}` },
        ],
      },
    };
  },

  readAnswers(json, questions) {
    const out = new Map();
    let parsed;
    try {
      parsed = JSON.parse(json?.message?.content ?? "{}");
    } catch {
      // Everything in this batch keeps full visibility. Wrong in the expensive
      // direction, not the silent one.
      return out;
    }
    for (const q of questions) {
      const v = Number(parsed[q.key]);
      if (Number.isFinite(v)) out.set(q.key, Math.min(1, Math.max(0, v)));
    }
    return out;
  },

  readUsage(json) {
    return { inputTokens: json?.prompt_eval_count || 0, outputTokens: json?.eval_count || 0 };
  },
};
