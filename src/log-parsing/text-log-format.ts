import { ALL_REDACTION_KINDS, type RedactionKind } from "../redaction/redaction-kinds.js";
import { assembleLogEntries } from "./assemble-log-entries.js";
import { normalizeLevel } from "./log-levels.js";
import type { LineStart, ParseResult } from "./log-entry-types.js";
import { DEFAULT_LANGUAGE, type Language } from "./languages.js";
import { readPythonShapeStart } from "./python-log-shapes.js";
import { toIso } from "./timestamps.js";

const TIMESTAMP = "\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?";
const STARTS_WITH_TIME = new RegExp(`^${TIMESTAMP}(?=\\s|$)`, "i");
const TEXT_LOG_LINE = new RegExp(`^(${TIMESTAMP})\\s+\\[?([A-Za-z]+)\\]?:?(?:\\s+(.*))?$`, "i");

export function readTextStart(line: string): LineStart {
  // The Python shapes are tried only when the original shape does not match,
  // so every line read before is read exactly as before.
  if (!STARTS_WITH_TIME.test(line)) return readPythonShapeStart(line);
  const lineMatch = TEXT_LOG_LINE.exec(line);
  const timestamp = lineMatch?.[1] ? toIso(lineMatch[1]) : undefined;
  const level = lineMatch?.[2] ? normalizeLevel(lineMatch[2]) : undefined;
  if (!timestamp || level === undefined) return { kind: "bad" };
  if (level === null) return { kind: "drop", timestamp };
  return { kind: "entry", timestamp, level, message: lineMatch?.[3] ?? "" };
}

export function parseText(
  lines: string[],
  redactionKinds: readonly RedactionKind[] = ALL_REDACTION_KINDS,
  language: Language = DEFAULT_LANGUAGE,
): ParseResult {
  return assembleLogEntries(lines, readTextStart, redactionKinds, language);
}
