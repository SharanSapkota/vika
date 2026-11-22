import { buildLogEntry, type EntryDraft } from "./build-log-entry.js";
import type { LineStart, LogEntry, ParseResult } from "./log-entry-types.js";
import { ALL_REDACTION_KINDS, type RedactionKind } from "../redaction/redaction-kinds.js";

const CONTINUATION_LINE = /^(?:\s|[\w$.]*(?:Error|Exception)(?::|$)|Caused by:)/;

export function assembleLogEntries(
  lines: string[],
  readLineStart: (line: string) => LineStart,
  redactionKinds: readonly RedactionKind[] = ALL_REDACTION_KINDS,
): ParseResult {
  const entries: LogEntry[] = [];
  let skipped = 0;
  let currentEntry: EntryDraft | "ignored" | null = null;

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") continue;

    let lineStart: LineStart;
    try {
      lineStart = readLineStart(line);
    } catch {
      lineStart = { kind: "bad" };
    }

    if (lineStart.kind === "none") {
      if (currentEntry === null || !CONTINUATION_LINE.test(line)) skipped++;
      else if (currentEntry !== "ignored") currentEntry.continuationLines.push(line);
      continue;
    }

    if (currentEntry !== null && currentEntry !== "ignored") entries.push(buildLogEntry(currentEntry, redactionKinds));
    if (lineStart.kind === "entry") {
      currentEntry = {
        timestamp: lineStart.timestamp,
        level: lineStart.level,
        message: lineStart.message,
        continuationLines: lineStart.stack ? lineStart.stack.split("\n") : [],
      };
    } else {
      if (lineStart.kind === "bad") skipped++;
      currentEntry = "ignored";
    }
  }
  if (currentEntry !== null && currentEntry !== "ignored") entries.push(buildLogEntry(currentEntry, redactionKinds));
  return { entries, skipped };
}
