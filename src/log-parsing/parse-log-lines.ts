// Turns log lines in any supported format into normalized entries.
import { ALL_REDACTION_KINDS, type RedactionKind } from "../redaction/redaction-kinds.js";
import { detectFormat } from "./detect-log-format.js";
import { FORMAT_PARSERS } from "./line-readers.js";
import type { LogFormat, ParseResult } from "./log-entry-types.js";

// Parses lines in the given format, or detects it from the first 200 lines.
// Redacts the given kinds (default: all four).
export function parseLines(
  lines: string[],
  format?: LogFormat,
  redactionKinds: readonly RedactionKind[] = ALL_REDACTION_KINDS,
): ParseResult & { format: LogFormat } {
  const usedFormat = format ?? detectFormat(lines.slice(0, 200));
  return { format: usedFormat, ...FORMAT_PARSERS[usedFormat](lines, redactionKinds) };
}
