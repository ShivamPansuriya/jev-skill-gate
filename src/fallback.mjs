import { log } from "./log.mjs";

/**
 * Deterministic local scorer. Runs when no API key is set, when the provider is
 * unreachable, or when the user asks for it. It keeps the tool useful with zero
 * configuration and means a dead key can never leave a session with no skills.
 *
 * TF-IDF cosine over the state text versus each skill's name + description.
 * Deliberately generous: a false negative costs the user a skill they wanted,
 * a false positive costs about sixty tokens.
 */

const STOP = new Set(
  ("a an and are as at be by for from has have in into is it its of on or that the to " +
    "with when use used using this these those you your claude skill skills code " +
    "will can should would about after before over under not no yes if then else " +
    "user agent tool tools run runs running").split(" ")
);

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((t) => t.length > 1 && t.length < 40 && !STOP.has(t));
}

function flattenState(state) {
  if (typeof state === "string") return state;
  const parts = [];
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === "string" || typeof v === "number") parts.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(state);
  return parts.join(" ");
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

export function scoreLocally(skills, state) {
  const stateTokens = tokenize(flattenState(state));
  const stateTf = termFreq(stateTokens);

  const docs = skills.map((s) => termFreq(tokenize(`${s.name} ${s.name.replace(/[-:]/g, " ")} ${s.description}`)));

  // Inverse document frequency across the skill corpus.
  const df = new Map();
  for (const doc of docs) for (const t of doc.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = Math.max(1, docs.length);
  const idf = (t) => Math.log(1 + N / (1 + (df.get(t) || 0)));

  const raw = docs.map((doc) => {
    let dot = 0;
    let docNorm = 0;
    let stateNorm = 0;
    for (const [t, f] of doc) {
      const w = f * idf(t);
      docNorm += w * w;
      const sf = stateTf.get(t);
      if (sf) dot += w * (sf * idf(t));
    }
    for (const [t, f] of stateTf) {
      const w = f * idf(t);
      stateNorm += w * w;
    }
    if (dot === 0 || docNorm === 0 || stateNorm === 0) return 0;
    return dot / (Math.sqrt(docNorm) * Math.sqrt(stateNorm));
  });

  // Rank-percentile, not divide-by-max. A single strong match would otherwise
  // flatten every other skill to ~0 and the gate would hide almost everything.
  const order = raw
    .map((v, i) => [v, i])
    .sort((a, b) => b[0] - a[0])
    .map(([, i]) => i);

  const scores = new Map();
  const n = Math.max(1, skills.length - 1);
  order.forEach((skillIdx, rank) => {
    const pct = 1 - rank / n;
    // Zero overlap means no evidence at all, not "ranked last".
    scores.set(skills[skillIdx].name, raw[skillIdx] > 0 ? pct : 0);
  });

  const matched = raw.filter((v) => v > 0).length;
  log.debug(`local scorer ranked ${skills.length} skills, ${matched} with any term overlap`);

  return {
    scores,
    // These are ranks, not probabilities. The planner must not read them as
    // calibrated confidence, which is the one thing Jev actually provides.
    calibrated: false,
    signalStrength: stateTokens.length,
    usage: { inputTokens: 0, outputTokens: 0, batches: 0 },
    costUsd: 0,
  };
}
