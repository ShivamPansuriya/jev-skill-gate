import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Paths live in their own module so that the provider registry can find the
 * plugin directory without importing config.mjs, which imports the registry.
 */
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const CONFIG_PATH = join(CLAUDE_DIR, "jev-skill-gate.json");
export const STATE_DIR = join(CLAUDE_DIR, "jev-skill-gate");
