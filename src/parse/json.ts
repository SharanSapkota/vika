
import { assemble, epochToIso, normalizeLevel, toIso, type LineStart } from "./common.js";
import type { Level, ParseResult } from "./types.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function firstString(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === "string");
}

function readTime(obj: Obj): string | undefined {
  const value = obj.time ?? obj.timestamp ?? obj.ts ?? obj["@timestamp"];
  if (typeof value === "string") return toIso(value);
  if (typeof value === "number") return epochToIso(value);
  return undefined;
}

// undefined/null both mean "not a level we keep".
function readLevel(obj: Obj): Level | null | undefined {
  const value = obj.level ?? obj.severity ?? obj.lvl;
  if (typeof value === "string") return normalizeLevel(value);
  if (typeof value === "number") return value >= 50 ? "ERROR" : value >= 40 ? "WARN" : null;
  return undefined;
}

export function readJsonStart(line: string): LineStart {
  if (!line.trimStart().startsWith("{")) return { kind: "none" };
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { kind: "bad" };
  }
  if (!isObj(obj)) return { kind: "bad" };
  const timestamp = readTime(obj);
  if (!timestamp) return { kind: "bad" };
  const level = readLevel(obj);
  if (!level) return { kind: "drop", timestamp };

  const err = isObj(obj.err) ? obj.err : isObj(obj.error) ? obj.error : {};
  const message = firstString(obj.msg, obj.message, err.message) ?? "";
  const stack = firstString(obj.stack, err.stack);
  return stack === undefined
    ? { kind: "entry", timestamp, level, message }
    : { kind: "entry", timestamp, level, message, stack };
}

export function parseJson(lines: string[]): ParseResult {
  return assemble(lines, readJsonStart);
}
