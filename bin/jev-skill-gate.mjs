#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig, resolveProvider, maskKey, CONFIG_PATH, STATE_DIR } from "../src/config.mjs";
import { setLogLevel, log } from "../src/log.mjs";
import { buildPlan, STATE_ON, STATE_NAME_ONLY, STATE_HIDDEN } from "../src/gate.mjs";
import {
  applyOverrides,
  restoreOverrides,
  resolveSettingsPath,
  installHook,
  uninstallHook,
  readJsonFile,
  writeJsonAtomic,
} from "../src/settings.mjs";
import { clearCache } from "../src/cache.mjs";
import { discoverSkills } from "../src/discover.mjs";

const ENTRYPOINT = fileURLToPath(import.meta.url);
const PKG_ROOT = resolve(dirname(ENTRYPOINT), "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=");
      if (inline !== undefined) out[k] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function readStdin() {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => res(data));
    setTimeout(() => res(data), 3000);
  });
}

function cfgFromArgs(args) {
  const overrides = {};
  if (args.provider) overrides.provider = args.provider;
  if (args["max-on"]) overrides.maxOn = Number(args["max-on"]);
  if (args["threshold-on"]) overrides.thresholds = { ...(overrides.thresholds || {}), on: Number(args["threshold-on"]) };
  if (args["threshold-name-only"]) {
    overrides.thresholds = { ...(overrides.thresholds || {}), nameOnly: Number(args["threshold-name-only"]) };
  }
  if (args.verbose) overrides.logLevel = "debug";
  if (args.quiet) overrides.logLevel = "silent";
  const cfg = loadConfig(overrides);
  setLogLevel(cfg.logLevel);
  return cfg;
}

const BADGE = { [STATE_ON]: "ON      ", [STATE_NAME_ONLY]: "name    ", [STATE_HIDDEN]: "hidden  " };

function printPlan(result, { limit = 0 } = {}) {
  const { plan, provider, cached, costUsd } = result;
  const s = plan.stats;
  const after = s.approxTokensBefore - s.approxTokensSaved;

  console.log("");
  console.log(`  provider   ${provider}${cached ? " (cached)" : ""}${costUsd ? `  $${costUsd.toFixed(6)}` : ""}`);
  console.log(`  skills     ${s.total} discovered`);
  console.log(`  verdict    ${s.on} full · ${s.nameOnly} name-only · ${s.hidden} hidden`);
  console.log(`  tokens     ${s.approxTokensBefore} -> ${after}  (saved ~${s.approxTokensSaved})`);
  console.log("");

  const rows = limit > 0 ? plan.decisions.slice(0, limit) : plan.decisions;
  for (const d of rows) {
    const score = d.score === null ? "kept" : d.score.toFixed(2);
    console.log(`  ${BADGE[d.state]} ${score}  ${d.skill.name}`);
  }
  if (limit > 0 && plan.decisions.length > limit) {
    console.log(`  ... ${plan.decisions.length - limit} more (--all to show)`);
  }
  console.log("");
}

async function cmdPreview(args) {
  const cfg = cfgFromArgs(args);
  const projectDir = resolve(args.dir || process.cwd());
  const result = await buildPlan(cfg, {
    projectDir,
    prompt: args.prompt || null,
    useCache: !args["no-cache"],
  });
  if (!result.plan) {
    console.log("gating is disabled in config (provider: disabled)");
    return 0;
  }
  printPlan(result, { limit: args.all ? 0 : 30 });
  console.log(`  would write ${resolveSettingsPath(projectDir, cfg.scope || "auto")}`);
  console.log(`  run 'jev-skill-gate apply' to apply\n`);
  return 0;
}

async function cmdApply(args) {
  const cfg = cfgFromArgs(args);
  const projectDir = resolve(args.dir || process.cwd());
  const result = await buildPlan(cfg, {
    projectDir,
    prompt: args.prompt || null,
    useCache: !args["no-cache"],
  });
  if (!result.plan) {
    console.log("gating is disabled in config (provider: disabled)");
    return 0;
  }

  const settingsPath = resolveSettingsPath(projectDir, args.scope || cfg.scope || "auto");
  const res = applyOverrides(settingsPath, result.plan.overrides, { dryRun: cfg.dryRun });

  printPlan(result, { limit: args.all ? 0 : 20 });
  if (res.skippedUserOwned) {
    console.log(`  kept ${res.skippedUserOwned} override(s) you set by hand`);
  }
  console.log(res.wrote ? `  wrote ${res.settingsPath}` : `  no change to ${res.settingsPath}`);
  console.log(`  restart Claude Code (or start a new session) to pick it up\n`);
  return 0;
}

