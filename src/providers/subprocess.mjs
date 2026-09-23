import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { log } from "../log.mjs";

/**
 * Shared plumbing for providers that are a local process rather than a server.
 *
 * Two of the three open Jev reimplementations ship no HTTP surface at all -
 * laya is a Python library and laya-mlx is a one-shot CLI - so the only way to
 * reach them is to run them. That is slower and messier than a socket, and it
 * is still worth having: it is the difference between "works on your machine"
 * and "you must first write a server wrapper".
 */

/**
 * Finds the JSON object a tool printed.
 *
 * Model runtimes print progress, load messages and the occasional warning to
 * stdout alongside their result, so taking the whole stream and calling
 * JSON.parse on it fails on a perfectly good run. We scan backwards for the
 * last line that parses, which is the result in every layout seen so far.
 */
export function extractJson(stdout) {
  const lines = String(stdout).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* not this line */
    }
  }
  // Fall back to the whole stream, for a tool that pretty-prints across lines.
  try {
    const start = stdout.indexOf("{");
    if (start >= 0) return JSON.parse(stdout.slice(start));
  } catch {
    /* fall through to the error below */
  }
  throw new Error(`no JSON object in output: ${String(stdout).slice(0, 200)}`);
}

/** Runs a command to completion and returns its stdout. Rejects on non-zero exit. */
export function run(command, args, { timeoutMs = 120000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(new Error(`cannot run ${command}: ${err.message}`));
      return;
    }
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT here means the tool is not installed, which is the single most
      // likely failure and deserves to say so rather than "spawn failed".
      reject(new Error(e.code === "ENOENT" ? `${command} is not installed or not on PATH` : e.message));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${command} exited ${code}: ${err.trim().slice(0, 300) || "(no stderr)"}`));
    });
  });
}

/** Writes payload files to a scratch directory and removes them afterwards. */
export async function withTempFiles(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "jev-gate-"));
  try {
    const paths = {};
    for (const [name, contents] of Object.entries(files)) {
      const p = join(dir, name);
      writeFileSync(p, typeof contents === "string" ? contents : JSON.stringify(contents));
      paths[name] = p;
    }
    return await fn(paths);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      log.debug("could not clean the provider scratch directory");
    }
  }
}

/**
 * Builds the question map both laya runtimes accept, and turns their shared
 * response shape back into scores keyed by skill name.
 *
 * Both projects reimplement the same interface: questions are a dict of
 * { type, instructions }, and the reply is { answers: { id: { noul } } }.
 */
export function layaQuestions(skills, claim) {
  const questions = {};
  const keyToName = new Map();
  skills.forEach((skill, i) => {
    const key = `q${i}`;
    keyToName.set(key, skill.name);
    questions[key] =
      {
        type: "noul",
        instructions:
          `${claim}\n\nSkill name: ${skill.name}\n` +
          `Skill description: ${skill.description || "(no description provided)"}`,
      };
  });
  return { questions, keyToName };
}

export function layaScores(json, keyToName) {
  const answers = json?.answers || {};
  const scores = new Map();
  for (const [key, name] of keyToName) {
    const p = answers[key]?.noul;
    if (typeof p === "number" && Number.isFinite(p)) scores.set(name, Math.min(1, Math.max(0, p)));
  }
  return scores;
}
