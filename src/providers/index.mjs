import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { STATE_DIR } from "../paths.mjs";
import { log } from "../log.mjs";
import { defineProvider } from "./spec.mjs";

import typesafe from "./typesafe.mjs";
import gateway from "./gateway.mjs";
import openJev from "./open-jev.mjs";
import laya from "./laya.mjs";
import layaMlx from "./laya-mlx.mjs";
import localTfidf from "./local-tfidf.mjs";

/**
 * The id every provider degrades to. It needs no key and no network, so it can
 * always run, which is the only reason the gate is safe to install at all.
 */
export const FALLBACK_ID = "fallback";

/** Where a user drops their own provider module. */
export const USER_PROVIDER_DIR = join(STATE_DIR, "providers");

/**
 * Built-ins are imported statically rather than scanned off disk. A dynamic
 * scan of our own directory would look tidier and would break the moment the
 * tool is bundled or installed read-only.
 */
const BUILTIN = [typesafe, gateway, openJev, laya, layaMlx, localTfidf];

let cache = null;

/**
 * Loads user-supplied providers from ~/.claude/jev-skill-gate/providers/*.mjs.
 *
 * A broken plugin is reported and skipped, never fatal. The alternative - one
 * bad file taking down skill gating for every session - is a much worse trade
 * than running without that provider.
 */
async function loadUserProviders() {
  if (!existsSync(USER_PROVIDER_DIR)) return [];
  const out = [];
  let entries;
  try {
    entries = readdirSync(USER_PROVIDER_DIR).filter((f) => f.endsWith(".mjs") || f.endsWith(".js"));
  } catch (err) {
    log.warn(`cannot read ${USER_PROVIDER_DIR}: ${err.message}`);
    return [];
  }
  for (const file of entries.sort()) {
    const path = join(USER_PROVIDER_DIR, file);
    try {
      const mod = await import(pathToFileURL(path).href);
      const def = mod.default;
      if (!def) throw new Error("module has no default export");
      // Re-validate: a hand-written plugin may not have called defineProvider.
      out.push({ ...defineProvider(def), source: path });
    } catch (err) {
      log.warn(`ignoring provider plugin ${file}: ${err.message}`);
    }
  }
  return out;
}

/**
 * Every known provider, by id. User plugins load last and may replace a
 * built-in of the same id, which is how someone points "gateway" at a proxy of
 * their own without patching the tool.
 */
export async function loadProviders() {
  if (cache) return cache;
  const byId = new Map();
  for (const p of BUILTIN) byId.set(p.id, { ...p, source: "builtin" });
  for (const p of await loadUserProviders()) byId.set(p.id, p);
  cache = byId;
  return byId;
}

/** Test seam: forget what was loaded so a later call re-scans the plugin dir. */
export function resetProviderCache() {
  cache = null;
}

/** Per-provider settings: the provider's own defaults under the user's config. */
export function providerConfig(cfg, provider) {
  return { ...(provider.defaults || {}), ...(cfg.providers?.[provider.id] || {}) };
}

/**
 * Finds the API key for a provider.
 *
 * Environment first, config file second. A variable is per-shell, easy to
 * rotate, and cannot be committed by accident; the config field exists only
 * because not every setup has a convenient place to export one.
 */
export function providerKey(cfg, provider) {
  for (const name of provider.envKeys || []) {
    if (process.env[name]) return process.env[name];
  }
  return providerConfig(cfg, provider).apiKey || null;
}

/**
 * Decides which provider this run uses.
 *
 * Returns { id, provider, conf, apiKey } on success, or a fallback entry
 * carrying `reason`. Never throws: a misconfigured provider name degrades to
 * the local scorer with an explanation rather than killing the session.
 */
export async function resolveProvider(cfg) {
  const providers = await loadProviders();
  const fallback = (reason) => ({
    id: FALLBACK_ID,
    provider: providers.get(FALLBACK_ID),
    conf: {},
    apiKey: null,
    reason,
  });

  const want = cfg.provider || "auto";
  if (want === "disabled") return { id: "disabled", provider: null, conf: {}, apiKey: null };

  const ready = (provider) => {
    const conf = providerConfig(cfg, provider);
    const apiKey = providerKey(cfg, provider);
    if (provider.requiresKey && !apiKey) {
      const where = (provider.envKeys || []).join(" or ") || `providers.${provider.id}.apiKey`;
      return fallback(`no key for "${provider.id}" (set ${where})`);
    }
    return { id: provider.id, provider, conf, apiKey };
  };

  if (want !== "auto") {
    const provider = providers.get(want);
    if (!provider) {
      const known = [...providers.keys()].join(", ");
      return fallback(`unknown provider "${want}" (known: ${known})`);
    }
    return ready(provider);
  }

  // auto: the first hosted provider that has a key wins.
  //
  // Local providers are deliberately skipped here. Probing localhost on every
  // session to see whether a server happens to be listening would add latency
  // to the common case where it is not; running one is an explicit choice, so
  // selecting it is too.
  for (const provider of providers.values()) {
    if (provider.id === FALLBACK_ID || provider.local) continue;
    if (!provider.requiresKey || providerKey(cfg, provider)) return ready(provider);
  }
  return fallback("no API key found in environment or config");
}
