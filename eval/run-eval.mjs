#!/usr/bin/env node
/**
 * Discrimination eval for jev-skill-gate.
 *
 * The question this answers is not "does the API respond" but "does Jev rank
 * the right skills above the wrong ones, and what does gating cost in recall".
 *
 * Design notes:
 *  - State is the PROMPT ONLY. Real sessions also feed project signals, which
 *    make the task easier; isolating the prompt is the harder, cleaner test of
 *    whether the model discriminates.
 *  - Every case is scored ONCE and the raw scores are written to disk. Threshold
 *    sweeps then run offline for free, so the published numbers are reproducible
 *    without re-spending, and `--reuse` regenerates the report from saved scores.
 *  - Labels are validated against the live inventory before any request goes
 *    out. A renamed or mistyped skill fails the run instead of quietly counting
 *    as a miss and making the numbers look worse, or as absent and better.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverSkills } from "../src/discover.mjs";
import { scoreWithJev } from "../src/jev.mjs";
import { scoreLocally } from "../src/fallback.mjs";
import { loadConfig, resolveProvider } from "../src/config.mjs";
import { planOverrides } from "../src/gate.mjs";
import { setLogLevel } from "../src/log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW_PATH = join(HERE, "raw-scores.json");
const RESULTS_JSON = join(HERE, "results.json");
const RESULTS_MD = join(HERE, "RESULTS.md");

const args = process.argv.slice(2);
const REUSE = args.includes("--reuse");
const DELAY_MS = Number((args.find((a) => a.startsWith("--delay=")) || "--delay=3000").split("=")[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USE_LOCAL = args.includes("--local");
setLogLevel(args.includes("--verbose") ? "debug" : "silent");

const { cases } = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
const cfg = loadConfig({});
const skills = discoverSkills({ projectDir: process.env.HOME + "/.claude" });
const skillNames = new Set(skills.map((s) => s.name));

// ---------------------------------------------------------------- label check
const bad = [];
for (const c of cases) {
  for (const list of ["expected", "antiExpected"]) {
    for (const name of c[list] || []) {
      if (!skillNames.has(name)) bad.push(`${c.id}.${list}: "${name}" is not an installed skill`);
    }
  }
}
if (bad.length) {
  console.error("label validation failed:\n  " + bad.join("\n  "));
  process.exit(1);
}
console.log(`labels ok: ${cases.length} cases against ${skills.length} installed skills\n`);

// ------------------------------------------------------------------- scoring
async function scoreCase(c) {
  const state = { request: c.prompt };
  if (USE_LOCAL) return scoreLocally(skills, state);
  const provider = resolveProvider(cfg);
  if (provider.kind === "fallback") {
    throw new Error(`no API key: ${provider.reason}. Use --local to eval the fallback scorer.`);
  }
  return scoreWithJev(skills, state, cfg, provider);
}

let raw;
if (REUSE && existsSync(RAW_PATH)) {
  raw = JSON.parse(readFileSync(RAW_PATH, "utf8"));
  console.log(`reusing saved scores from ${RAW_PATH}\n`);
} else {
  // Resume by default: a quota error partway through a 20-case run must not
  // discard the cases that already cost money.
  const FRESH = args.includes("--fresh");
  raw =
    !FRESH && existsSync(RAW_PATH)
      ? JSON.parse(readFileSync(RAW_PATH, "utf8"))
      : { scoredAt: new Date().toISOString(), provider: null, skillCount: skills.length, cases: {} };
  raw.cases = raw.cases || {};
  let totalCost = raw.totals?.costUsd || 0;
  let totalIn = raw.totals?.inputTokens || 0;
  let first = true;
  for (const c of cases) {
    // Free-tier Jev rate-limits aggressively; pace the cases so a 20-case run
    // completes without burning retries.
    if (raw.cases[c.id]) {
      console.log(`scoring ${c.id} ... already have it, skipping`);
      continue;
    }
    if (!first) await sleep(DELAY_MS);
    first = false;
    process.stdout.write(`scoring ${c.id} ... `);
    let r;
    try {
      r = await scoreCase(c);
    } catch (err) {
      // Persist what we have, then stop cleanly so --reuse still works and a
      // later run resumes from here.
      raw.totals = { costUsd: totalCost, inputTokens: totalIn };
      writeFileSync(RAW_PATH, JSON.stringify(raw, null, 2) + "\n");
      console.log(`FAILED\n\n${err.message.slice(0, 200)}`);
      console.log(`\nkept ${Object.keys(raw.cases).length}/${cases.length} scored cases in ${RAW_PATH}`);
      console.log("re-run the same command to resume, or --reuse to report on what is there.");
      process.exit(2);
    }
    raw.provider = USE_LOCAL ? "fallback" : resolveProvider(cfg).kind;
    raw.cases[c.id] = {
      scores: Object.fromEntries(r.scores),
      usage: r.usage,
      costUsd: r.costUsd,
      calibrated: r.calibrated,
      signalStrength: Number.isFinite(r.signalStrength) ? r.signalStrength : null,
    };
    totalCost += r.costUsd || 0;
    totalIn += r.usage?.inputTokens || 0;
    console.log(`${r.scores.size} scored, ${r.usage?.latencyMs ?? "?"}ms, $${(r.costUsd || 0).toFixed(6)}`);
    raw.totals = { costUsd: totalCost, inputTokens: totalIn };
    writeFileSync(RAW_PATH, JSON.stringify(raw, null, 2) + "\n");
  }
  raw.totals = { costUsd: totalCost, inputTokens: totalIn };
  writeFileSync(RAW_PATH, JSON.stringify(raw, null, 2) + "\n");
  console.log(`\nraw scores -> ${RAW_PATH}  (total $${totalCost.toFixed(5)})\n`);
}

// ------------------------------------------------------------------- metrics
const tokensOf = new Map(skills.map((s) => [s.name, s.approxTokens]));
const totalTokens = skills.reduce((n, s) => n + s.approxTokens, 0);

function ranked(scoreObj) {
  return Object.entries(scoreObj).sort((a, b) => b[1] - a[1]);
}

/**
 * Pairwise AUC: over every (expected, antiExpected) pair, the share where the
 * expected skill scores strictly higher. 1.0 means perfect separation; 0.5 is
 * a coin flip. Ties count as half, the standard convention.
 */
