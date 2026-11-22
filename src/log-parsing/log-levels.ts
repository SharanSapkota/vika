import type { Level } from "./log-entry-types.js";

const LEVEL_WORDS: Record<string, Level | null> = {
  emerg: "ERROR",
  alert: "ERROR",
  fatal: "ERROR",
  crit: "ERROR",
  critical: "ERROR",
  error: "ERROR",
  err: "ERROR",
  warn: "WARN",
  warning: "WARN",
  notice: null,
  info: null,
  debug: null,
  trace: null,
};

export function normalizeLevel(word: string): Level | null | undefined {
  return LEVEL_WORDS[word.toLowerCase()];
}