/**
 * Hook entrypoint. Claude Code pipes the event JSON on stdin and reads control
 * JSON from stdout, so stdout carries nothing but that JSON. Every diagnostic
 * goes to stderr, which is informational only for a hook that exits 0.
 *
 * Failures are swallowed on purpose: a broken gater must never stop a session
 * from starting.
 */
async function cmdHook(args) {
  const event = args.event || "SessionStart";
  let payload = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    /* keep going with an empty payload */
  }

  const cfg = cfgFromArgs(args);
  const projectDir = payload.cwd || process.cwd();

  try {
    if (event === "SessionStart") {
      const result = await buildPlan(cfg, { projectDir, useCache: true });
      if (!result.plan) return 0;

      const settingsPath = resolveSettingsPath(projectDir, cfg.scope || "auto");
      const res = applyOverrides(settingsPath, result.plan.overrides, { dryRun: cfg.dryRun });
      const s = result.plan.stats;
      log.info(
        `${s.on} full / ${s.nameOnly} name-only / ${s.hidden} hidden · ` +
          `~${s.approxTokensSaved} tokens saved · provider=${result.provider}`
      );

      // reloadSkills makes Claude Code re-scan after this hook finishes. Skill
      // discovery otherwise completes before SessionStart hooks do, which would
      // put our overrides one session behind.
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "SessionStart", reloadSkills: true },
        })
      );
      return res.wrote ? 0 : 0;
    }

    if (event === "UserPromptSubmit") {
      const prompt = payload.prompt || "";
      const result = await buildPlan(cfg, { projectDir, prompt, useCache: false });
      if (!result.plan) return 0;

      // Per-prompt, the reliable lever is context, not the manifest: the manifest
      // is already built. We surface skills that scored high but are currently
      // reduced, so Claude can still reach for them.
      const revived = result.plan.decisions
        .filter((d) => d.score !== null && d.score >= cfg.thresholds.on && d.state !== STATE_ON)
        .slice(0, 5);

      if (revived.length === 0) return 0;

      const lines = revived.map((d) => `- ${d.skill.name}: ${d.skill.description}`).join("\n");
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext:
              `These skills are relevant to this request and can be invoked with the Skill tool:\n${lines}`,
          },
        })
      );
      return 0;
    }
  } catch (err) {
    log.error(`hook failed, session continues ungated: ${err.message}`);
  }
  return 0;
}

function cmdInstall(args) {
  const event = args.event || "SessionStart";
  const res = installHook({ entrypoint: ENTRYPOINT, event });
  if (!res.installed) {
    console.log(`already installed (${res.reason})`);
    return 0;
  }
  console.log(`installed ${event} hook in ${res.settingsPath}`);
  console.log(`  ${res.command}`);
  console.log(`\nnext: set TYPESAFE_API_KEY (or AI_GATEWAY_API_KEY), then run 'jev-skill-gate preview'`);
  console.log(`without a key it uses the built-in local scorer, which needs no setup.`);
  return 0;
}

function cmdUninstall() {
  const hook = uninstallHook();
  const restored = restoreOverrides();
  console.log(`removed ${hook.removed} hook entr${hook.removed === 1 ? "y" : "ies"} from ${hook.settingsPath}`);
  console.log(restored.restored ? `restored skillOverrides in ${restored.settingsPath}` : restored.reason);
  return 0;
}

function cmdRestore() {
  const res = restoreOverrides();
  console.log(res.restored ? `restored skillOverrides in ${res.settingsPath}` : res.reason);
  return 0;
}

/**
 * Shows or edits ~/.claude/jev-skill-gate.json.
 *
 * Written 0600 because it can hold an API key. An environment variable still
 * takes precedence over anything stored here.
 */
