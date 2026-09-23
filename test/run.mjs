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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { _internal } from "../src/discover.mjs";
import { planOverrides, STATE_ON, STATE_NAME_ONLY, STATE_HIDDEN } from "../src/gate.mjs";
import { scoreLocally } from "../src/fallback.mjs";
import { readJsonFile, writeJsonAtomic } from "../src/settings.mjs";
import { DEFAULTS, loadConfig, maskKey, CONFIG_PATH } from "../src/config.mjs";
import { scoreWithProvider } from "../src/runner.mjs";
import { defineProvider } from "../src/providers/spec.mjs";
import { extractJson } from "../src/providers/subprocess.mjs";
import {
  resolveProvider,
  loadProviders,
  resetProviderCache,
  providerConfig,
  USER_PROVIDER_DIR,
} from "../src/providers/index.mjs";
import typesafeProvider from "../src/providers/typesafe.mjs";
import gatewayProvider from "../src/providers/gateway.mjs";
import openJevProvider from "../src/providers/open-jev.mjs";
import { setLogLevel } from "../src/log.mjs";
import { readStats, recordRun, resetStats } from "../src/stats.mjs";
import { cacheKey } from "../src/cache.mjs";
import { runMigrations, readStateVersion, STATE_VERSION, STATE_VERSION_FILE } from "../src/migrate.mjs";
import { compareVersions, TRACKED_PATHS, PRESERVED_PATHS } from "../src/update.mjs";

setLogLevel("silent");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    // Async cases are awaited by the caller via `await test(...)`; returning the
    // promise keeps one helper for both kinds.
    if (r && typeof r.then === "function") {
      return r.then(
        () => (passed++, console.log(`  ok    ${name}`)),
        (err) => (failed++, console.log(`  FAIL  ${name}\n        ${err.message}`))
      );
    }
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
  providers: { ...DEFAULTS.providers, ...(patch.providers || {}) },
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

console.log("\nprovider contract");

test("a provider must implement exactly one of request() or score()", () => {
  assert.throws(() => defineProvider({ id: "x" }), /exactly one/);
  assert.throws(
    () => defineProvider({ id: "x", request: () => ({}), readAnswers: () => new Map(), score: () => ({}) }),
    /exactly one/
  );
});

test("a declarative provider must be able to read its own replies", () => {
  assert.throws(() => defineProvider({ id: "x", request: () => ({}) }), /readAnswers/);
});

test("ids are validated at definition time, not at first use", () => {
  assert.throws(() => defineProvider({ id: "Not Valid", score: () => ({}) }), /provider id must match/);
  assert.doesNotThrow(() => defineProvider({ id: "open-jev-2", score: () => ({}) }));
});

test("uncalibrated is the default, so a new provider cannot silently claim thresholds", () => {
  assert.equal(defineProvider({ id: "x", score: () => ({}) }).calibrated, false);
});

console.log("\nprovider request shapes");

const questionsFor = (names) => names.map((n, i) => ({ key: `q${i}`, name: n, description: `about ${n}` }));

