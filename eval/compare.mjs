#!/usr/bin/env node
/**
 * Side-by-side comparison of the two scorers on the same labelled cases.
 *
 * The local scorer is free and needs no key, so the only honest way to justify
 * an API call is to show where it is actually better. This reads both saved
 * score files and reports per-case AUC, rank of each expected skill, and the
 * skills each scorer would have hidden.
 *
 *   node eval/compare.mjs            # reads raw-scores.json + raw-scores.local.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverSkills } from "../src/discover.mjs";
import { planOverrides } from "../src/gate.mjs";
import { loadConfig } from "../src/config.mjs";
import { setLogLevel } from "../src/log.mjs";

setLogLevel("silent");
const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig({});
const skills = discoverSkills({ projectDir: process.env.HOME + "/.claude" });
const { cases } = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));

const ARMS = [
  { key: "jev", label: "Jev", path: join(HERE, "raw-scores.json") },
  { key: "local", label: "Local TF-IDF", path: join(HERE, "raw-scores.local.json") },
];

const loaded = ARMS.filter((a) => existsSync(a.path)).map((a) => ({
  ...a,
  raw: JSON.parse(readFileSync(a.path, "utf8")),
}));

if (loaded.length < 2) {
  console.error("need both raw-scores.json and raw-scores.local.json; run each arm first");
  process.exit(1);
}

function auc(scores, expected, anti) {
  let wins = 0;
  let total = 0;
  for (const e of expected) {
    for (const a of anti) {
      if (scores[e] === undefined || scores[a] === undefined) continue;
      total++;
      if (scores[e] > scores[a]) wins++;
      else if (scores[e] === scores[a]) wins += 0.5;
    }
  }
  return total ? wins / total : null;
}

function analyse(arm) {
  const rows = [];
  const hidden = [];
  let aucSum = 0;
  let aucN = 0;

  for (const c of cases) {
    if (c.adversarial) continue;
    const entry = arm.raw.cases[c.id];
    if (!entry) continue;
    const scores = entry.scores;
    const order = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const rank = new Map(order.map(([n], i) => [n, i + 1]));

    const plan = planOverrides(skills, new Map(Object.entries(scores)), cfg, {
      calibrated: entry.calibrated !== false,
      signalStrength: entry.signalStrength ?? Infinity,
    });
    const state = new Map(plan.decisions.map((d) => [d.skill.name, d.state]));

    const a = auc(scores, c.expected, c.antiExpected);
    if (a !== null) {
      aucSum += a;
      aucN++;
    }
    const ranks = c.expected.map((n) => rank.get(n)).filter(Boolean);
    for (const n of c.expected) {
      if (state.get(n) === "user-invocable-only") hidden.push({ case: c.id, skill: n, score: scores[n] });
    }
    rows.push({
      id: c.id,
      auc: a,
      medianRank: ranks.length ? [...ranks].sort((x, y) => x - y)[Math.floor(ranks.length / 2)] : null,
      worstRank: ranks.length ? Math.max(...ranks) : null,
      saved: plan.stats.approxTokensSaved,
    });
  }
  return { rows, hidden, meanAuc: aucN ? aucSum / aucN : null, cases: rows.length };
}

const results = Object.fromEntries(loaded.map((a) => [a.key, analyse(a)]));
const common = results.jev.rows
  .filter((r) => results.local.rows.some((l) => l.id === r.id))
  .map((r) => r.id);

/**
 * Restrict every arm to the cases BOTH scored. One arm having more cases than
 * the other makes the summary an apples-to-oranges comparison: the arm with the
 * extra cases carries their scores into its mean, and the table silently
 * implies a head-to-head that never happened.
 */
function restrict(res) {
  const rows = res.rows.filter((r) => common.includes(r.id));
  const aucs = rows.map((r) => r.auc).filter((x) => x !== null);
  return {
    rows,
    hidden: res.hidden.filter((h) => common.includes(h.case)),
    meanAuc: aucs.length ? aucs.reduce((a, b) => a + b, 0) / aucs.length : null,
    cases: rows.length,
    allCases: res.cases,
    allMeanAuc: res.meanAuc,
  };
}
const jev = restrict(results.jev);
const loc = restrict(results.local);

const md = [];
md.push("# Jev vs the local scorer\n");
md.push(
  `Both arms restricted to the ${common.length} cases each scored, so this is a true head-to-head. ` +
    `Same ${skills.length} installed skills, same gating config, prompt-only state.\n`
);
md.push(
  `> The local scorer also ran the full ${results.local.cases}-case set ` +
    `(mean AUC ${results.local.meanAuc?.toFixed(3)}, in RESULTS.md). Only the overlap is compared here. ` +
    `The Jev arm stopped at ${results.jev.cases} cases when the free-tier quota ran out.\n`
);
md.push("| | Jev | Local TF-IDF |");
md.push("| --- | --- | --- |");
md.push(`| Cases scored | ${jev.cases} | ${loc.cases} |`);
md.push(
  `| Mean pairwise AUC | **${jev.meanAuc?.toFixed(3) ?? "-"}** | ${loc.meanAuc?.toFixed(3) ?? "-"} |`
);
md.push(`| Expected skills hidden | **${jev.hidden.length}** | ${loc.hidden.length} |`);
md.push(`| Cost per session | ~$0.0009 | $0 |`);
md.push("");

md.push("## Per case\n");
md.push("| Case | Jev AUC | Local AUC | Jev median rank | Local median rank | Jev worst rank | Local worst rank |");
md.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const id of common) {
  const j = jev.rows.find((r) => r.id === id);
  const l = loc.rows.find((r) => r.id === id);
  const f = (x) => (x === null || x === undefined ? "-" : typeof x === "number" && x <= 1 ? x.toFixed(3) : x);
  md.push(
    `| \`${id}\` | ${f(j.auc)} | ${f(l.auc)} | ${j.medianRank ?? "-"} | ${l.medianRank ?? "-"} | ` +
      `${j.worstRank ?? "-"} | ${l.worstRank ?? "-"} |`
  );
}
md.push("");

for (const [key, label] of [["jev", "Jev"], ["local", "Local TF-IDF"]]) {
  const h = results[key].hidden.filter((x) => common.includes(x.case));
  md.push(`## Skills ${label} would have hidden\n`);
  if (!h.length) {
    md.push("None.\n");
  } else {
    md.push("| case | skill | score |");
    md.push("| --- | --- | --- |");
    for (const x of h) md.push(`| \`${x.case}\` | \`${x.skill}\` | ${x.score?.toFixed(2) ?? "-"} |`);
    md.push("");
  }
}

writeFileSync(join(HERE, "COMPARISON.md"), md.join("\n") + "\n");
console.log(`Jev   mean AUC ${jev.meanAuc?.toFixed(3)}  hidden ${jev.hidden.length}  (${jev.cases} cases)`);
console.log(`Local mean AUC ${loc.meanAuc?.toFixed(3)}  hidden ${loc.hidden.length}  (${loc.cases} cases)`);
console.log(`\nreport -> ${join(HERE, "COMPARISON.md")}`);