function pairwiseAuc(scores, expected, anti) {
  let wins = 0;
  let total = 0;
  for (const e of expected) {
    for (const a of anti) {
      const se = scores[e];
      const sa = scores[a];
      if (se === undefined || sa === undefined) continue;
      total++;
      if (se > sa) wins++;
      else if (se === sa) wins += 0.5;
    }
  }
  return total === 0 ? null : wins / total;
}

const perCase = [];
for (const c of cases) {
  const entry = raw.cases[c.id];
  if (!entry) continue;
  const scores = entry.scores;
  const order = ranked(scores);
  const rankOf = new Map(order.map(([name], i) => [name, i + 1]));
  const values = order.map(([, v]) => v);

  const expRanks = (c.expected || []).map((n) => ({ name: n, rank: rankOf.get(n), score: scores[n] }));
  const antiRanks = (c.antiExpected || []).map((n) => ({ name: n, rank: rankOf.get(n), score: scores[n] }));
  const med = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

  perCase.push({
    id: c.id,
    adversarial: !!c.adversarial,
    prompt: c.prompt,
    auc: pairwiseAuc(scores, c.expected || [], c.antiExpected || []),
    expected: expRanks,
    antiExpected: antiRanks,
    medianExpectedRank: med(expRanks.map((x) => x.rank).filter(Boolean)),
    medianAntiRank: med(antiRanks.map((x) => x.rank).filter(Boolean)),
    expectedInTop10: expRanks.filter((x) => x.rank && x.rank <= 10).length,
    antiInTop10: antiRanks.filter((x) => x.rank && x.rank <= 10).length,
    top5: order.slice(0, 5).map(([n, v]) => ({ name: n, score: v })),
    dist: {
      min: Math.min(...values),
      p25: values[Math.floor(values.length * 0.75)],
      median: values[Math.floor(values.length * 0.5)],
      p75: values[Math.floor(values.length * 0.25)],
      max: Math.max(...values),
    },
  });
}

/**
 * Applies one gating configuration and measures recall against the labels.
 *
 * Which knob matters depends on the scorer. Jev's probabilities are calibrated,
 * so the thresholds decide. The local scorer emits ranks, so the planner ignores
 * thresholds and takes a fixed top-N slice - sweeping thresholds there would
 * produce an identical row every time and imply a tuning knob that does nothing.
 *
 * signalStrength comes from the scored entry, not a hardcoded Infinity, so the
 * weak-signal guard is exercised exactly as it would be in a real session.
 */
