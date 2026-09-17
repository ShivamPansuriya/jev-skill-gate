// Stats and config write under CLAUDE_CONFIG_DIR. Re-exec once into a throwaway
// directory so a test run can never touch the real ~/.claude state.
import { mkdtempSync as _mkdtemp } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
import { join as _join } from "node:path";
if (!process.env.JEV_TEST_SANDBOX) {
  const { spawnSync } = await import("node:child_process");
  const sandbox = _mkdtemp(_join(_tmpdir(), "jev-test-home-"));
  const r = spawnSync(process.execPath, [process.argv[1]], {
    stdio: "inherit",
    env: { ...process.env, JEV_TEST_SANDBOX: "1", CLAUDE_CONFIG_DIR: sandbox },
  });
  process.exit(r.status ?? 1);
}

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { _internal } from "../src/discover.mjs";
import { planOverrides, STATE_ON, STATE_NAME_ONLY, STATE_HIDDEN } from "../src/gate.mjs";
import { scoreLocally } from "../src/fallback.mjs";
import { readJsonFile, writeJsonAtomic } from "../src/settings.mjs";
import { DEFAULTS, resolveProvider, maskKey } from "../src/config.mjs";
import { _internal as jevInternal } from "../src/jev.mjs";
import { setLogLevel } from "../src/log.mjs";
import { readStats, recordRun, resetStats } from "../src/stats.mjs";
import { cacheKey } from "../src/cache.mjs";
import { runMigrations, readStateVersion, STATE_VERSION, STATE_VERSION_FILE } from "../src/migrate.mjs";
import { compareVersions } from "../src/update.mjs";

setLogLevel("silent");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

const cfg = (patch = {}) => ({
  ...DEFAULTS,
  ...patch,
  thresholds: { ...DEFAULTS.thresholds, ...(patch.thresholds || {}) },
  gateway: { ...DEFAULTS.gateway, ...(patch.gateway || {}) },
  typesafe: { ...DEFAULTS.typesafe, ...(patch.typesafe || {}) },
});
const skill = (name, description = "does a thing", extra = {}) => ({
  name,
  bare: name,
  description,
  approxTokens: Math.round((name.length + description.length + 4) / 3.8),
  modelInvocable: true,
  userInvocable: true,
  source: "personal",
  ...extra,
});

console.log("\nfrontmatter");

test("parses name and description", () => {
  const fm = _internal.parseFrontmatter("---\nname: foo\ndescription: Does a thing\n---\nbody");
  assert.equal(fm.name, "foo");
  assert.equal(fm.description, "Does a thing");
});

test("joins a folded multi-line description", () => {
  const fm = _internal.parseFrontmatter(
    "---\nname: foo\ndescription: >\n  first line\n  second line\nlicense: MIT\n---\n"
  );
  assert.equal(fm.description, "first line second line");
  assert.equal(fm.license, "MIT");
});

test("returns null without frontmatter", () => {
  assert.equal(_internal.parseFrontmatter("# just a heading\n"), null);
});

console.log("\nplanner");

test("never emits the off state", () => {
  const skills = Array.from({ length: 20 }, (_, i) => skill(`s${i}`));
  const scores = new Map(skills.map((s, i) => [s.name, i / 20]));
  const { overrides } = planOverrides(skills, scores, cfg());
  assert.ok(Object.keys(overrides).length > 0, "expected some overrides");
  for (const v of Object.values(overrides)) {
    assert.notEqual(v, "off", "off would hide the skill from the user's own slash menu");
  }
});

test("on is implied by absence, so it is never written", () => {
  const skills = [skill("high"), skill("low")];
  const scores = new Map([["high", 0.95], ["low", 0.01]]);
  const { overrides } = planOverrides(skills, scores, cfg());
  assert.equal(overrides.high, undefined);
  assert.equal(overrides.low, STATE_HIDDEN);
});

test("alwaysOn survives a zero score", () => {
  const skills = [skill("pinned"), skill("other")];
  const scores = new Map([["pinned", 0], ["other", 0]]);
  const { decisions } = planOverrides(skills, scores, cfg({ alwaysOn: ["pinned"] }));
  assert.equal(decisions.find((d) => d.skill.name === "pinned").state, STATE_ON);
});

