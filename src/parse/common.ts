import { redact } from "../redact.js";
import type { Frame, Level, LogEntry, ParseResult } from "./types.js";

export type LineStart =
  | { kind: "entry"; timestamp: string; level: Level; message: string; stack?: string }
  | { kind: "drop"; timestamp: string } // a fine line, but a level we don't keep (INFO, DEBUG, ...)
  | { kind: "bad" } // looks like a log line but is broken: counted as skipped
  | { kind: "none" }; // not the start of an entry (maybe a stack trace line)

const ISO = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/i;

export function toIso(text: string): string | undefined {
  const m = ISO.exec(text.trim());
  if (!m) return undefined;
  const [, date, time, fraction = "", zone = "Z"] = m;
  const ms = (fraction + "000").slice(0, 3);
  const tz = zone.toUpperCase() === "Z" ? "Z" : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return isoOrUndefined(Date.parse(`${date}T${time}.${ms}${tz}`));
}

export function epochToIso(value: number): string | undefined {
  return isoOrUndefined(value < 1e11 ? value * 1000 : value);
}

function isoOrUndefined(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const LEVELS: Record<string, Level | null> = {
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
  return LEVELS[word.toLowerCase()];
}

const FRAME = /^\s*at\s+(?:(.+?)\s+\((.+):(\d+):\d+\)|(.+):(\d+):\d+)\s*$/;

export function parseFrame(line: string): Frame | undefined {
  const m = FRAME.exec(line);
  if (!m) return undefined;
  if (m[2] !== undefined) return { fn: m[1] as string, file: m[2], line: Number(m[3]) };
  return { file: m[4] as string, line: Number(m[5]) };
}

const CONTINUATION = /^(?:\s|[\w$.]*(?:Error|Exception)(?::|$)|Caused by:)/;

interface Draft {
  timestamp: string;
  level: Level;
  message: string;
  extra: string[]; // continuation lines (stack trace)
}

export function makeEntry(draft: Draft): LogEntry {
  const frames: Frame[] = [];
  const messageLines = [draft.message.trim()];
  for (const line of draft.extra) {
    const frame = parseFrame(line);
    if (frame) frames.push(frame);
    // "at ..." lines we can't read (e.g. "at async Promise.all (index 0)") are left out.
    else if (!/^\s*at\s/.test(line) && line.trim() !== "") messageLines.push(line.trim());
  }
  const safeFrames = frames.map((f) => (f.fn === undefined ? { file: redact(f.file), line: f.line } : { file: redact(f.file), line: f.line, fn: redact(f.fn) }));
  const entry: LogEntry = {
    timestamp: draft.timestamp,
    level: draft.level,
    message: redact(messageLines.filter((l) => l !== "").join("\n")),
    frames: safeFrames,
  };
  const top = safeFrames[0];
  if (top) {
    entry.file = top.file;
    entry.lineNumber = top.line;
  }
  return entry;
}

export function assemble(lines: string[], readStart: (line: string) => LineStart): ParseResult {
  const entries: LogEntry[] = [];
  let skipped = 0;
  let current: Draft | "ignored" | null = null;

  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;

    let start: LineStart;
    try {
      start = readStart(line);
    } catch {
      start = { kind: "bad" }; // never let one line crash the run
    }

    if (start.kind === "none") {
      if (current === null || !CONTINUATION.test(line)) skipped++;
      else if (current !== "ignored") current.extra.push(line);
      continue;
    }

    if (current !== null && current !== "ignored") entries.push(makeEntry(current));
    if (start.kind === "entry") {
      current = {
        timestamp: start.timestamp,
        level: start.level,
        message: start.message,
        extra: start.stack ? start.stack.split("\n") : [],
      };
    } else {
      if (start.kind === "bad") skipped++;
      current = "ignored";
    }
  }
  if (current !== null && current !== "ignored") entries.push(makeEntry(current));
  return { entries, skipped };
}
