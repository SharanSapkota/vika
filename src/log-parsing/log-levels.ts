// Maps the level words different loggers use onto the two levels we keep.
import type { Level } from "./log-entry-types.js";

// null = a known level we don't keep.
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

// undefined = not a level word at all.
export function normalizeLevel(word: string): Level | null | undefined {
  return LEVEL_WORDS[word.toLowerCase()];
}
