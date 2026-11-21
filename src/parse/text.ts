
import { assemble, normalizeLevel, toIso, type LineStart } from "./common.js";
import type { ParseResult } from "./types.js";

const TIMESTAMP = "\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?";
const STARTS_WITH_TIME = new RegExp(`^${TIMESTAMP}(?=\\s|$)`, "i");
const LINE = new RegExp(`^(${TIMESTAMP})\\s+\\[?([A-Za-z]+)\\]?:?(?:\\s+(.*))?$`, "i");

export function readTextStart(line: string): LineStart {
  if (!STARTS_WITH_TIME.test(line)) return { kind: "none" };
  const m = LINE.exec(line);
  const timestamp = m?.[1] ? toIso(m[1]) : undefined;
  const level = m?.[2] ? normalizeLevel(m[2]) : undefined;
  if (!timestamp || level === undefined) return { kind: "bad" };
  if (level === null) return { kind: "drop", timestamp };
  return { kind: "entry", timestamp, level, message: m?.[3] ?? "" };
}

export function parseText(lines: string[]): ParseResult {
  return assemble(lines, readTextStart);
}
