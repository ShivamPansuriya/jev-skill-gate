# Local providers: what was actually run

Every number here came from running the real project against the real model. No
mocks. Where a thing could not be tested, it says so.

Two machines:

- **Linux x86_64**, 31GB RAM, **no GPU**, Node 25.6.1
- **macOS 26.6.2 on Apple Silicon (arm64)**, Node 22.14.0

## Summary

| Provider | Model actually run | Verified end to end | Machine |
|---|---|---|---|
| `open-jev` | Open-Jev-2B (LoRA + decision head on `Qwen/Qwen3.5-2B`) | yes | Linux, CPU |
| `laya` | `convaiinnovations/laya`, 421M | yes, full 217-skill library | Linux, CPU |
| `laya-mlx` | `convaiinnovations/laya` via MLX | yes | macOS, Apple Silicon GPU |

The test suite (69 cases) passes on both machines.

## open-jev

Real server, real weights:

```
python -m jev.server --checkpoint models/Open-Jev-2B/package/checkpoint \
                     --device cpu --max-length 1024 --batch-size 8
```

The released checkpoint is a LoRA adapter plus a trained decision head and a
calibration temperature; the server pulls the pinned base revision
`15852e8c16360a2fea060d615a32b45270f8a8fc` of `Qwen/Qwen3.5-2B` (~5GB).

A direct probe, two questions against one state:

```json
{"answers": {"q0": {"type": "noul", "noul": 0.6649570105082212},
             "q1": {"type": "noul", "noul": 0.018438659357949843}},
 "model": "Qwen/Qwen3.5-2B",
 "usage": {"input_tokens": 163, "output_tokens": 0},
 "metadata": {"temperature": 1.518796342858676, "inference_seconds": 8.90358164999634}}
```

`q0` was `rust-build`, `q1` was `carrier-relationship-management`, against a
Rust borrow-checker prompt. The model separates them by a factor of 36.

Through the CLI, on a three-skill library:

```
[jev-skill-gate] open-jev: 3 skills in 1 batch(es)
[jev-skill-gate] open-jev scored 3 skills, 1819 input tokens, $0.000000
[jev-skill-gate] warn: scores do not separate (top 0.12 vs median 0.01); leaving every skill visible
  provider   open-jev
```

Two things worth noting. The `usage` block is read from the real reply, and the
separation guard fired and left every skill visible rather than hiding two on a
0.11 spread — the fail-open path working on real model output.

**Throughput is the practical limit, not the protocol.** About 4.5s per question
on a short state, rising to roughly 20s per question at the full project state
with `--max-length 1024`. A 217-skill library is therefore over an hour on CPU.
Use a GPU for a library that size; CPU is fine for trying it out.

### Three bugs this found that a mock server could not

1. **`usage` is returned.** `jev/api.py`'s `format_response` returns `{answers}`
   only, so reading the source says there is no usage block. `jev/serving.py`
   wraps it and adds `model`, `usage.input_tokens` and `metadata`. Reading the
   source was not enough; running it was.

2. **Node's `fetch` cannot be used for a slow local model.** Its undici
   `headersTimeout` is 300 seconds and core exposes no way to raise it per
   request. Batches that ran longer died as a bare `fetch failed` with the real
   cause (`UND_ERR_HEADERS_TIMEOUT`) buried in `err.cause`, no matter how large
   our own timeout was. `src/http.mjs` exists because of this: the runner posts
   over `node:http`, where the only clock is the one we set.

3. **A 20 second default timeout guaranteed failure.** Inherited from the hosted
   providers, where it is generous. Local providers now set their own.

## laya

`pip install laya`, CPU, full 217-skill library through the CLI:

```
  provider   laya
  skills     217 discovered
  verdict    47 full · 60 name-only · 110 hidden
  tokens     12750 -> 2087  (saved ~10663)

real 13m13s
```

Measured separately:

| | |
|---|---|
| Model load | ~69s per process |
| 2 questions | 1.7s |
| 16 questions | 2.7s |
| 32 / 64 / 128 questions | 13.5s / 29.2s / 61.1s |
| Peak RSS | 2.9GB, flat across batch sizes |

