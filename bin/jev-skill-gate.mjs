#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig, maskKey, CONFIG_PATH, STATE_DIR } from "../src/config.mjs";
import {
  resolveProvider,
  loadProviders,
  providerConfig,
  providerKey,
  FALLBACK_ID,
  USER_PROVIDER_DIR,
} from "../src/providers/index.mjs";
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
import { readStats, recordRun, resetStats, STATS_FILE } from "../src/stats.mjs";
import { discoverSkills } from "../src/discover.mjs";
import { runMigrations, readStateVersion, STATE_VERSION } from "../src/migrate.mjs";
import { installedInfo, fetchRemote, applyUpdate, compareVersions } from "../src/update.mjs";

const ENTRYPOINT = fileURLToPath(import.meta.url);
const PKG_ROOT = resolve(dirname(ENTRYPOINT), "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=");
      const value = inline !== undefined ? inline : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      // --set is the only repeatable flag: several per-provider keys in one go.
      if (k === "set") (out.set ||= []).push(value);
      else out[k] = value;
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

  // The local scorer emits rank-percentiles. Printing 1.00 next to a skill reads
  // as "certain" when it only means "ranked first", so uncalibrated runs show the
  // rank instead of a number that invites the wrong reading.
  const calibrated = s.calibrated !== false;
  const rows = limit > 0 ? plan.decisions.slice(0, limit) : plan.decisions;
  let rank = 0;
  for (const d of rows) {
    if (d.score !== null) rank++;
    const col = d.score === null ? "kept" : calibrated ? d.score.toFixed(2) : `#${rank}`;
    console.log(`  ${BADGE[d.state]} ${String(col).padStart(5)}  ${d.skill.name}`);
  }
  if (!calibrated) {
    console.log("\n  (local scorer: ranks, not probabilities — set an API key for calibrated scores)");
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

  if (!cfg.dryRun) {
    recordRun({
      provider: result.provider,
      cached: result.cached,
      skills: result.plan.stats.total,
      tokensBefore: result.plan.stats.approxTokensBefore,
      tokensSaved: result.plan.stats.approxTokensSaved,
      costUsd: result.costUsd,
      usage: result.usage || {},
      projectDir,
      source: "apply",
    });
  }

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
      if (!cfg.dryRun) {
        recordRun({
          provider: result.provider,
          cached: result.cached,
          skills: s.total,
          tokensBefore: s.approxTokensBefore,
          tokensSaved: s.approxTokensSaved,
          costUsd: result.costUsd,
          usage: result.usage || {},
          projectDir,
          source: "hook",
        });
      }
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
async function cmdConfig(args) {
  const providers = await loadProviders();
  // Which provider's settings are being edited. Defaults to the one being
  // selected, so `config --provider open-jev --base-url ...` does the obvious
  // thing in a single command.
  const target = args.for || (args.provider && args.provider !== "auto" ? args.provider : null);

  const writes = {};
  if (args["base-url"]) writes.baseUrl = args["base-url"];
  if (args["api-key"]) writes.apiKey = args["api-key"];
  if (args.model) writes.model = args.model;
  for (const pair of args.set || []) {
    const i = String(pair).indexOf("=");
    if (i < 0) {
      console.error(`--set expects key=value (got ${pair})`);
      return 1;
    }
    const key = pair.slice(0, i);
    const raw = pair.slice(i + 1);
    // JSON where it parses, so numbers and booleans do not land as strings and
    // silently fail a `?? provider.calibrated` style check later.
    try {
      writes[key] = JSON.parse(raw);
    } catch {
      writes[key] = raw;
    }
  }

  const hasWrites = Object.keys(writes).length > 0;
  if (hasWrites && !target) {
    console.error("say which provider to configure: --provider <id>, or --for <id> to edit one without selecting it");
    return 1;
  }
  if (target && !providers.has(target)) {
    console.error(`unknown provider "${target}" (run 'jev-skill-gate providers')`);
    return 1;
  }

  if (hasWrites || args.provider) {
    const existing = readJsonFile(CONFIG_PATH, {});
    if (args.provider) existing.provider = args.provider;
    if (hasWrites) {
      existing.providers = { ...(existing.providers || {}) };
      existing.providers[target] = { ...(existing.providers[target] || {}), ...writes };
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
  const resolved = await resolveProvider(cfg);

  console.log("\nconfig\n");
  console.log(`  file          ${CONFIG_PATH}`);
  console.log(`  provider      ${cfg.provider}  ->  resolved: ${resolved.id}`);
  if (resolved.reason) console.log(`                ${resolved.reason}`);

  // Show the selected provider in full, plus anything the user has configured.
  // Printing all of them turns a settings check into a wall of defaults.
  const shown = new Set([resolved.id, ...Object.keys(cfg.providers || {})]);
  for (const id of shown) {
    const provider = providers.get(id);
    if (!provider || provider.id === FALLBACK_ID) continue;
    const conf = providerConfig(cfg, provider);
    const envName = (provider.envKeys || []).find((k) => process.env[k]);
    console.log(`\n  [${id}]  ${provider.label}`);
    for (const [k, v] of Object.entries(conf)) {
      if (k === "apiKey") continue;
      console.log(`    ${k.padEnd(11)} ${typeof v === "object" ? JSON.stringify(v) : v}`);
    }
    if (provider.requiresKey || conf.apiKey || envName) {
      const envLabel = envName ? `${envName}=${maskKey(process.env[envName])}` : "(unset)";
      console.log(`    apiKey      env: ${envLabel}   file: ${maskKey(conf.apiKey)}`);
    }
  }

  console.log(`\n  thresholds    on >= ${cfg.thresholds.on}   name-only >= ${cfg.thresholds.nameOnly}`);
  console.log(`  caps          maxOn ${cfg.maxOn}   maxNameOnly ${cfg.maxNameOnly}\n`);
  console.log("  examples:");
  console.log("    jev-skill-gate config --provider gateway --api-key vck_...");
  console.log("    jev-skill-gate config --provider open-jev --base-url http://127.0.0.1:8791");
  console.log("    jev-skill-gate config --for laya --set python=/usr/bin/python3.11\n");
  return 0;
}

/**
 * Lists every provider the tool can see, built in or dropped into the plugin
 * directory, and whether each one is ready to use right now.
 */
async function cmdProviders(args) {
  const cfg = cfgFromArgs(args);
  const providers = await loadProviders();
  const resolved = await resolveProvider(cfg);

  console.log("\nproviders\n");
  for (const provider of providers.values()) {
    const selected = provider.id === resolved.id ? "*" : " ";
    const key = providerKey(cfg, provider);
    const state = provider.requiresKey && !key ? "no key" : provider.local ? "local" : "ready";
    const calib = provider.calibrated ? "calibrated" : "ranking only";
    console.log(`  ${selected} ${provider.id.padEnd(12)} ${state.padEnd(7)} ${calib.padEnd(13)} ${provider.label}`);
    if (provider.source && provider.source !== "builtin") console.log(`    ${" ".repeat(12)} plugin: ${provider.source}`);
  }
  console.log(`\n  * = selected by the current config (provider: ${cfg.provider})`);
  console.log(`\n  "calibrated" providers get threshold cutoffs; "ranking only" ones`);
  console.log("  get top-N slicing instead, because their scores only order skills.");
  console.log(`\n  add your own: drop a module in ${USER_PROVIDER_DIR}`);
  console.log("  see src/providers/spec.mjs for the contract.\n");
  return 0;
}

const n = (x) => (x ?? 0).toLocaleString("en-US");

function sinceDays(iso) {
  if (!iso) return null;
  return Math.max(1, Math.round((Date.now() - new Date(iso)) / 864e5));
}

/**
 * Lifetime savings, spend, and how often gating has actually run.
 *
 * Only `apply` and the SessionStart hook record a run; `preview` deliberately
 * does not, so reading the plan never inflates the numbers.
 */
function cmdStats(args) {
  if (args.reset) {
    console.log(`reset ${resetStats()}`);
    return 0;
  }
  const s = readStats();
  if (args.json) {
    console.log(JSON.stringify(s, null, 2));
    return 0;
  }

  const t = s.totals;
  if (t.runs === 0) {
    console.log("\nNo gating runs recorded yet.");
    console.log("Run 'jev-skill-gate apply', or install the hook so every session records one.\n");
    return 0;
  }

  const days = sinceDays(s.firstRunAt);
  const avgSaved = Math.round(t.tokensSaved / t.runs);
  const avgBefore = Math.round(t.tokensBefore / t.runs);
  const pctSmaller = t.tokensBefore ? (t.tokensSaved / t.tokensBefore) * 100 : 0;
  // What the saving actually cost. The interesting figure is not the total
  // spend but the rate: dollars per million tokens of context reclaimed.
  const perMillion = t.tokensSaved ? (t.costUsd / t.tokensSaved) * 1e6 : 0;

  console.log("\n  lifetime");
  console.log(`    triggered      ${n(t.runs)} sessions${days ? `  over ${days} day${days === 1 ? "" : "s"}` : ""}`);
  console.log(`    tokens saved   ${n(t.tokensSaved)}  ·  avg ${n(avgSaved)} per session`);
  console.log(`    manifest       ${n(avgBefore)} -> ${n(avgBefore - avgSaved)} avg  (${pctSmaller.toFixed(0)}% smaller)`);
  console.log(`    spent          $${t.costUsd.toFixed(4)}${t.costUsd > 0 ? `  ·  $${perMillion.toFixed(2)} per 1M tokens saved` : ""}`);
  if (t.jevRequests) {
    console.log(`    jev requests   ${n(t.jevRequests)}  ·  ${n(t.jevInputTokens)} input tokens`);
  }
  if (t.cachedRuns) {
    console.log(`    from cache     ${n(t.cachedRuns)} of ${n(t.runs)} runs cost nothing`);
  }

  const providers = Object.entries(s.byProvider).sort((a, b) => b[1].runs - a[1].runs);
  if (providers.length) {
    console.log("\n  by provider");
    for (const [name, p] of providers) {
      console.log(
        `    ${name.padEnd(10)} ${String(p.runs).padStart(5)} runs   ` +
          `$${p.costUsd.toFixed(4).padStart(8)}   ${n(p.tokensSaved).padStart(10)} saved`
      );
    }
  }

  const limit = args.all ? s.recent.length : 8;
  if (s.recent.length) {
    console.log("\n  recent");
    for (const r of s.recent.slice(0, limit)) {
      const when = r.at.slice(0, 16).replace("T", " ");
      const tag = r.cached ? "cached" : r.provider;
      console.log(
        `    ${when}  ${String(tag).padEnd(9)} ${String(r.skills).padStart(4)} skills  ` +
          `${n(r.tokensSaved).padStart(8)} saved  $${(r.costUsd || 0).toFixed(6)}`
      );
    }
    if (s.recent.length > limit) console.log(`    ... ${s.recent.length - limit} more (--all)`);
  }

  console.log(`\n  ${STATS_FILE}`);
  console.log("  --json for machine output · --reset to clear\n");
  return 0;
}

/**
 * Self-update. Replaces the tracked source paths with the latest commit and
 * runs any state migrations, so a user never has to reason about which on-disk
 * formats changed between versions.
 */
async function cmdUpdate(args) {
  const cfg = cfgFromArgs(args);
  const local = installedInfo();

  console.log(`\n  installed   v${local.version}${local.sha ? `  ${local.sha.slice(0, 7)}` : ""}`);
  if (local.updatedAt) console.log(`              updated ${local.updatedAt.slice(0, 16).replace("T", " ")}`);

  let remote;
  try {
    remote = await fetchRemote(cfg);
  } catch (err) {
    console.error(`\n  could not reach GitHub: ${err.message}`);
    console.error("  check your connection, or set update.repo in the config for a fork\n");
    return 1;
  }

  console.log(`  latest      ${remote.version ? `v${remote.version}  ` : ""}${remote.shortSha}  ${remote.message.slice(0, 60)}`);
  if (remote.date) console.log(`              ${remote.date.slice(0, 16).replace("T", " ")}`);

  const upToDate = local.sha && local.sha === remote.sha;
  if (upToDate && !args.force) {
    console.log("\n  already on the latest commit. --force to reinstall anyway.\n");
    // Still migrate: a user who updated by hand may have stale state.
    const m = runMigrations({ quiet: false });
    if (m.migrated) for (const st of m.steps) console.log(`  migrated v${st.version}: ${st.note}`);
    return 0;
  }

  // The remote branch is not guaranteed to be ahead. Installing it blindly is a
  // sync, not an upgrade, and can walk a user backwards onto a version missing
  // features they already rely on.
  const older =
    remote.version && local.version !== "unknown" && compareVersions(remote.version, local.version) < 0;
  if (older && !args.force) {
    console.error(`\n  remote is OLDER than what you have (v${remote.version} < v${local.version}).`);
    console.error("  refusing to downgrade. pass --force if that is really what you want.\n");
    return 1;
  }

  if (args.check) {
    console.log(`\n  update available. run 'jev-skill-gate update' to install it.\n`);
    return 0;
  }

  console.log("\n  downloading ...");
  let res;
  try {
    res = await applyUpdate(remote, { dryRun: !!args["dry-run"] });
  } catch (err) {
    console.error(`\n  update failed: ${err.message}\n`);
    return 1;
  }

  if (args["dry-run"]) {
    console.log(`  would replace: ${res.changed.join(", ")}\n`);
    return 0;
  }

  console.log(`  replaced    ${res.changed.join(", ")}`);

  const m = runMigrations({ quiet: false });
  if (m.migrated) {
    console.log(`  migrated    state v${m.from} -> v${m.to}`);
    for (const st of m.steps) console.log(`              v${st.version}: ${st.note}`);
  } else {
    console.log(`  state       already at v${STATE_VERSION}, nothing to migrate`);
  }

  // Stats survive an update by design: they live under ~/.claude, which the
  // updater never writes to.
  const stats = readStats();
  if (stats.totals.runs > 0) {
    console.log(`  kept        ${stats.totals.runs} recorded runs, ${stats.totals.tokensSaved.toLocaleString("en-US")} tokens saved`);
  }

  console.log(`\n  now on ${remote.shortSha}. run 'jev-skill-gate doctor' to confirm.\n`);
  return 0;
}

/**
 * Runs state migrations on their own.
 *
 * `install.sh` has already copied the new code by the time it needs migrations,
 * so making it call `update --force` would download the whole tarball a second
 * time and turn a network blip into a failure after a successful install.
 */
function cmdMigrate(args) {
  const before = readStateVersion();
  const m = runMigrations({ quiet: false });
  if (!m.migrated) {
    console.log(`state already at v${STATE_VERSION}, nothing to migrate`);
    return 0;
  }
  console.log(`migrated state v${m.from} -> v${m.to}`);
  for (const st of m.steps) console.log(`  v${st.version}: ${st.note}`);
  if (m.error) {
    console.error(`  stopped at v${m.to}: ${m.error}`);
    return 1;
  }
  return 0;
}

async function cmdDoctor(args) {
  const cfg = cfgFromArgs(args);
  const projectDir = resolve(args.dir || process.cwd());
  const resolved = await resolveProvider(cfg);
  const skills = discoverSkills({ projectDir });
  const tokens = skills.reduce((n, s) => n + s.approxTokens, 0);

  const check = (ok, label, detail) => console.log(`  ${ok ? "ok  " : "--  "} ${label}${detail ? `  ${detail}` : ""}`);

  console.log("\njev-skill-gate doctor\n");
  check(Number(process.versions.node.split(".")[0]) >= 18, "node >= 18", `v${process.versions.node}`);
  check(skills.length > 0, "skills discovered", `${skills.length} skills, ~${tokens} tokens`);
  check(
    resolved.id !== FALLBACK_ID,
    "scoring provider",
    resolved.id === FALLBACK_ID ? resolved.reason || "local TF-IDF" : `${resolved.id} (${resolved.provider.label})`
  );
  check(true, "config", CONFIG_PATH);
  const sv = readStateVersion();
  check(
    sv >= STATE_VERSION,
    `state format v${sv}`,
    sv >= STATE_VERSION ? "current" : `behind v${STATE_VERSION} — run 'jev-skill-gate update'`
  );
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
  update      fetch the latest version and migrate on-disk state
  migrate     run state migrations only (update does this for you)
  stats       lifetime tokens saved, cost, and how often it has run
  config      show or set provider, base URL, API key and model
  providers   list scoring providers and which one is selected
  doctor      check the setup
  clear-cache drop cached scores
  hook        internal: run as a Claude Code hook

Options
  --dir <path>              project directory (default: cwd)
  --prompt <text>           score against a request as well as the project
  --provider <id>            select a provider (see 'providers'), or auto | disabled
  --for <id>                (config) edit a provider without selecting it
  --set <key=value>         (config) set one per-provider key; repeatable
  --scope <auto|project|user>  where to write skillOverrides
  --threshold-on <0..1>     full-description cutoff (default 0.6)
  --threshold-name-only <n> name-only cutoff (default 0.25)
  --max-on <n>              hard cap on full descriptions (default 40)
  --no-cache                ignore cached scores
  --check                   (update) report whether a newer version exists
  --force                   (update) reinstall even if already current
  --all                     show every skill in the table
  --verbose / --quiet

Environment
  TYPESAFE_API_KEY          TypeSafe direct
  AI_GATEWAY_API_KEY        Vercel AI Gateway

Hosted Jev is the most accurate option. Local models work too - Open-Jev over
HTTP, laya or laya-mlx as a local process - and cost nothing to run:

  jev-skill-gate config --provider open-jev --base-url http://127.0.0.1:8791

Without any of them it uses a local TF-IDF scorer, so it works with no setup.
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
    providers: cmdProviders,
    stats: cmdStats,
    update: cmdUpdate,
    migrate: cmdMigrate,
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
