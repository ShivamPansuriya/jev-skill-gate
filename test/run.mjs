import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _internal } from "../src/discover.mjs";
import { planOverrides, STATE_ON, STATE_NAME_ONLY, STATE_HIDDEN } from "../src/gate.mjs";
import { scoreLocally } from "../src/fallback.mjs";
import { readJsonFile, writeJsonAtomic } from "../src/settings.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { setLogLevel } from "../src/log.mjs";

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

const cfg = (patch = {}) => ({ ...DEFAULTS, ...patch, thresholds: { ...DEFAULTS.thresholds, ...(patch.thresholds || {}) } });
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

test("maxOn caps full descriptions even when everything scores high", () => {
  const skills = Array.from({ length: 30 }, (_, i) => skill(`s${i}`));
  const scores = new Map(skills.map((s) => [s.name, 0.99]));
  const { stats } = planOverrides(skills, scores, cfg({ maxOn: 5 }));
  assert.equal(stats.on, 5);
});

test("thin signal fails open instead of hiding everything", () => {
  const skills = Array.from({ length: 10 }, (_, i) => skill(`s${i}`));
  const scores = new Map(skills.map((s) => [s.name, 0]));
  const res = planOverrides(skills, scores, cfg(), { calibrated: false, signalStrength: 3 });
  assert.equal(res.bailedOut, "weak-signal");
  assert.deepEqual(res.overrides, {});
  assert.equal(res.stats.hidden, 0);
});

test("uncalibrated scores take a rank slice, not a threshold", () => {
  const skills = Array.from({ length: 10 }, (_, i) => skill(`s${i}`));
  // Every score sits below thresholds.on; a threshold pass would hide them all.
  const scores = new Map(skills.map((s, i) => [s.name, 0.1 + i * 0.01]));
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