function sweepAt({ on, nameOnly, maxOn, maxNameOnly }) {
  let expOn = 0;
  let expVisible = 0;
  let expTotal = 0;
  let savedSum = 0;
  let hiddenSum = 0;
  let n = 0;
  let adversarialHidden = 0;
  let adversarialN = 0;
  const hiddenExpected = [];

  for (const c of cases) {
    const entry = raw.cases[c.id];
    if (!entry) continue;
    const scoreMap = new Map(Object.entries(entry.scores));
    const plan = planOverrides(
      skills,
      scoreMap,
      { ...cfg, thresholds: { on, nameOnly }, maxOn, maxNameOnly },
      {
        calibrated: entry.calibrated !== false,
        signalStrength: entry.signalStrength ?? Infinity,
      }
    );
    const state = new Map(plan.decisions.map((d) => [d.skill.name, d.state]));

    if (c.adversarial) {
      adversarialHidden += plan.stats.hidden;
      adversarialN++;
      continue;
    }
    for (const name of c.expected || []) {
      expTotal++;
      const st = state.get(name);
      if (st === "on") expOn++;
      if (st === "on" || st === "name-only") expVisible++;
      else hiddenExpected.push({ case: c.id, skill: name, score: entry.scores[name] });
    }
    savedSum += plan.stats.approxTokensSaved;
    hiddenSum += plan.stats.hidden;
    n++;
  }

  return {
    on,
    nameOnly,
    maxOn,
    maxNameOnly,
    hiddenExpected,
    recallOn: expTotal ? expOn / expTotal : 0,
    recallVisible: expTotal ? expVisible / expTotal : 0,
    meanTokensSaved: n ? Math.round(savedSum / n) : 0,
    meanSavedPct: n ? savedSum / n / totalTokens : 0,
    meanHidden: n ? Math.round(hiddenSum / n) : 0,
    meanAdversarialHidden: adversarialN ? Math.round(adversarialHidden / adversarialN) : 0,
  };
}

const anyCalibrated = Object.values(raw.cases).some((e) => e.calibrated !== false);
const grid = [];
if (anyCalibrated) {
  for (let on = 0.25; on <= 0.7001; on += 0.05) {
    grid.push(
      sweepAt({
        on: Number(on.toFixed(2)),
        nameOnly: Number(Math.max(0.05, on - 0.15).toFixed(2)),
        maxOn: cfg.maxOn,
        maxNameOnly: cfg.maxNameOnly,
      })
    );
  }
} else {
  for (const maxOn of [5, 10, 15, 20, 30, 40, 60]) {
    grid.push({ ...sweepAt({ ...cfg.thresholds, maxOn, maxNameOnly: cfg.maxNameOnly }), sweptBy: "maxOn" });
  }
}
const sweepKnob = anyCalibrated ? "threshold" : "maxOn";

const scored = perCase.filter((p) => !p.adversarial);
const aucs = scored.map((p) => p.auc).filter((x) => x !== null);
const summary = {
  generatedAt: new Date().toISOString(),
  provider: raw.provider,
  skillCount: skills.length,
  totalManifestTokens: totalTokens,
  caseCount: cases.length,
  scoredCaseCount: scored.length,
  meanAuc: aucs.reduce((a, b) => a + b, 0) / aucs.length,
  minAuc: Math.min(...aucs),
  perfectAucCases: aucs.filter((x) => x === 1).length,
  medianExpectedRank:
    [...scored.map((p) => p.medianExpectedRank).filter(Boolean)].sort((a, b) => a - b)[
      Math.floor(scored.length / 2)
    ] ?? null,
  totalAntiInTop10: scored.reduce((n, p) => n + p.antiInTop10, 0),
  evalCostUsd: raw.totals?.costUsd ?? null,
  grid,
};

writeFileSync(RESULTS_JSON, JSON.stringify({ summary, perCase }, null, 2) + "\n");

// -------------------------------------------------------------------- report
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const md = [];
md.push("# Eval results\n");
md.push(
  `Generated ${summary.generatedAt} · provider \`${summary.provider}\` · ` +
    `${summary.skillCount} installed skills (~${summary.totalManifestTokens} manifest tokens) · ` +
    `${summary.caseCount} cases · eval cost $${(summary.evalCostUsd ?? 0).toFixed(5)}\n`
);
md.push(
  "Reproduce: `node eval/run-eval.mjs` (re-scores, costs money) or `node eval/run-eval.mjs --reuse` " +
    "(recomputes every number from the committed `raw-scores.json`, free).\n"
);

md.push("## Headline\n");
md.push("| Metric | Value |");
md.push("| --- | --- |");
md.push(`| Mean pairwise AUC | **${summary.meanAuc.toFixed(3)}** |`);
md.push(`| Worst case AUC | ${summary.minAuc.toFixed(3)} |`);
md.push(`| Cases with perfect separation (AUC = 1.0) | ${summary.perfectAucCases} / ${scored.length} |`);
md.push(`| Median rank of an expected skill | ${summary.medianExpectedRank} of ${summary.skillCount} |`);
md.push(`| Irrelevant skills that reached any top 10 | ${summary.totalAntiInTop10} |`);
md.push("");
md.push(
  "AUC is the share of (expected, irrelevant) pairs where the expected skill scored higher. " +
    "1.0 is perfect separation, 0.5 is a coin flip.\n"
);

