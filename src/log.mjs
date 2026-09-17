const LEVELS = { silent: 0, info: 1, debug: 2 };

let current = "info";

export function setLogLevel(level) {
  if (level in LEVELS) current = level;
}

/**
 * Everything goes to stderr. A SessionStart hook's stdout is fed to Claude as
 * context, so writing logs there would inject noise into every session.
 */
function emit(level, args) {
  if (LEVELS[current] < LEVELS[level]) return;
  process.stderr.write(`[jev-skill-gate] ${args.join(" ")}\n`);
}

export const log = {
  info: (...a) => emit("info", a),
  debug: (...a) => emit("debug", a),
  warn: (...a) => emit("info", ["warn:", ...a]),
  error: (...a) => process.stderr.write(`[jev-skill-gate] error: ${a.join(" ")}\n`),
};
