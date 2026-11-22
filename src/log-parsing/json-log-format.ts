// JSON log lines (pino, bunyan, winston and similar).
import { ALL_REDACTION_KINDS, type RedactionKind } from "../redaction/redaction-kinds.js";
import { assembleLogEntries } from "./assemble-log-entries.js";
import { normalizeLevel } from "./log-levels.js";
import type { Level, LineStart, ParseResult } from "./log-entry-types.js";
import { epochToIso, toIso } from "./timestamps.js";

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

// The keys ("time", "ts", "lvl", ...) are what loggers write, so they stay as they are.
function readTime(jsonObject: JsonObject): string | undefined {
  const value = jsonObject.time ?? jsonObject.timestamp ?? jsonObject.ts ?? jsonObject["@timestamp"];
  if (typeof value === "string") return toIso(value);
  if (typeof value === "number") return epochToIso(value);
  return undefined;
}

// undefined/null both mean "not a level we keep".
function readLevel(jsonObject: JsonObject): Level | null | undefined {
  const value = jsonObject.level ?? jsonObject.severity ?? jsonObject.lvl;
  if (typeof value === "string") return normalizeLevel(value);
  if (typeof value === "number") return value >= 50 ? "ERROR" : value >= 40 ? "WARN" : null;
  return undefined;
}

export function readJsonStart(line: string): LineStart {
  if (!line.trimStart().startsWith("{")) return { kind: "none" };
  let parsedLine: unknown;
  try {
    parsedLine = JSON.parse(line);
  } catch {
    return { kind: "bad" };
  }
  if (!isJsonObject(parsedLine)) return { kind: "bad" };
  const timestamp = readTime(parsedLine);
  if (!timestamp) return { kind: "bad" };
  const level = readLevel(parsedLine);
  if (!level) return { kind: "drop", timestamp };

  const errorField = isJsonObject(parsedLine.err) ? parsedLine.err : isJsonObject(parsedLine.error) ? parsedLine.error : {};
  const message = firstString(parsedLine.msg, parsedLine.message, errorField.message) ?? "";
  const stack = firstString(parsedLine.stack, errorField.stack);
  return stack === undefined
    ? { kind: "entry", timestamp, level, message }
    : { kind: "entry", timestamp, level, message, stack };
}

export function parseJson(lines: string[], redactionKinds: readonly RedactionKind[] = ALL_REDACTION_KINDS): ParseResult {
  return assembleLogEntries(lines, readJsonStart, redactionKinds);
}
