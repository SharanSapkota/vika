import { ALL_REDACTION_KINDS, type RedactionKind } from "../redaction/redaction-kinds.js";
import { buildLogEntry } from "./build-log-entry.js";
import { normalizeLevel } from "./log-levels.js";
import type { LineStart, LogEntry, ParseResult } from "./log-entry-types.js";
import { toIso } from "./timestamps.js";

const ERROR_LINE = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2}:\d{2}) \[(\w+)\] (?:\d+#\d+: )?(?:\*\d+ )?(.*)$/;
const ACCESS_LINE = /^\S+ \S+ \S+ \[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{4})\] "([^"]*)" (\d{3})(?:\s|$)/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function readNginxLine(line: string): LineStart {
  const errorLineMatch = ERROR_LINE.exec(line);
  if (errorLineMatch) {
    const [, year, month, day, time, levelWord = "", message = ""] = errorLineMatch;
    const timestamp = toIso(`${year}-${month}-${day}T${time}Z`);
    const level = normalizeLevel(levelWord);
    if (!timestamp || level === undefined) return { kind: "bad" };
    if (level === null) return { kind: "drop", timestamp };
    return { kind: "entry", timestamp, level, message };
  }

  const accessLineMatch = ACCESS_LINE.exec(line);
  if (accessLineMatch) {
    const [, day, monthName = "", year, time, zone, request, status = ""] = accessLineMatch;
    const month = MONTHS.indexOf(monthName) + 1;
    const timestamp = month > 0 ? toIso(`${year}-${String(month).padStart(2, "0")}-${day}T${time}${zone}`) : undefined;
    if (!timestamp) return { kind: "bad" };
    if (!status.startsWith("5")) return { kind: "drop", timestamp };
    return { kind: "entry", timestamp, level: "ERROR", message: `"${request}" ${status}` };
  }

  return { kind: "none" };
}

export function parseNginx(lines: string[], redactionKinds: readonly RedactionKind[] = ALL_REDACTION_KINDS): ParseResult {
  const entries: LogEntry[] = [];
  let skipped = 0;
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") continue;
    let lineStart: LineStart;
    try {
      lineStart = readNginxLine(line);
    } catch {
      lineStart = { kind: "bad" };
    }
    if (lineStart.kind === "entry") entries.push(buildLogEntry({ ...lineStart, continuationLines: [] }, redactionKinds));
    else if (lineStart.kind !== "drop") skipped++;
  }
  return { entries, skipped };
}
