import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, cpSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { log } from "./log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = join(HERE, "..");
const STAMP_PATH = join(PKG_ROOT, ".jev-install.json");

const DEFAULT_REPO = "ShivamPansuriya/jev-skill-gate";
const DEFAULT_BRANCH = "main";

/**
 * Only these paths are replaced by an update. Everything else in the install
 * directory is left alone, and user state under ~/.claude is never touched at
 * all - that is what migrations are for.
 *
 * `eval/` is deliberately NOT tracked. A user who runs the eval writes their own
 * raw-scores.json there, and replacing it with the repository's copy would
 * destroy their results silently. Reference material is not worth that; re-clone
 * to refresh it.
 */
const TRACKED = ["src", "bin", "package.json", "README.md", "LICENSE", "install.sh"];

const LOCK_PATH = join(PKG_ROOT, ".jev-update.lock");
const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * HAZARD: two updates at once can interleave a backup with a half-written copy.
 * A lock is cheap insurance on an operation that rewrites the tool's own code.
 * A lock older than ten minutes is assumed abandoned and taken over.
 */
function acquireLock() {
  try {
    if (existsSync(LOCK_PATH)) {
      const held = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
      const age = Date.now() - new Date(held.at).getTime();
      if (age < LOCK_STALE_MS) {
        throw new Error(`another update is in progress (pid ${held.pid}); wait for it or remove ${LOCK_PATH}`);
      }
    }
  } catch (err) {
    if (/another update is in progress/.test(err.message)) throw err;
    // An unreadable lock is treated as stale rather than blocking forever.
  }
  writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n");
}

function releaseLock() {
  try {
    if (existsSync(LOCK_PATH)) rmSync(LOCK_PATH, { force: true });
  } catch {
    /* a stranded lock goes stale on its own */
  }
}

/** Compares dotted versions. -1 a<b, 0 equal, 1 a>b. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function repoOf(cfg) {
  return { repo: cfg?.update?.repo || DEFAULT_REPO, branch: cfg?.update?.branch || DEFAULT_BRANCH };
}

export function installedInfo() {
  let version = "unknown";
  try {
    version = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version;
  } catch {
    /* keep unknown */
  }
  const stamp = existsSync(STAMP_PATH) ? JSON.parse(readFileSync(STAMP_PATH, "utf8")) : {};
  return { root: PKG_ROOT, version, sha: stamp.sha || null, updatedAt: stamp.updatedAt || null };
}

async function getJson(url, timeoutMs = 15000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "jev-skill-gate" },
      signal: c.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchRemote(cfg) {
  const { repo, branch } = repoOf(cfg);
  const commit = await getJson(`https://api.github.com/repos/${repo}/commits/${branch}`);
  let version = null;
  try {
    const pkgMeta = await getJson(`https://api.github.com/repos/${repo}/contents/package.json?ref=${branch}`);
    if (pkgMeta?.content) {
      version = JSON.parse(Buffer.from(pkgMeta.content, "base64").toString("utf8")).version;
    }
  } catch {
    /* version is a nicety; the sha is what decides */
  }
  return {
    sha: commit.sha,
    shortSha: String(commit.sha).slice(0, 7),
    message: commit.commit?.message?.split("\n")[0] || "",
    date: commit.commit?.author?.date || null,
    version,
    repo,
    branch,
  };
}

function haveTar() {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Downloads the tarball for one commit and lays the tracked paths over the
 * install directory.
 *
 * The existing install is copied aside first. If extraction produces something
 * that does not look like this project, nothing is replaced - better to abort
 * than to leave a half-written tool that cannot even run `update` again.
 */
export async function applyUpdate(remote, { dryRun = false } = {}) {
  if (!haveTar()) {
    throw new Error("`tar` is required to unpack the update; install it or re-clone the repository");
  }

  acquireLock();
  const work = mkdtempSync(join(tmpdir(), "jev-update-"));
  const tarPath = join(work, "src.tar.gz");
  const url = `https://codeload.github.com/${remote.repo}/tar.gz/${remote.sha}`;

  try {
    const res = await fetch(url, { headers: { "User-Agent": "jev-skill-gate" } });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    writeFileSync(tarPath, Buffer.from(await res.arrayBuffer()));

    execFileSync("tar", ["xzf", tarPath, "-C", work], { stdio: "ignore" });
    const extracted = join(work, `jev-skill-gate-${remote.sha}`);
    if (!existsSync(extracted)) throw new Error("unexpected archive layout");

    // Sanity gate: refuse to overwrite with something that is not this project.
    for (const must of ["package.json", "bin", "src"]) {
      if (!existsSync(join(extracted, must))) throw new Error(`archive is missing ${must}; refusing to overwrite`);
    }

    const changed = TRACKED.filter((p) => existsSync(join(extracted, p)));
    if (dryRun) return { changed, backup: null };

    const backup = join(work, "backup");
    mkdirSync(backup, { recursive: true });
    for (const p of TRACKED) {
      const from = join(PKG_ROOT, p);
      if (existsSync(from)) cpSync(from, join(backup, p), { recursive: true });
    }

    try {
      for (const p of changed) {
        cpSync(join(extracted, p), join(PKG_ROOT, p), { recursive: true, force: true });
      }
    } catch (err) {
      // Put back what we had, then surface the original failure.
      for (const p of TRACKED) {
        const b = join(backup, p);
        if (existsSync(b)) cpSync(b, join(PKG_ROOT, p), { recursive: true, force: true });
      }
      throw new Error(`update failed and was rolled back: ${err.message}`);
    }

    // Verify BEFORE the backup is discarded. Verifying after applyUpdate returns
    // would be too late: the workspace holding the only copy of the old install
    // is deleted on the way out, leaving nothing to roll back to.
    const rollback = (why) => {
      for (const p of TRACKED) {
        const b = join(backup, p);
        if (existsSync(b)) cpSync(b, join(PKG_ROOT, p), { recursive: true, force: true });
      }
      throw new Error(`${why}; rolled back to the previous version`);
    };

    const entry = join(PKG_ROOT, "bin", "jev-skill-gate.mjs");
    if (!existsSync(entry)) rollback("entrypoint missing after copy");
    try {
      execFileSync(process.execPath, ["--check", entry], { stdio: "ignore" });
    } catch (err) {
      rollback(`the updated copy does not parse (${err.message.split("\n")[0]})`);
    }

    // A version that cannot update itself is a dead end: the user would have to
    // re-clone by hand to recover. Refuse to be the update that removes updating.
    try {
      const help = execFileSync(process.execPath, [entry, "--help"], { encoding: "utf8", timeout: 20000 });
      if (!/^\s*update\s/m.test(help)) {
        rollback("the fetched version has no `update` command, so updating again would be impossible");
      }
    } catch (err) {
      if (/rolled back/.test(err.message)) throw err;
      rollback(`the updated copy could not run (${String(err.message).split("\n")[0]})`);
    }

    writeFileSync(
      STAMP_PATH,
      JSON.stringify(
        { sha: remote.sha, version: remote.version, updatedAt: new Date().toISOString(), repo: remote.repo },
        null,
        2
      ) + "\n"
    );

    return { changed, backup };
  } finally {
    releaseLock();
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      log.debug("could not clean the update workspace");
    }
  }
}