function cmdConfig(args) {
  const target = args.provider === "typesafe" ? "typesafe" : "gateway";
  const writes = {};
  if (args["base-url"]) writes.baseUrl = args["base-url"];
  if (args["api-key"]) writes.apiKey = args["api-key"];
  if (args.model) writes.model = args.model;

  const touchingProvider = args.provider && Object.keys(writes).length === 0;

  if (Object.keys(writes).length > 0 || touchingProvider) {
    const existing = readJsonFile(CONFIG_PATH, {});
    if (args.provider) existing.provider = args.provider;
    if (Object.keys(writes).length > 0) {
      existing[target] = { ...(existing[target] || {}), ...writes };
    }
    writeJsonAtomic(CONFIG_PATH, existing);
    try {
      chmodSync(CONFIG_PATH, 0o600);
    } catch {
      /* best effort on platforms without POSIX modes */
    }
    console.log(`wrote ${CONFIG_PATH}`);
    if (writes.apiKey) console.log("  mode 0600. an env var still wins over this value.");
  }

  const cfg = cfgFromArgs(args);
  const provider = resolveProvider(cfg);

  console.log("\nconfig\n");
  console.log(`  file          ${CONFIG_PATH}`);
  console.log(`  provider      ${cfg.provider}  ->  resolved: ${provider.kind}`);
  if (provider.kind === "fallback" && provider.reason) console.log(`                ${provider.reason}`);
  console.log("");
  for (const p of ["gateway", "typesafe"]) {
    const envKey =
      p === "gateway"
        ? process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_KEY
        : process.env.TYPESAFE_API_KEY || process.env.TYPESAFE_AI_API_KEY;
    console.log(`  [${p}]`);
    console.log(`    baseUrl     ${cfg[p].baseUrl}`);
    console.log(`    model       ${cfg[p].model}`);
    console.log(`    apiKey      env: ${maskKey(envKey)}   file: ${maskKey(cfg[p].apiKey)}`);
  }
  console.log(`\n  thresholds    on >= ${cfg.thresholds.on}   name-only >= ${cfg.thresholds.nameOnly}`);
  console.log(`  caps          maxOn ${cfg.maxOn}   maxNameOnly ${cfg.maxNameOnly}\n`);
  console.log("  set values with:");
  console.log("    jev-skill-gate config --provider gateway --api-key vck_... --base-url https://...\n");
  return 0;
}

function cmdDoctor(args) {
  const cfg = cfgFromArgs(args);
  const projectDir = resolve(args.dir || process.cwd());
  const provider = resolveProvider(cfg);
  const skills = discoverSkills({ projectDir });
  const tokens = skills.reduce((n, s) => n + s.approxTokens, 0);

  const check = (ok, label, detail) => console.log(`  ${ok ? "ok  " : "--  "} ${label}${detail ? `  ${detail}` : ""}`);

  console.log("\njev-skill-gate doctor\n");
  check(Number(process.versions.node.split(".")[0]) >= 18, "node >= 18", `v${process.versions.node}`);
  check(skills.length > 0, "skills discovered", `${skills.length} skills, ~${tokens} tokens`);
  check(provider.kind !== "fallback", "jev provider", provider.kind === "fallback" ? provider.reason : provider.kind);
  check(true, "config", CONFIG_PATH);
  check(true, "state dir", STATE_DIR);
  check(true, "settings target", resolveSettingsPath(projectDir, cfg.scope || "auto"));

  const bySource = skills.reduce((m, s) => ((m[s.source] = (m[s.source] || 0) + 1), m), {});
  console.log(`\n  sources: ${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log("");
  return 0;
}

const HELP = `
jev-skill-gate — gate Claude Code's skill manifest with TypeSafe Jev

  preview     score skills and show the plan without writing anything
  apply       score skills and write skillOverrides
  install     register the SessionStart hook in ~/.claude/settings.json
  uninstall   remove the hook and restore your original skillOverrides
  restore     restore skillOverrides without touching the hook
  config      show or set provider, base URL, API key and model
  doctor      check the setup
  clear-cache drop cached scores
  hook        internal: run as a Claude Code hook

Options
  --dir <path>              project directory (default: cwd)
  --prompt <text>           score against a request as well as the project
  --provider <name>         auto | typesafe | gateway | fallback | disabled
  --scope <auto|project|user>  where to write skillOverrides
  --threshold-on <0..1>     full-description cutoff (default 0.6)
  --threshold-name-only <n> name-only cutoff (default 0.25)
  --max-on <n>              hard cap on full descriptions (default 40)
  --no-cache                ignore cached scores
  --all                     show every skill in the table
  --verbose / --quiet

Environment
  TYPESAFE_API_KEY          TypeSafe direct
  AI_GATEWAY_API_KEY        Vercel AI Gateway

Without a key it uses a local TF-IDF scorer, so it works with no setup at all.
`;

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0] || "help";

  const table = {
    preview: cmdPreview,
    status: cmdPreview,
    apply: cmdApply,
    hook: cmdHook,
    install: cmdInstall,
    uninstall: () => cmdUninstall(),
    restore: () => cmdRestore(),
    doctor: cmdDoctor,
    config: cmdConfig,
    "clear-cache": () => (clearCache(), console.log("cache cleared"), 0),
  };

  if (cmd === "help" || args.help) {
    console.log(HELP);
    return 0;
  }
  const fn = table[cmd];
  if (!fn) {
    console.error(`unknown command: ${cmd}\n${HELP}`);
    return 1;
  }
  return (await fn(args)) || 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[jev-skill-gate] fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  }
);