md.push(`## Sweep (by ${sweepKnob})\n`);
md.push(
  anyCalibrated
    ? "Scored once, swept offline. Jev's probabilities are calibrated, so the threshold is the knob.\n"
    : "Scored once, swept offline. The local scorer emits ranks, not probabilities, so the planner " +
        "takes a top-N slice and `maxOn` is the knob; thresholds do nothing here.\n"
);
md.push(
  "`recall (visible)` is the share of expected skills that survive gating as either a full description " +
    "or a name. `hidden on vague prompt` is how many skills get hidden for the two adversarial prompts - " +
    "low is good, it means a contentless prompt does not trigger confident hiding.\n"
);
const knobCol = anyCalibrated ? "on >= | name-only >=" : "maxOn | maxNameOnly";
md.push(`| ${knobCol} | recall (full desc) | recall (visible) | mean tokens saved | mean saved | hidden on vague prompt |`);
md.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const g of grid) {
  const knob = anyCalibrated ? `${g.on.toFixed(2)} | ${g.nameOnly.toFixed(2)}` : `${g.maxOn} | ${g.maxNameOnly}`;
  md.push(
    `| ${knob} | ${pct(g.recallOn)} | **${pct(g.recallVisible)}** | ` +
      `${g.meanTokensSaved} | ${pct(g.meanSavedPct)} | ${g.meanAdversarialHidden} |`
  );
}
md.push("");

// The honest disclosure: which labelled skills gating would have hidden at the
// shipped defaults. This is the silent failure mode, so it gets its own table.
const shipped = anyCalibrated
  ? grid.find((g) => Math.abs(g.on - cfg.thresholds.on) < 1e-6) || grid[grid.length - 1]
  : grid.find((g) => g.maxOn === cfg.maxOn) || grid[grid.length - 1];
md.push("## Skills gating would have hidden, at the shipped defaults\n");
if (!shipped.hiddenExpected.length) {
  md.push("None. Every labelled skill survived gating in every case.\n");
} else {
  md.push(
    `${shipped.hiddenExpected.length} of the labelled skills were pushed to \`user-invocable-only\`. ` +
      "They stay typable as `/name`, but Claude cannot see them. This is the failure mode that matters.\n"
  );
  md.push("| case | skill | score |");
  md.push("| --- | --- | --- |");
  for (const h of shipped.hiddenExpected) {
    md.push(`| \`${h.case}\` | \`${h.skill}\` | ${h.score?.toFixed(2) ?? "-"} |`);
  }
  md.push("");
}

md.push("## Per case\n");
md.push("| Case | AUC | median rank of expected | expected in top 10 | irrelevant in top 10 | score range |");
md.push("| --- | --- | --- | --- | --- | --- |");
for (const p of scored) {
  md.push(
    `| \`${p.id}\` | ${p.auc === null ? "n/a" : p.auc.toFixed(3)} | ${p.medianExpectedRank} | ` +
      `${p.expectedInTop10}/${p.expected.length} | ${p.antiInTop10} | ${p.dist.min.toFixed(2)}–${p.dist.max.toFixed(2)} |`
  );
}
md.push("");

md.push("## Detail\n");
for (const p of perCase) {
  md.push(`### \`${p.id}\`${p.adversarial ? " (adversarial)" : ""}\n`);
  md.push(`> ${p.prompt}\n`);
  md.push("Top 5 scored:\n");
  md.push("| # | skill | score |");
  md.push("| --- | --- | --- |");
  p.top5.forEach((t, i) => md.push(`| ${i + 1} | \`${t.name}\` | ${t.score.toFixed(2)} |`));
  md.push("");
  if (p.expected.length) {
    md.push("Expected skills:\n");
    md.push("| skill | rank | score |");
    md.push("| --- | --- | --- |");
    for (const e of p.expected) {
      md.push(`| \`${e.name}\` | ${e.rank ?? "unscored"} | ${e.score?.toFixed(2) ?? "-"} |`);
    }
    md.push("");
  }
}

writeFileSync(RESULTS_MD, md.join("\n") + "\n");

console.log(`mean AUC        ${summary.meanAuc.toFixed(3)}  (min ${summary.minAuc.toFixed(3)})`);
console.log(`perfect cases   ${summary.perfectAucCases}/${scored.length}`);
console.log(`median exp rank ${summary.medianExpectedRank} of ${summary.skillCount}`);
console.log(`anti in top10   ${summary.totalAntiInTop10}`);
console.log(`\nreport -> ${RESULTS_MD}\n`);
