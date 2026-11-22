import { ALL_REDACTION_KINDS, type RedactionKind } from "../redaction/redaction-kinds.js";
import { detectFormat } from "./detect-log-format.js";
import { DEFAULT_LANGUAGE, type Language } from "./languages.js";
import { FORMAT_PARSERS } from "./line-readers.js";
import type { LogFormat, ParseResult } from "./log-entry-types.js";



export function parseLines(
  lines: string[],
  format?: LogFormat,
  redactionKinds: readonly RedactionKind[] = ALL_REDACTION_KINDS,
  language: Language = DEFAULT_LANGUAGE,
): ParseResult & { format: LogFormat } {
  const usedFormat = format ?? detectFormat(lines.slice(0, 200));
  return { format: usedFormat, ...FORMAT_PARSERS[usedFormat](lines, redactionKinds, language) };
}
