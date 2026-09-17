import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";

function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
  } catch {
    return "";
  }
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const MANIFESTS = [
  ["package.json", "javascript/typescript"],
  ["tsconfig.json", "typescript"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["pom.xml", "java/maven"],
  ["build.gradle", "java/gradle"],
  ["build.gradle.kts", "kotlin/gradle"],
  ["composer.json", "php"],
  ["Gemfile", "ruby"],
  ["CMakeLists.txt", "c++"],
  ["Package.swift", "swift"],
  ["pubspec.yaml", "dart/flutter"],
  ["Dockerfile", "docker"],
  ["docker-compose.yml", "docker"],
  [".github/workflows", "github actions"],
  ["terraform.tf", "terraform"],
];

/**
 * Builds the `state` we hand to Jev at session start. There is no user prompt
 * yet at SessionStart, so relevance is judged against what the project *is*:
 * its stack, its layout, and what has been worked on recently.
 */
export function collectSignals(projectDir = process.cwd()) {
  const signals = {
    project_name: basename(projectDir),
    stack: [],
    top_level_dirs: [],
    recent_commits: [],
    branch: "",
    readme_excerpt: "",
    dependencies: [],
  };

  for (const [file, label] of MANIFESTS) {
    if (existsSync(join(projectDir, file)) && !signals.stack.includes(label)) {
      signals.stack.push(label);
    }
  }

  const pkg = readJson(join(projectDir, "package.json"));
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    signals.dependencies = Object.keys(deps).slice(0, 40);
  }

  try {
    signals.top_level_dirs = readdirSync(projectDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => d.name)
      .slice(0, 25);
  } catch {
    /* unreadable cwd */
  }

  signals.branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], projectDir);
  const logOut = sh("git", ["log", "-12", "--pretty=format:%s"], projectDir);
  if (logOut) signals.recent_commits = logOut.split("\n").slice(0, 12);

  for (const name of ["README.md", "readme.md", "README.rst"]) {
    const p = join(projectDir, name);
    if (existsSync(p)) {
      try {
        signals.readme_excerpt = readFileSync(p, "utf8").slice(0, 1200).replace(/\s+/g, " ").trim();
      } catch {
        /* ignore */
      }
      break;
    }
  }

  // Drop empties so the state stays small and the cache key stays stable.
  for (const k of Object.keys(signals)) {
    const v = signals[k];
    if (v === "" || (Array.isArray(v) && v.length === 0)) delete signals[k];
  }
  return signals;
}

/**
 * Per-prompt mode adds the user's actual request on top of the project signals.
 */
export function withPrompt(signals, prompt) {
  if (!prompt) return signals;
  return { ...signals, current_request: String(prompt).slice(0, 4000) };
}