test("ignored skills get no override at all", () => {
  const skills = [skill("skipme"), skill("other")];
  const scores = new Map([["skipme", 0], ["other", 0]]);
  const { overrides } = planOverrides(skills, scores, cfg({ ignore: ["skipme"] }));
  assert.equal("skipme" in overrides, false);
});

test("an unscored skill keeps full visibility", () => {
  const skills = [skill("scored"), skill("missing")];
  const scores = new Map([["scored", 0.9]]);
  const { decisions } = planOverrides(skills, scores, cfg());
  assert.equal(decisions.find((d) => d.skill.name === "missing").state, STATE_ON);
});

test("a skill Claude cannot auto-invoke is left alone", () => {
  const skills = [skill("userOnly", "x", { modelInvocable: false })];
  const { overrides } = planOverrides(skills, new Map([["userOnly", 0]]), cfg());
  assert.deepEqual(overrides, {});
});

test("maxOn caps full descriptions even when many skills clear the threshold", () => {
  const skills = Array.from({ length: 30 }, (_, i) => skill(`s${i}`));
  // All above thresholds.on, but separated, so the guard does not fire and the
  // cap is what limits the result.
  const scores = new Map(skills.map((s, i) => [s.name, 0.99 - i * 0.012]));
  const { stats } = planOverrides(skills, scores, cfg({ maxOn: 5 }));
  assert.equal(stats.on, 5);
});

test("undifferentiated scores fail open instead of hiding everything", () => {
  const skills = Array.from({ length: 10 }, (_, i) => skill(`s${i}`));
  // Everything scores the same: no evidence, so nothing may be hidden.
  const scores = new Map(skills.map((s) => [s.name, 0.4]));
  const res = planOverrides(skills, scores, cfg(), { calibrated: true, signalStrength: 500 });
  assert.equal(res.bailedOut, "no-separation");
  assert.deepEqual(res.overrides, {});
  assert.equal(res.stats.hidden, 0);
});

test("a short but discriminating prompt is NOT treated as weak", () => {
  // Ten words pointing clearly at one skill is strong evidence. Judging by
  // input length instead of separation would wrongly bail here.
  const skills = Array.from({ length: 20 }, (_, i) => skill(`s${i}`));
  const scores = new Map(skills.map((s, i) => [s.name, i < 3 ? 0.9 : 0.1]));
  const res = planOverrides(skills, scores, cfg(), { calibrated: true, signalStrength: 9 });
  assert.equal(res.bailedOut, undefined);
  assert.ok(res.stats.hidden > 0, "should gate when scores clearly separate");
});

test("an empty prompt fails open", () => {
  const skills = Array.from({ length: 10 }, (_, i) => skill(`s${i}`));
  const scores = new Map(skills.map((s, i) => [s.name, i === 0 ? 0.9 : 0.1]));
  const res = planOverrides(skills, scores, cfg(), { calibrated: true, signalStrength: 1 });
  assert.equal(res.bailedOut, "empty-input");
});

test("uncalibrated scores take a rank slice, not a threshold", () => {
  const skills = Array.from({ length: 10 }, (_, i) => skill(`s${i}`));
  // Every score sits below thresholds.on; a threshold pass would hide them all.
  // Spread far enough that the separation guard does not fire.
  const scores = new Map(skills.map((s, i) => [s.name, i / 10]));
  const res = planOverrides(skills, scores, cfg({ maxOn: 3, maxNameOnly: 3 }), {
    calibrated: false,
    signalStrength: 500,
  });
  assert.equal(res.stats.on, 3, "top slice should stay fully visible");
  assert.equal(res.stats.nameOnly, 3);
});

console.log("\nlocal scorer");

test("ranks an on-topic skill above an unrelated one", () => {
  const skills = [
    skill("rust-testing", "Rust testing patterns with cargo test and proptest"),
    skill("carrier-relationship-management", "Freight carrier scorecards and rate negotiation"),
  ];
  const { scores, calibrated } = scoreLocally(skills, { stack: ["rust"], readme_excerpt: "a cargo crate with proptest" });
  assert.equal(calibrated, false, "cosine ranks must not be reported as calibrated");
  assert.ok(scores.get("rust-testing") > scores.get("carrier-relationship-management"));
});