test("gateway posts to the evaluation-model path with the model in a header", () => {
  const conf = providerConfig(cfg(), gatewayProvider);
  const r = gatewayProvider.request({ questions: questionsFor(["a"]), state: "s", cfg: cfg(), conf, apiKey: "k" });
  assert.equal(r.url, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
  assert.equal(r.headers["ai-model-id"], "typesafe-ai/jev");
  assert.equal(r.headers["ai-evaluation-model-specification-version"], "4");
  // The Gateway names the primitive "boolean"; sending "noul" there is rejected.
  assert.equal(r.body.questions.q0.type, "boolean");
  assert.equal(r.body.model, undefined, "gateway takes the model from the header");
});

test("typesafe direct posts to /systemone with the model in the body", () => {
  const conf = providerConfig(cfg(), typesafeProvider);
  const r = typesafeProvider.request({ questions: questionsFor(["a"]), state: "s", cfg: cfg(), conf, apiKey: "k" });
  assert.equal(r.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(r.body.questions.q0.type, "noul");
  assert.equal(r.body.model, "jev-latest");
});

test("open-jev posts to its own path and renders instructions as a string", () => {
  const conf = providerConfig(cfg(), openJevProvider);
  const r = openJevProvider.request({ questions: questionsFor(["rust-build"]), state: "s", cfg: cfg(), conf });
  assert.equal(r.url, "http://127.0.0.1:8791/v1/systemone");
  // Open-Jev takes prose, not the structured object the hosted API accepts.
  assert.equal(typeof r.body.questions.q0.instructions, "string");
  assert.match(r.body.questions.q0.instructions, /rust-build/);
  assert.deepEqual(r.headers, {}, "no auth header when no key is configured");
});

test("a custom baseUrl is honoured and trailing slashes are trimmed", () => {
  const c = cfg({ providers: { gateway: { baseUrl: "https://proxy.internal/" } } });
  const r = gatewayProvider.request({
    questions: questionsFor(["a"]),
    state: "s",
    cfg: c,
    conf: providerConfig(c, gatewayProvider),
    apiKey: "k",
  });
  assert.equal(r.url, "https://proxy.internal/v4/ai/evaluation-model");
});

test("each provider reads the probability out of its own answer shape", () => {
  const qs = questionsFor(["a"]);
  assert.equal(typesafeProvider.readAnswers({ answers: { q0: { noul: 0.93 } } }, qs).get("q0"), 0.93);
  assert.equal(gatewayProvider.readAnswers({ answers: { q0: { probability: 0.99 } } }, qs).get("q0"), 0.99);
  assert.equal(openJevProvider.readAnswers({ answers: { q0: { type: "noul", noul: 0.84 } } }, qs).get("q0"), 0.84);
  // A choice answer where a noul was asked for is not a number we can use.
  assert.equal(typesafeProvider.readAnswers({ answers: { q0: { choice: "x" } } }, qs).size, 0);
  assert.equal(gatewayProvider.readAnswers({ answers: { q0: { probability: 1.4 } } }, qs).get("q0"), 1, "clamped");
});

test("every skill gets an opaque question key, so names never reach the wire", () => {
  const conf = providerConfig(cfg(), gatewayProvider);
  const r = gatewayProvider.request({
    questions: questionsFor(["go:review", "a-b", "c"]),
    state: "s",
    cfg: cfg(),
    conf,
    apiKey: "k",
  });
  const keys = Object.keys(r.body.questions);
  assert.equal(keys.length, 3);
  assert.ok(keys.every((k) => /^q\d+$/.test(k)));
});

console.log("\nrunner against a live local server");

/** Stands in for Open-Jev: same routes, same request and response shapes. */
async function withFakeOpenJev(handler, fn) {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const reply = handler(req, JSON.parse(body || "{}"));
      res.writeHead(reply.status || 200, { "Content-Type": "application/json", ...(reply.headers || {}) });
      res.end(JSON.stringify(reply.json ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const noulFor = (questions, score) =>
  Object.fromEntries(Object.keys(questions).map((k, i) => [k, { type: "noul", noul: score(k, i) }]));

await test("scores a real library against a live Open-Jev-shaped server", async () => {
  const skills = [skill("rust-build", "cargo"), skill("crm", "carriers"), skill("docs", "documentation")];
  const seen = [];
  const result = await withFakeOpenJev(
    (req, body) => {
      seen.push(req.url);
      return { json: { answers: noulFor(body.questions, (_k, i) => [0.91, 0.04, 0.2][i]) } };
    },
    (baseUrl) => {
      const c = cfg({ provider: "open-jev", providers: { "open-jev": { baseUrl } } });
      return scoreWithProvider(skills, { prompt: "fix my cargo build" }, c, {
        id: "open-jev",
        provider: openJevProvider,
        conf: providerConfig(c, openJevProvider),
        apiKey: null,
      });
    }
  );
  assert.deepEqual(seen, ["/v1/systemone"]);
  assert.equal(result.scores.get("rust-build"), 0.91);
  assert.equal(result.scores.get("crm"), 0.04);
  assert.equal(result.costUsd, 0, "self-hosted costs nothing");
  assert.equal(result.calibrated, false, "Open-Jev has no published reliability curve");
});

await test("a library larger than the provider's batch limit is split across requests", async () => {
  const skills = Array.from({ length: 150 }, (_, i) => skill(`s${i}`));
  let requests = 0;
  const result = await withFakeOpenJev(
    (_req, body) => {
      requests++;
      return { json: { answers: noulFor(body.questions, () => 0.5) } };
    },
    (baseUrl) => {
      const c = cfg({ providers: { "open-jev": { baseUrl } } });
      return scoreWithProvider(skills, { prompt: "anything" }, c, {
        id: "open-jev",
        provider: openJevProvider,
        conf: providerConfig(c, openJevProvider),
        apiKey: null,
      });
    }
  );
  // batchLimit 16 wins over the config's batchSize of 250: it is a fact about
  // what the server can do inside one request, not a preference.
  assert.equal(requests, 10);
  assert.equal(result.scores.size, 150);
  assert.equal(result.usage.batches, 10);
});

await test("a provider that answers nothing usable fails loudly rather than hiding everything", async () => {
  const skills = [skill("a"), skill("b")];
  await assert.rejects(
    withFakeOpenJev(
      () => ({ json: { answers: {} } }),
      (baseUrl) => {
        const c = cfg({ providers: { "open-jev": { baseUrl } } });
        return scoreWithProvider(skills, { prompt: "x" }, c, {
          id: "open-jev",
          provider: openJevProvider,
          conf: providerConfig(c, openJevProvider),
          apiKey: null,
        });
      }
    ),
    /no usable answers/
  );
});

await test("a per-provider calibrated override reaches the planner", async () => {
  const skills = [skill("a"), skill("b")];
  const result = await withFakeOpenJev(
    (_req, body) => ({ json: { answers: noulFor(body.questions, (_k, i) => [0.9, 0.1][i]) } }),
    (baseUrl) => {
      const c = cfg({ providers: { "open-jev": { baseUrl, calibrated: true } } });
      return scoreWithProvider(skills, { prompt: "x" }, c, {
        id: "open-jev",
        provider: openJevProvider,
        conf: providerConfig(c, openJevProvider),
        apiKey: null,
      });
    }
  );
  assert.equal(result.calibrated, true);
});

console.log("\nlocal subprocess providers");

test("the result JSON is found even when the model printed progress first", () => {
  const out = 'Loading checkpoint...\n[####] done\n{"answers":{"q0":{"noul":0.7}}}\n';
  assert.equal(extractJson(out).answers.q0.noul, 0.7);
});

test("a pretty-printed reply across several lines still parses", () => {
  assert.equal(extractJson('warming up\n{\n  "answers": {}\n}\n').answers !== undefined, true);
});

test("output with no JSON at all reports what it saw", () => {
  assert.throws(() => extractJson("ModuleNotFoundError: no module named laya"), /no JSON object/);
});

await test("a local process provider is driven end to end", async () => {
  // Stands in for laya: reads the payload file, writes the shared reply shape.
  const layaProvider = (await import("../src/providers/laya.mjs")).default;
  const dir = mkdtempSync(join(tmpdir(), "jev-fakepy-"));
  const fake = join(dir, "fake-python");
  writeFileSync(
    fake,
    // The shebang names the interpreter running this suite rather than `env
    // node`: a machine can have a perfectly good Node without one on PATH, and
    // then this test fails for a reason that has nothing to do with the code.
    `#!${process.execPath}
const { readFileSync } = require("node:fs");
const payload = JSON.parse(readFileSync(process.argv[process.argv.length - 1], "utf8"));
const answers = {};
for (const k of Object.keys(payload.questions)) answers[k] = { type: "noul", noul: 0.42 };
console.log("loading model");
console.log(JSON.stringify({ answers, usage: { input_tokens: 11 } }));
`,
    { mode: 0o755 }
  );
  try {
    const c = cfg({ providers: { laya: { python: fake } } });
    const result = await scoreWithProvider([skill("a"), skill("b")], { prompt: "x" }, c, {
      id: "laya",
      provider: layaProvider,
      conf: providerConfig(c, layaProvider),
      apiKey: null,
    });
    assert.equal(result.scores.get("a"), 0.42);
    assert.equal(result.usage.inputTokens, 11);
    assert.equal(result.costUsd, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("a missing local runtime says so instead of throwing spawn noise", async () => {
  const layaProvider = (await import("../src/providers/laya.mjs")).default;
  const c = cfg({ providers: { laya: { python: "definitely-not-installed-xyz" } } });
  await assert.rejects(
    scoreWithProvider([skill("a")], { prompt: "x" }, c, {
      id: "laya",
      provider: layaProvider,
      conf: providerConfig(c, layaProvider),
      apiKey: null,
    }),
    /not installed or not on PATH/
  );
});

console.log("\nprovider resolution");

const withEnv = async (vars, fn) => {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

await test("env key beats a config-file key", () =>
  withEnv({ AI_GATEWAY_API_KEY: "from-env" }, async () => {
    const p = await resolveProvider(cfg({ provider: "gateway", providers: { gateway: { apiKey: "from-file" } } }));
    assert.equal(p.apiKey, "from-env");
  }));

await test("a config-file key is used when no env var is set", () =>
  withEnv({ AI_GATEWAY_API_KEY: null, VERCEL_AI_GATEWAY_KEY: null }, async () => {
    const p = await resolveProvider(cfg({ provider: "gateway", providers: { gateway: { apiKey: "from-file" } } }));
    assert.equal(p.id, "gateway");
    assert.equal(p.apiKey, "from-file");
  }));

await test("no key anywhere degrades to the local scorer rather than failing", () =>
  withEnv({ AI_GATEWAY_API_KEY: null, VERCEL_AI_GATEWAY_KEY: null, TYPESAFE_API_KEY: null }, async () => {
    const p = await resolveProvider(cfg({ provider: "gateway" }));
    assert.equal(p.id, "fallback");
    assert.match(p.reason, /AI_GATEWAY_API_KEY/);
  }));

await test("a local provider needs no key at all", async () => {
  const p = await resolveProvider(cfg({ provider: "open-jev" }));
  assert.equal(p.id, "open-jev");
  assert.equal(p.conf.baseUrl, "http://127.0.0.1:8791");
});

await test("auto never selects a local provider, because nothing probes the port", () =>
  withEnv({ AI_GATEWAY_API_KEY: null, VERCEL_AI_GATEWAY_KEY: null, TYPESAFE_API_KEY: null }, async () => {
    const p = await resolveProvider(cfg({ provider: "auto" }));
    assert.equal(p.id, "fallback", "running a local model is an explicit choice");
  }));

await test("a misspelled provider name degrades and names the real ones", async () => {
  const p = await resolveProvider(cfg({ provider: "open-jevv" }));
  assert.equal(p.id, "fallback");
  assert.match(p.reason, /unknown provider "open-jevv"/);
  assert.match(p.reason, /open-jev/);
});

await test("disabled stays disabled", async () => {
  assert.equal((await resolveProvider(cfg({ provider: "disabled" }))).id, "disabled");
});

console.log("\nprovider plugins");

await test("a module dropped in the plugin directory becomes a usable provider", async () => {
  mkdirSync(USER_PROVIDER_DIR, { recursive: true });
  const file = join(USER_PROVIDER_DIR, "my-model.mjs");
  writeFileSync(
    file,
    `export default {
       id: "my-model",
       label: "mine",
       local: true,
       requiresKey: false,
       score: () => ({ scores: new Map([["a", 1]]) }),
     };\n`
  );
  try {
    resetProviderCache();
    const providers = await loadProviders();
    assert.ok(providers.has("my-model"));
    assert.equal(providers.get("my-model").source, file);
    // Not validated by defineProvider in the file, so the registry must do it.
    assert.equal(providers.get("my-model").calibrated, false);
    assert.equal((await resolveProvider(cfg({ provider: "my-model" }))).id, "my-model");
  } finally {
    rmSync(file, { force: true });
    resetProviderCache();
  }
});

await test("a broken plugin is skipped, not fatal", async () => {
  mkdirSync(USER_PROVIDER_DIR, { recursive: true });
  const file = join(USER_PROVIDER_DIR, "broken.mjs");
  writeFileSync(file, "export default { id: 'broken' };\n"); // no request(), no score()
  try {
    resetProviderCache();
    const providers = await loadProviders();
    assert.ok(!providers.has("broken"));
    assert.ok(providers.has("gateway"), "the rest still load");
  } finally {
    rmSync(file, { force: true });
    resetProviderCache();
  }
});

console.log("\nlegacy config");

test("top-level typesafe/gateway keys are folded into providers", () => {
  writeJsonAtomic(CONFIG_PATH, {
    provider: "gateway",
    gateway: { baseUrl: "https://old.example", apiKey: "old-key" },
    typesafe: { model: "jev-legacy" },
  });
  try {
    const c = loadConfig();
    assert.equal(c.providers.gateway.baseUrl, "https://old.example");
    assert.equal(c.providers.typesafe.model, "jev-legacy");
    assert.equal(c.gateway, undefined, "the old key is gone once lifted");
  } finally {
    rmSync(CONFIG_PATH, { force: true });
  }
});

test("a new-style key wins over the legacy one it duplicates", () => {
  writeJsonAtomic(CONFIG_PATH, {
    gateway: { baseUrl: "https://old.example" },
    providers: { gateway: { baseUrl: "https://new.example" } },
  });
  try {
    assert.equal(loadConfig().providers.gateway.baseUrl, "https://new.example");
  } finally {
    rmSync(CONFIG_PATH, { force: true });
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

test("an update removes files the new version deleted", () => {
  // An overlay copy leaves a deleted module behind, where it keeps satisfying
  // imports in files that should have failed loudly. src/jev.mjs did exactly
  // that when providers/ replaced it.
  const dir = mkdtempSync(join(tmpdir(), "jev-upd-"));
  try {
    const oldInstall = join(dir, "install");
    const incoming = join(dir, "incoming");
    mkdirSync(join(oldInstall, "src"), { recursive: true });
    mkdirSync(join(incoming, "src"), { recursive: true });
    writeFileSync(join(oldInstall, "src", "gone.mjs"), "export const x = 1;\n");
    writeFileSync(join(oldInstall, "src", "kept.mjs"), "old\n");
    writeFileSync(join(incoming, "src", "kept.mjs"), "new\n");

    // What applyUpdate does to a tracked directory.
    rmSync(join(oldInstall, "src"), { recursive: true, force: true });
    cpSync(join(incoming, "src"), join(oldInstall, "src"), { recursive: true, force: true });

    assert.ok(!existsSync(join(oldInstall, "src", "gone.mjs")), "deleted file must not survive");
    assert.equal(readFileSync(join(oldInstall, "src", "kept.mjs"), "utf8"), "new\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every module a tracked path imports is itself tracked", () => {
  // test/ and eval/ import from src/. If they are not replaced together, an
  // update leaves code that calls an API that has since changed shape - which
  // is how eval/run-eval.mjs ended up calling an async resolveProvider
  // synchronously.
  for (const required of ["src", "bin", "test", "eval"]) {
    assert.ok(TRACKED_PATHS.includes(required), `${required} must be replaced by an update`);
  }
  // Results the user paid for are the one exception, and must be restored.
  assert.ok(PRESERVED_PATHS.includes("eval/raw-scores.json"));
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
