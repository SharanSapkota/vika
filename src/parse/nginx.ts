
import { makeEntry, normalizeLevel, toIso, type LineStart } from "./common.js";
import type { LogEntry, ParseResult } from "./types.js";

const ERROR_LINE = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2}) \[(\w+)\] (?:\d+#\d+: )?(?:\*\d+ )?(.*)$/;
const ACCESS_LINE = /^\S+ \S+ \S+ \[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{4})\] "([^"]*)" (\d{3})(?:\s|$)/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function readNginxLine(line: string): LineStart {
  const e = ERROR_LINE.exec(line);
  if (e) {
    const [, year, month, day, time, word = "", message = ""] = e;
    const timestamp = toIso(`${year}-${month}-${day}T${time}Z`);
    const level = normalizeLevel(word);
    if (!timestamp || level === undefined) return { kind: "bad" };
    if (level === null) return { kind: "drop", timestamp };
    return { kind: "entry", timestamp, level, message };
  }

  const a = ACCESS_LINE.exec(line);
  if (a) {
    const [, day, monthName = "", year, time, zone, request, status = ""] = a;
    const month = MONTHS.indexOf(monthName) + 1;
    const timestamp = month > 0 ? toIso(`${year}-${String(month).padStart(2, "0")}-${day}T${time}${zone}`) : undefined;
    if (!timestamp) return { kind: "bad" };
    if (!status.startsWith("5")) return { kind: "drop", timestamp };
    return { kind: "entry", timestamp, level: "ERROR", message: `"${request}" ${status}` };
  }

  return { kind: "none" };
}

// nginx never writes stack traces, so every line stands alone.
export function parseNginx(lines: string[]): ParseResult {
  const entries: LogEntry[] = [];
  let skipped = 0;
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    let start: LineStart;
    try {
      start = readNginxLine(line);
    } catch {
      start = { kind: "bad" };
    }
    if (start.kind === "entry") entries.push(makeEntry({ ...start, extra: [] }));
    else if (start.kind !== "drop") skipped++;
  }
  return { entries, skipped };
}
