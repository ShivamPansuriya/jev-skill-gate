import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { CLAUDE_DIR } from "./config.mjs";
import { log } from "./log.mjs";

const FRONTMATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/;

/**
 * Minimal YAML-subset reader. SKILL.md frontmatter is flat scalars plus the
 * occasional folded string, which is all we need: name, description, and the
 * two invocation flags. A full YAML parser would be a dependency for nothing.
 */
function parseFrontmatter(text) {
  const m = FRONTMATTER.exec(text);
  if (!m) return null;
  const body = m[1];
  const out = {};
  const lines = body.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2];

    // Folded / continued scalar: subsequent more-indented lines belong to it.
    if (value === "" || value === ">" || value === "|" || value === ">-" || value === "|-") {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        parts.push(lines[++i].trim());
      }
      value = parts.join(" ");
    } else {
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*[A-Za-z0-9_-]+:/.test(lines[i + 1])) {
        value += " " + lines[++i].trim();
      }
    }

    value = value.trim().replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

function readSkill(skillMdPath, { source, namespace }) {
  let raw;
  try {
    raw = readFileSync(skillMdPath, "utf8").slice(0, 8000);
  } catch {
    return null;
  }
  const fm = parseFrontmatter(raw);
  if (!fm) return null;

  const dirName = basename(join(skillMdPath, ".."));
  const bare = (fm.name || dirName).trim();
  if (!bare) return null;

  const name = namespace ? `${namespace}:${bare}` : bare;
  const description = (fm.description || "").trim();

  return {
    name,
    bare,
    namespace: namespace || null,
    description,
    path: skillMdPath,
    source,
    // A skill Claude already cannot auto-invoke costs no description tokens,
    // so gating it would be busywork.
    modelInvocable: String(fm["disable-model-invocation"]).toLowerCase() !== "true",
    userInvocable: String(fm["user-invocable"]).toLowerCase() !== "false",
    approxTokens: Math.round((bare.length + description.length + 4) / 3.8),
  };
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function scanSkillsDir(skillsDir, opts) {
  const found = [];
  for (const name of listDirs(skillsDir)) {
    const p = join(skillsDir, name, "SKILL.md");
    if (!existsSync(p)) continue;
    const s = readSkill(p, opts);
    if (s) found.push(s);
  }
  return found;
}

function readJsonSafe(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Which plugins are switched on, merged across the settings files the way
 * Claude Code layers them. Keys look like "<plugin>@<marketplace>".
 */
function enabledPluginIds(projectDir) {
  const enabled = {};
  const files = [
    join(CLAUDE_DIR, "settings.json"),
    join(CLAUDE_DIR, "settings.local.json"),
    projectDir && join(projectDir, ".claude", "settings.json"),
    projectDir && join(projectDir, ".claude", "settings.local.json"),
  ].filter(Boolean);

  for (const f of files) {
    const j = readJsonSafe(f);
    if (j?.enabledPlugins) Object.assign(enabled, j.enabledPlugins);
  }
  return new Set(Object.entries(enabled).filter(([, on]) => on === true).map(([id]) => id));
}

/**
 * Plugin skills are namespaced `plugin:skill`.
 *
 * The install manifest is the source of truth. Walking the plugin tree instead
 * picks up every marketplace listing and every stale version directory, which
 * on a well-used machine is several times the number of skills Claude Code
 * actually loads.
 */
function scanEnabledPlugins(projectDir) {
  const found = [];
  const manifest = readJsonSafe(join(CLAUDE_DIR, "plugins", "installed_plugins.json"));
  if (!manifest?.plugins) return found;

  const enabled = enabledPluginIds(projectDir);

  for (const [id, installs] of Object.entries(manifest.plugins)) {
    if (!enabled.has(id)) continue;
    const pluginName = id.split("@")[0];
    // Newest install wins when several versions are recorded.
    const sorted = [...(installs || [])].sort(
      (a, b) => new Date(b.lastUpdated || b.installedAt || 0) - new Date(a.lastUpdated || a.installedAt || 0)
    );
    const install = sorted[0];
    if (!install?.installPath) continue;

    const skillsDir = join(install.installPath, "skills");
    if (!existsSync(skillsDir)) continue;
    found.push(...scanSkillsDir(skillsDir, { source: "plugin", namespace: pluginName }));
  }
  return found;
}

/**
 * Discovers every skill we are able to see on disk.
 *
 * Bundled skills (/debug, /code-review, ...) ship inside the Claude Code binary
 * and cannot be enumerated from the filesystem. We deliberately never emit
 * overrides for a name we did not discover, so they are left untouched.
 */
export function discoverSkills({ projectDir = process.cwd() } = {}) {
  const skills = [];

  skills.push(...scanSkillsDir(join(CLAUDE_DIR, "skills"), { source: "personal" }));
  skills.push(...scanEnabledPlugins(projectDir));

  if (projectDir) {
    skills.push(...scanSkillsDir(join(projectDir, ".claude", "skills"), { source: "project" }));
  }

  // Project skills win over personal ones of the same name, matching Claude Code.
  const byName = new Map();
  const rank = { personal: 1, plugin: 1, project: 2 };
  for (const s of skills) {
    const prev = byName.get(s.name);
    if (!prev || rank[s.source] >= rank[prev.source]) byName.set(s.name, s);
  }

  const out = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  log.debug(`discovered ${out.length} skills (${out.reduce((n, s) => n + s.approxTokens, 0)} approx tokens)`);
  return out;
}

export const _internal = { parseFrontmatter };
