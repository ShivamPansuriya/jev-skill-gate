import { defineProvider, RELEVANCE_CLAIM } from "./spec.mjs";
import { run, withTempFiles, extractJson, layaQuestions, layaScores } from "./subprocess.mjs";

/**
 * laya (github.com/NandhaKishorM/laya) - an open System One model, 421M
 * parameters, running on CUDA, MPS or CPU.
 *
 *   pip install laya
 *
 * It ships no server and no CLI, only a Python API:
 *
 *   agent = laya.load("convaiinnovations/laya")
 *   agent.predict(state, questions)
 *
 * So this provider runs Python. The script below is the smallest wrapper that
 * turns that library call into a JSON document on stdout. It is embedded
 * rather than shipped as a .py file so that an update can never leave a stale
 * script paired with new calling code.
 *
 * The cost of a subprocess is a model load per invocation, which on a 421M
 * checkpoint is seconds, not milliseconds. That is tolerable because the gate
 * runs once per session and caches for a week. If it is not tolerable for you,
 * run Open-Jev's server instead and keep the model resident.
 *
 * One limit worth knowing: laya truncates the state at its `max_len` (512
 * tokens by default). Project signals are ordered most-specific-first, so the
 * request and the recent commits survive and a long README excerpt is what gets
 * cut - the right way round, but it does mean this sees less context than a
 * hosted call does.
 */

const SCRIPT = `
import json, sys
import laya

payload = json.load(open(sys.argv[1]))
agent = laya.load(
    payload["model"],
    device=payload.get("device"),
    subfolder=payload.get("subfolder"),
    token=payload.get("token"),
)
result = agent.system_one(payload["state"], payload["questions"])
sys.stdout.write("\\n" + json.dumps(result))
`;

export default defineProvider({
  id: "laya",
  label: "laya (local Python model)",
  local: true,
  requiresKey: false,
  defaults: {
    python: "python3",
    model: "convaiinnovations/laya",
    // null lets laya pick: cuda, then mps, then cpu.
    device: null,
    // The repo bundles several checkpoints; "multilingual" is the other one.
    subfolder: null,
    token: null,
    /**
     * Fifteen minutes. Generous because the first run is the expensive one: it
     * downloads the checkpoint, and then loading it costs about 69 seconds on
     * CPU before a single question is scored. A 300 second budget looked ample
     * and was not - a cold 217-skill run overran it and fell back to the local
     * scorer, which is safe but silently wastes the download.
     */
    timeoutMs: 900000,
  },
  // No batchLimit: this provider implements score(), so it receives the whole
  // library in one call by design and the runner does not chunk it. That is
  // the right trade here - system_one evaluates every question in one collated
  // forward pass, measured at a flat 2.9GB RSS and about 0.48s per question on
  // CPU, so 217 skills is roughly 100 seconds of linear work against a 69
  // second model load that chunking would pay again for every chunk.
  concurrency: 1,

  /**
   * laya does apply learned temperature scaling per question type before it
   * returns a probability, so these are not raw logits. That is calibration of
   * a kind, and it is still not the claim this flag makes: what matters here is
   * whether a 0.6 cutoff means the same thing on this skill library as it does
   * on hosted Jev, and nobody has measured that. The failure mode of guessing
   * wrong - silently hiding a skill the user needed - is invisible, so the
   * planner ranks and slices instead.
   *
   * Measure your own and set `providers.laya.calibrated: true` if it holds.
   */
  calibrated: false,
  costPerMillionInputUsd: 0,

  async score({ skills, state, conf }) {
    const started = Date.now();
    const { questions, keyToName } = layaQuestions(skills, RELEVANCE_CLAIM);
    const payload = {
      model: conf.model || "convaiinnovations/laya",
      device: conf.device ?? null,
      subfolder: conf.subfolder ?? null,
      token: conf.token ?? null,
      state,
      questions,
    };

    const json = await withTempFiles({ "payload.json": payload }, async (paths) => {
      const stdout = await run(conf.python || "python3", ["-c", SCRIPT, paths["payload.json"]], {
        timeoutMs: conf.timeoutMs || 900000,
      });
      return extractJson(stdout);
    });

    const scores = layaScores(json, keyToName);
    if (scores.size === 0) throw new Error("laya returned no usable answers");

    return {
      scores,
      calibrated: false,
      usage: {
        inputTokens: json?.usage?.input_tokens || 0,
        outputTokens: json?.usage?.output_tokens || 0,
        batches: 1,
        latencyMs: Date.now() - started,
      },
      costUsd: 0,
    };
  },
});
