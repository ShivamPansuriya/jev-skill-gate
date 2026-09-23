import { defineProvider, RELEVANCE_CLAIM } from "./spec.mjs";
import { run, withTempFiles, extractJson, layaQuestions, layaScores } from "./subprocess.mjs";

/**
 * laya-mlx (github.com/mizorewww/laya-mlx) - the same laya checkpoints ported
 * to Apple's MLX, so they run on the GPU of an Apple Silicon Mac.
 *
 * Apple Silicon and macOS 14+ only. Peak memory is well under a gigabyte for a
 * short question, which makes this the one option here that is comfortable on
 * a laptop with no discrete GPU.
 *
 * Unlike laya it does have a CLI, so no Python wrapper is needed:
 *
 *   laya-mlx predict --model <id|path> --state-file <path> --questions <path>
 *
 * The reply is the same shape laya produces: { answers: { id: { noul } } }.
 */
export default defineProvider({
  id: "laya-mlx",
  label: "laya-mlx (local, Apple Silicon)",
  local: true,
  requiresKey: false,
  defaults: {
    // `uv run laya-mlx` is the documented invocation; a plain `laya-mlx` works
    // once the package is on PATH. Both are expressed here as command + args so
    // neither needs a shell, and nothing in the config is ever interpreted by
    // one.
    command: "laya-mlx",
    args: [],
    model: "convaiinnovations/laya",
    // The repo bundles several checkpoints; "multilingual" is the other one.
    subfolder: null,
    revision: null,
    // gpu means Metal. null leaves the choice to laya-mlx.
    device: null,
    dtype: null,
    batchSize: null,
    // See laya.mjs: a cold first run pays a download plus a model load.
    timeoutMs: 900000,
  },
  // No batchLimit: score() providers are handed the whole library and the CLI
  // chunks internally at batch_size 16 anyway. Splitting here would only pay
  // the model load repeatedly. See laya.mjs for the measurements.
  concurrency: 1,
  calibrated: false, // see the note in laya.mjs - same checkpoints, same reasoning
  costPerMillionInputUsd: 0,

  async score({ skills, state, conf }) {
    const started = Date.now();
    const { questions, keyToName } = layaQuestions(skills, RELEVANCE_CLAIM);

    // --state-file is a JSON state file, not a text one: `laya-mlx predict
    // --help` says so, and it json.loads the contents. Writing a bare string
    // there is a parse error, so the state is always serialised - a plain
    // string becomes a quoted JSON string, which is what the CLI expects.
    const json = await withTempFiles(
      { "state.json": JSON.stringify(state), "questions.json": questions },
      async (paths) => {
        const args = [
          ...(conf.args || []),
          "predict",
          "--model",
          conf.model || "convaiinnovations/laya",
          "--state-file",
          paths["state.json"],
          "--questions",
          paths["questions.json"],
        ];
        // Only pass the optional flags that are actually configured; laya-mlx
        // has its own defaults and passing null through would be a parse error.
        for (const [flag, value] of [
          ["--subfolder", conf.subfolder],
          ["--revision", conf.revision],
          ["--device", conf.device],
          ["--dtype", conf.dtype],
          ["--batch-size", conf.batchSize],
        ]) {
          if (value !== null && value !== undefined && value !== "") args.push(flag, String(value));
        }
        const stdout = await run(conf.command || "laya-mlx", args, { timeoutMs: conf.timeoutMs || 900000 });
        // The CLI pretty-prints its JSON across many lines, so this relies on
        // extractJson's whole-stream fallback rather than its last-line scan.
        return extractJson(stdout);
      }
    );

    const scores = layaScores(json, keyToName);
    if (scores.size === 0) throw new Error("laya-mlx returned no usable answers");

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