test("zero term overlap scores zero, not last place", () => {
  const skills = [skill("alpha", "zzzz"), skill("beta", "yyyy")];
  const { scores } = scoreLocally(skills, { readme_excerpt: "completely unrelated wording" });
  assert.equal(scores.get("alpha"), 0);
  assert.equal(scores.get("beta"), 0);
});

console.log("\njev transport");

test("gateway posts to the evaluation-model path with the model in a header", () => {
  const t = jevInternal.buildTransport({ kind: "gateway", apiKey: "k" }, cfg());
  assert.equal(t.url, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
  assert.equal(t.headers["ai-model-id"], "typesafe-ai/jev");
  assert.equal(t.headers["ai-evaluation-model-specification-version"], "4");
  // The Gateway names the primitive "boolean"; sending "noul" there is rejected.
  assert.equal(t.questionType, "boolean");
  assert.equal(t.body({}, "s").model, undefined, "gateway takes the model from the header");
});

test("typesafe direct posts to /systemone with the model in the body", () => {
  const t = jevInternal.buildTransport({ kind: "typesafe", apiKey: "k" }, cfg());
  assert.equal(t.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(t.questionType, "noul");
  assert.equal(t.body({}, "s").model, "jev-latest");
});

test("a custom baseUrl is honoured and trailing slashes are trimmed", () => {
  const t = jevInternal.buildTransport(
    { kind: "gateway", apiKey: "k" },
    cfg({ gateway: { baseUrl: "https://proxy.internal/", model: "typesafe-ai/jev" } })
  );
  assert.equal(t.url, "https://proxy.internal/v4/ai/evaluation-model");
});

test("reads the probability from either transport's answer shape", () => {
  assert.equal(jevInternal.readProbability({ noul: 0.93 }), 0.93);
  assert.equal(jevInternal.readProbability({ probability: 0.99 }), 0.99);
  assert.equal(jevInternal.readProbability({ choice: "x" }), null);
  assert.equal(jevInternal.readProbability(undefined), null);
  assert.equal(jevInternal.readProbability({ probability: 1.4 }), 1, "clamped");
});

test("every skill gets its own question key and the map inverts", () => {
  const skills = [skill("a"), skill("b"), skill("c")];
  const { questions, keyToName } = jevInternal.buildQuestions(skills, "boolean");
  assert.equal(Object.keys(questions).length, 3);
  assert.equal(keyToName.get("q0"), "a");
  // Skill names contain ':' and '-'; opaque keys keep them out of the wire format.
  assert.ok(Object.keys(questions).every((k) => /^q\d+$/.test(k)));
});

console.log("\nprovider resolution");

test("env key beats a config-file key", () => {
  const prev = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "from-env";
  try {
    const p = resolveProvider(cfg({ provider: "gateway", gateway: { apiKey: "from-file" } }));
    assert.equal(p.apiKey, "from-env");
  } finally {
    if (prev === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = prev;
  }
});

test("a config-file key is used when no env var is set", () => {
  const prev = process.env.AI_GATEWAY_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  try {
    const p = resolveProvider(cfg({ provider: "gateway", gateway: { apiKey: "from-file" } }));
    assert.equal(p.kind, "gateway");
    assert.equal(p.apiKey, "from-file");
  } finally {
    if (prev !== undefined) process.env.AI_GATEWAY_API_KEY = prev;
  }
});

test("no key anywhere degrades to the local scorer rather than failing", () => {
  const prev = { g: process.env.AI_GATEWAY_API_KEY, t: process.env.TYPESAFE_API_KEY };
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const p = resolveProvider(cfg({ provider: "gateway" }));
    assert.equal(p.kind, "fallback");
    assert.match(p.reason, /Gateway key/);
  } finally {
    if (prev.g !== undefined) process.env.AI_GATEWAY_API_KEY = prev.g;
    if (prev.t !== undefined) process.env.TYPESAFE_API_KEY = prev.t;
  }
});

test("maskKey never reveals the middle of a key", () => {
  const masked = maskKey("vck_EXAMPLEnotarealkeyEXAMPLE1234567");
  assert.ok(!masked.includes("notarealkey"));
  assert.equal(maskKey(null), "(unset)");
});

console.log("\nregressions from a 54-skill install");

test("separation is judged on raw similarity, not the rank ramp", () => {
  // Rank-percentiles always run 1.00 -> 0.00, so their top-vs-median gap is ~0.5
  // whatever the evidence. Identical descriptions are zero evidence and must
  // still trip the guard.
  const skills = Array.from({ length: 54 }, (_, i) => skill(`s${i}`, "identical wording for every single skill here"));
  const r = scoreLocally(skills, { request: "identical wording for every single skill here" });
  const ramp = [...r.scores.values()].sort((a, b) => b - a);
  assert.ok(ramp[0] - ramp[27] > 0.4, "the ramp itself always looks well separated");
  assert.ok(r.separation < 0.15, `raw separation should be tiny, got ${r.separation}`);

  const plan = planOverrides(skills, r.scores, cfg(), {
    calibrated: false,
    separation: r.separation,
    signalStrength: r.signalStrength,
  });
  assert.equal(plan.bailedOut, "no-separation");
  assert.equal(plan.stats.hidden, 0);
});

test("caps scale down so a small library still gets gated", () => {
  // A flat cap of 40 left a 54-skill install almost entirely visible.
  const skills = Array.from({ length: 54 }, (_, i) => skill(`s${i}`));
  const scores = new Map(skills.map((s, i) => [s.name, 1 - i / 54]));
  const plan = planOverrides(skills, scores, cfg(), { calibrated: true, separation: 0.5, signalStrength: 999 });
  assert.ok(plan.stats.maxOn < 40, `maxOn should scale below the hard cap, got ${plan.stats.maxOn}`);
  assert.ok(plan.stats.on <= 12, `too many left fully visible: ${plan.stats.on}`);
  const savedPct = plan.stats.approxTokensSaved / plan.stats.approxTokensBefore;
  assert.ok(savedPct > 0.5, `should save most of the manifest, saved ${(savedPct * 100).toFixed(0)}%`);
});

test("a large library still uses the hard cap", () => {
  const skills = Array.from({ length: 217 }, (_, i) => skill(`s${i}`));
  const scores = new Map(skills.map((s, i) => [s.name, 1 - i / 217]));
  const plan = planOverrides(skills, scores, cfg(), { calibrated: true, separation: 0.5, signalStrength: 999 });
  assert.equal(plan.stats.maxOn, 40);
});

test("cached local scores are never served to a run that has an API key", () => {
  const skills = [skill("a"), skill("b")];
  const state = { request: "x" };
  const k1 = cacheKey(skills, state, cfg(), "fallback");
  const k2 = cacheKey(skills, state, cfg(), "gateway");
  assert.notEqual(k1, k2, "provider must be part of the cache key");
});

console.log("\nupdate safety");

test("version comparison orders correctly", () => {
  assert.equal(compareVersions("0.2.0", "0.1.0"), 1);
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.2", "0.2.0"), 0, "missing segments count as zero");
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1, "compares numerically, not as text");
});

test("a remote that is behind is recognised as a downgrade", () => {
  // The update command syncs to a branch, which is not guaranteed to be ahead.
  // Without this check it would silently walk a user backwards - and the first
  // real run did exactly that, removing the update command itself.
  const local = "0.2.0";
  const remote = "0.1.0";
  assert.ok(compareVersions(remote, local) < 0, "must be detected before anything is written");
});

console.log("\nmigrations");

test("a fresh state dir needs no migration", () => {
  // No state dir at all means a first install, not an ancient one.
  assert.equal(readStateVersion(), STATE_VERSION);
});

test("an unversioned state dir is treated as v1 and migrated", () => {
  resetStats(); // creates the state dir without a version file
  const dir = dirname(STATE_VERSION_FILE);
  writeJsonAtomic(join(dir, "cache.json"), { oldkey: { at: Date.now(), scores: {} } });
  rmSync(STATE_VERSION_FILE, { force: true });

  assert.equal(readStateVersion(), 1);
  const r = runMigrations({ quiet: true });
  assert.equal(r.migrated, true);
  assert.equal(r.from, 1);
  assert.equal(r.to, STATE_VERSION);
  assert.equal(existsSync(join(dir, "cache.json")), false, "stale cache should be cleared");
});

test("migrating is idempotent", () => {
  const first = runMigrations({ quiet: true });
  const second = runMigrations({ quiet: true });
  assert.equal(second.migrated, false, "a second run must do nothing");
  assert.equal(readStateVersion(), STATE_VERSION);
});

test("migration never touches recorded stats", () => {
  resetStats();
  recordRun({ provider: "gateway", skills: 217, tokensBefore: 12750, tokensSaved: 9000, costUsd: 0.0009 });
  rmSync(STATE_VERSION_FILE, { force: true });
  runMigrations({ quiet: true });
  const s = readStats();
  assert.equal(s.totals.runs, 1, "stats must survive an update");
  assert.equal(s.totals.tokensSaved, 9000);
});

console.log("\nstats");

test("an empty ledger reports zero, not a crash", () => {
  resetStats();
  const s = readStats();
  assert.equal(s.totals.runs, 0);
  assert.equal(s.totals.tokensSaved, 0);
});

test("runs accumulate into lifetime totals", () => {
  resetStats();
  recordRun({ provider: "gateway", skills: 217, tokensBefore: 12750, tokensSaved: 9000, costUsd: 0.0009, usage: { inputTokens: 17745, batches: 1 } });
  recordRun({ provider: "fallback", skills: 217, tokensBefore: 12750, tokensSaved: 8000, costUsd: 0 });
  const s = readStats();
  assert.equal(s.totals.runs, 2);
  assert.equal(s.totals.tokensSaved, 17000);
  assert.ok(Math.abs(s.totals.costUsd - 0.0009) < 1e-9);
  assert.equal(s.byProvider.gateway.runs, 1);
  assert.equal(s.byProvider.fallback.tokensSaved, 8000);
});

test("a cached run is counted but costs nothing", () => {
  resetStats();
  recordRun({ provider: "gateway", cached: true, skills: 217, tokensBefore: 12750, tokensSaved: 9000, costUsd: 0 });
  const s = readStats();
  assert.equal(s.totals.runs, 1);
  assert.equal(s.totals.cachedRuns, 1);
  assert.equal(s.totals.costUsd, 0);
  assert.equal(s.totals.tokensSaved, 9000, "cached runs still save tokens");
});

test("the recent list is trimmed but lifetime totals are not", () => {
  resetStats();
  for (let i = 0; i < 60; i++) {
    recordRun({ provider: "fallback", skills: 10, tokensBefore: 100, tokensSaved: 10, costUsd: 0 });
  }
  const s = readStats();
  assert.equal(s.recent.length, 50, "recent is capped");
  assert.equal(s.totals.runs, 60, "totals must survive trimming");
  assert.equal(s.totals.tokensSaved, 600);
});

test("recording never throws, even on a malformed ledger", () => {
  resetStats();
  assert.doesNotThrow(() => recordRun({ provider: "x", skills: NaN, tokensSaved: undefined }));
});

console.log("\nsettings io");

test("atomic write round-trips and preserves unrelated keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-gate-"));
  try {
    const p = join(dir, "settings.local.json");
    writeJsonAtomic(p, { permissions: { allow: ["Bash"] }, skillOverrides: { a: "off" } });
    const back = readJsonFile(p);
    assert.deepEqual(back.permissions.allow, ["Bash"]);
    assert.equal(back.skillOverrides.a, "off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing file reads as the fallback, not a throw", () => {
  assert.deepEqual(readJsonFile("/nonexistent/nope.json", { x: 1 }), { x: 1 });
});

test("malformed json throws with the path named", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-gate-"));
  try {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{not json");
    assert.throws(() => readJsonFile(p), /bad\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