`system_one` evaluates every question in one collated forward pass, so cost is
linear in questions and the model load dominates a small run. That is why this
provider takes the whole library in one call and the runner does not chunk it:
chunking would pay the 69 second load once per chunk.

### What this found

- **`batchLimit` was decorative on `score()` providers.** The runner never
  applied it, so `laya` advertised 128 and received 217. Removed, with the
  reason written down.
- **A 300s timeout was not enough for a cold run** — first invocation downloads
  the checkpoint, then spends 69s loading it. It fell back to the local scorer,
  which is safe but wastes the download. Now 900s.
- `predict` is confirmed an alias of `system_one` (`agent.py:370`), and `load()`
  takes `device`, `subfolder` and `token`, which the provider now exposes.
- laya truncates the state at `max_len` (512 tokens), so it sees less context
  than a hosted call does.

## laya-mlx

Apple Silicon, macOS 26.6.2, installed with `uv pip install laya-mlx`
(mlx 0.32.2). Through the real CLI:

```
[jev-skill-gate] laya-mlx scored 3 skills, 402 input tokens, $0.000000
[jev-skill-gate] warn: scores do not separate (top 0.16 vs median 0.07); leaving every skill visible
  provider   laya-mlx
```

1.6s wall once the model is cached, with `--device gpu` passed through.

### Two bugs this found

1. **`--state-file` is a JSON file, not a text file.** `laya-mlx predict --help`
   says "JSON state file" and the CLI `json.loads` it. The provider wrote the
   state as bare text whenever it was a string, which is a parse error. It now
   always serialises.
2. **`--subfolder`, `--revision`, `--device`, `--dtype` and `--batch-size`
   existed and were not exposed.** All are configurable now.

Also confirmed: the CLI pretty-prints its JSON across many lines, so parsing
relies on `extractJson`'s whole-stream fallback rather than its last-line scan.
There is a test for exactly that shape.

## One test bug, found only on macOS

The fake local runtime used by `a local process provider is driven end to end`
had a `#!/usr/bin/env node` shebang. The Mac had a perfectly good Node that was
not on `PATH`, so the test failed for a reason unrelated to the code. It now
uses `process.execPath`.

## stuntd

[stuntd](https://github.com/bladedevoff/stuntd) v0.1 serves the Jev protocol
locally from the Laya checkpoint. Raised in issue #1; tested rather than taken
on trust.

```bash
pip install "stuntd[train]" && stuntd serve
jev-skill-gate config --provider typesafe --base-url http://127.0.0.1:8787/v1
```

Works with the existing `typesafe` provider, no code change:

```
[jev-skill-gate] typesafe: 3 skills in 1 batch(es)
[jev-skill-gate] typesafe scored 3 skills, 1536 input tokens, $0.000000
[jev-skill-gate] warn: scores do not separate (top 0.63 vs median 0.60); leaving every skill visible
```

It found one bug: the run was first reported as costing $0.000065, because the
`typesafe` provider's published rate was applied to a server on localhost. A
price belongs to a hosted service, not to a wire protocol, and the two come
apart the moment a base URL is repointed. A loopback endpoint is now free, and
`providers.<id>.costPerMillionInputUsd` overrides the rate for anything else.

The separation above is zero-shot Laya, which stuntd's own README is candid
about (38.2 against Jev's 76.4 on banking77's 77 intents). Its answer is to
train a head on your own traffic; that is unmeasured here.

## Not verified

- **Open-Jev on a GPU.** Everything here is CPU. The throughput figures say
  nothing about a GPU deployment beyond "it will be much faster".
- **Open-Jev 9B and 27B.** Only the 2B checkpoint was run.
- **laya-mlx on a full 217-skill library.** Verified end to end on a small
  library only; the borrowed Mac was cleaned up afterwards.
- **Ranking quality.** These runs prove the integrations work, not that any
  model ranks well. The one comparison worth recording: on a Rust prompt, the
  Open-Jev 2B checkpoint put `rust-build` at 0.665 against
  `carrier-relationship-management` at 0.018, while laya put the same pair at
  0.51 and 0.19 and ranked `rust-patterns` (0.15) below `video-editing` (0.21).
  Hosted Jev remains the accurate option; that is what the rest of `eval/`
  measures.
