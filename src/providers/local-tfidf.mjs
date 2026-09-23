import { defineProvider } from "./spec.mjs";
import { scoreLocally } from "../fallback.mjs";

/**
 * The no-dependency, no-network scorer: TF-IDF over the state against each
 * skill's name and description.
 *
 * This is the floor, not a choice. It is what runs when no provider is
 * configured and what every other provider degrades to when it fails, so that
 * a dead API key can never leave a session with an empty skill manifest.
 *
 * Its numbers are rank percentiles, not probabilities - the same skill scores
 * differently depending only on what else is in the library. Hence
 * calibrated: false, which makes the planner slice the top N instead of
 * applying thresholds. Measured AUC 0.948 against Jev's 1.000 on the same
 * cases (eval/COMPARISON.md).
 */
export default defineProvider({
  id: "fallback",
  label: "local TF-IDF (no network)",
  local: true,
  requiresKey: false,
  calibrated: false,
  costPerMillionInputUsd: 0,

  score({ skills, state }) {
    const started = Date.now();
    const result = scoreLocally(skills, state);
    return {
      ...result,
      usage: { inputTokens: 0, outputTokens: 0, batches: 0, latencyMs: Date.now() - started },
      costUsd: 0,
    };
  },
});
